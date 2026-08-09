// Reviewer-facing API. Every route here is reviewer-only, and every response
// is filtered through lib/workflow's reviewerView so a reviewer never sees
// author identity (double-anonymous review).
//
// Lifecycle: invited (pending) -> accepted/declined -> completed.

const express = require('express');
const multer = require('multer');
const path = require('path');

const {
  getReviewAssignmentById,
  updateReviewAssignment,
  getAssignmentsForReviewer,
  getAssignmentsForSubmission,
  getSubmissionById,
} = require('../db');
const notifications = require('../lib/notifications');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  uploadBufferedFile,
  streamDownload,
  anonymousFileName,
} = require('../lib/files');
const {
  ROLES,
  ASSIGNMENT_STATUS,
  ASSIGNMENT_STATUS_LABELS,
  RECOMMENDATIONS,
  reviewerView,
} = require('../lib/workflow');

const router = express.Router();

router.use(requireAuth, requireRole(ROLES.REVIEWER));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('Files must be PDF or Word documents (.pdf, .doc, .docx).'));
    }
    cb(null, true);
  },
});

// Loads an assignment and confirms it belongs to the caller. Returns null
// after having already sent a response when something's wrong.
async function loadOwnAssignment(req, res) {
  const assignment = await getReviewAssignmentById(req.params.assignmentId);
  if (!assignment || assignment.reviewerId !== req.user.id) {
    res.status(404).json({ error: 'Review assignment not found.' });
    return null;
  }
  if (assignment.status === ASSIGNMENT_STATUS.CANCELLED) {
    res.status(409).json({ error: 'This review invitation was withdrawn by the editor.' });
    return null;
  }
  return assignment;
}

// ---- My review queue ----

router.get('/', async (req, res, next) => {
  try {
    const assignments = await getAssignmentsForReviewer(req.user.id);
    const visible = assignments.filter((a) => a.status !== ASSIGNMENT_STATUS.CANCELLED);

    const items = await Promise.all(
      visible.map(async (a) => {
        const submission = await getSubmissionById(a.submissionId);
        const anon = reviewerView(submission);
        return {
          id: a.id,
          status: a.status,
          statusLabel: ASSIGNMENT_STATUS_LABELS[a.status] || a.status,
          round: a.round,
          dueDate: a.dueDate || '',
          assignedAt: a.assignedAt,
          completedAt: a.completedAt || '',
          recommendation: a.recommendation || '',
          recommendationLabel: a.recommendation ? RECOMMENDATIONS[a.recommendation] : '',
          submission: anon
            ? {
                id: anon.id,
                title: anon.title,
                journalName: anon.journalName,
                articleType: anon.articleType,
                subjectArea: anon.subjectArea,
              }
            : null,
        };
      })
    );
    res.json({ assignments: items });
  } catch (err) {
    next(err);
  }
});

// ---- One assignment (the review form's data) ----

router.get('/:assignmentId', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req, res);
    if (!assignment) return;

    const submission = await getSubmissionById(assignment.submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'The submission for this review no longer exists.' });
    }

    res.json({
      assignment: {
        id: assignment.id,
        status: assignment.status,
        statusLabel: ASSIGNMENT_STATUS_LABELS[assignment.status] || assignment.status,
        round: assignment.round,
        dueDate: assignment.dueDate || '',
        assignedAt: assignment.assignedAt,
        completedAt: assignment.completedAt || '',
        recommendation: assignment.recommendation || '',
        commentsForAuthor: assignment.commentsForAuthor || '',
        commentsForEditor: assignment.commentsForEditor || '',
        reviewFile: assignment.reviewFile
          ? { fileName: assignment.reviewFile.fileName, fileSize: assignment.reviewFile.fileSize }
          : null,
      },
      // Anonymized -- no author names, affiliations, cover letter, or
      // suggested reviewers.
      submission: reviewerView(submission),
      recommendations: RECOMMENDATIONS,
      reviewModel: 'double_anonymous',
    });
  } catch (err) {
    next(err);
  }
});

// ---- Accept or decline the invitation ----

router.post('/:assignmentId/respond', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req, res);
    if (!assignment) return;

    if (assignment.status !== ASSIGNMENT_STATUS.PENDING) {
      return res.status(409).json({ error: 'You have already responded to this invitation.' });
    }

    const { accept, reason } = req.body || {};
    if (typeof accept !== 'boolean') {
      return res.status(400).json({ error: 'Please indicate whether you accept the invitation.' });
    }

    const updated = await updateReviewAssignment(assignment.id, {
      status: accept ? ASSIGNMENT_STATUS.ACCEPTED : ASSIGNMENT_STATUS.DECLINED,
      respondedAt: new Date().toISOString(),
      declineReason: accept ? '' : String(reason || '').trim(),
    });

    res.json({
      assignment: {
        id: updated.id,
        status: updated.status,
        statusLabel: ASSIGNMENT_STATUS_LABELS[updated.status],
      },
    });

    // Let the editors know either way -- a decline is the more urgent of the
    // two, since they need to find a replacement.
    const submission = await getSubmissionById(assignment.submissionId);
    if (submission) {
      notifications.invitationAnswered({
        submission,
        reviewer: req.user,
        accepted: accept,
        reason: accept ? '' : String(reason || '').trim(),
      });
    }
  } catch (err) {
    next(err);
  }
});

// ---- Submit the review ----

router.post('/:assignmentId/submit', (req, res, next) => {
  upload.single('reviewFile')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
    }
    try {
      const assignment = await loadOwnAssignment(req, res);
      if (!assignment) return;

      if (assignment.status === ASSIGNMENT_STATUS.COMPLETED) {
        return res.status(409).json({ error: 'You have already submitted this review.' });
      }
      if (assignment.status === ASSIGNMENT_STATUS.DECLINED) {
        return res.status(409).json({ error: 'You declined this review invitation.' });
      }
      if (assignment.status === ASSIGNMENT_STATUS.PENDING) {
        return res.status(409).json({ error: 'Please accept the review invitation before submitting a review.' });
      }

      const { recommendation, commentsForAuthor, commentsForEditor } = req.body || {};
      if (!recommendation || !RECOMMENDATIONS[recommendation]) {
        return res.status(400).json({ error: 'Please choose a recommendation.' });
      }
      const forAuthor = String(commentsForAuthor || '').trim();
      if (forAuthor.length < 50) {
        return res
          .status(400)
          .json({ error: 'Comments for the author must be at least 50 characters.' });
      }

      let reviewFile = assignment.reviewFile || null;
      if (req.file) {
        reviewFile = await uploadBufferedFile(
          req.file,
          `reviews/${assignment.submissionId}/${assignment.id}`
        );
      }

      const updated = await updateReviewAssignment(assignment.id, {
        status: ASSIGNMENT_STATUS.COMPLETED,
        recommendation,
        commentsForAuthor: forAuthor,
        commentsForEditor: String(commentsForEditor || '').trim(),
        reviewFile,
        completedAt: new Date().toISOString(),
      });

      res.json({
        assignment: {
          id: updated.id,
          status: updated.status,
          statusLabel: ASSIGNMENT_STATUS_LABELS[updated.status],
          recommendation: updated.recommendation,
          recommendationLabel: RECOMMENDATIONS[updated.recommendation],
          completedAt: updated.completedAt,
        },
      });

      // Thank the reviewer, and tell the editors -- including how many
      // reviews are still outstanding for this round, which is the number
      // they actually act on.
      const submission = await getSubmissionById(assignment.submissionId);
      if (submission) {
        const siblings = await getAssignmentsForSubmission(assignment.submissionId);
        const outstanding = siblings.filter(
          (a) =>
            a.round === assignment.round &&
            (a.status === ASSIGNMENT_STATUS.PENDING || a.status === ASSIGNMENT_STATUS.ACCEPTED)
        ).length;

        notifications
          .reviewSubmitted({ submission, reviewer: req.user, assignment: updated, outstanding })
          .then((stubs) =>
            stubs && stubs.length
              ? updateReviewAssignment(assignment.id, {
                  notifications: (updated.notifications || []).concat(stubs),
                })
              : null
          )
          .catch((e) => console.error('[reviews] could not record notification log:', e && e.message));
      }
    } catch (err) {
      next(err);
    }
  });
});

// ---- Files ----

// The manuscript, served under a neutral filename. The author's original
// filename frequently contains their surname, which would defeat the point
// of anonymizing the metadata.
router.get('/:assignmentId/file', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req, res);
    if (!assignment) return;
    if (assignment.status === ASSIGNMENT_STATUS.DECLINED) {
      return res.status(403).json({ error: 'You declined this review invitation.' });
    }

    const submission = await getSubmissionById(assignment.submissionId);
    if (!submission || !submission.manuscript) {
      return res.status(404).json({ error: 'Manuscript not found.' });
    }

    // If the author has uploaded revisions, the reviewer for round N should
    // see the file that was current when round N opened -- i.e. the latest
    // revision at or before this round.
    const revisions = (submission.revisions || []).filter((r) => r.round <= assignment.round);
    const latest = revisions.length ? revisions[revisions.length - 1].file : submission.manuscript;

    streamDownload(
      res,
      latest.storedFileName,
      anonymousFileName(latest.fileName, `manuscript-round-${assignment.round}`),
      next
    );
  } catch (err) {
    next(err);
  }
});

router.get('/:assignmentId/supplementary/:index', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req, res);
    if (!assignment) return;
    if (assignment.status === ASSIGNMENT_STATUS.DECLINED) {
      return res.status(403).json({ error: 'You declined this review invitation.' });
    }

    const submission = await getSubmissionById(assignment.submissionId);
    const idx = parseInt(req.params.index, 10);
    const file = (submission && submission.supplementaryFiles) ? submission.supplementaryFiles[idx] : null;
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }
    streamDownload(res, file.storedFileName, anonymousFileName(file.fileName, `supplementary-${idx + 1}`), next);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
