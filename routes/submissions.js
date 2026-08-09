const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const {
  createSubmission,
  getSubmissionsByUser,
  getSubmissionById,
  updateSubmission,
  getAssignmentsForSubmission,
} = require('../db');
const { requireAuth } = require('../middleware/auth');
const { JOURNALS } = require('./auth');
const {
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  MAX_SUPPLEMENTARY,
  uploadBufferedFile,
  streamDownload,
} = require('../lib/files');
const {
  STAGES,
  authorViewOfReview,
  FILE_KINDS_BY_KEY,
  fileKindsForStage,
  canUploadFile,
  authorVisibleFiles,
} = require('../lib/workflow');
const notifications = require('../lib/notifications');

const router = express.Router();

const ARTICLE_TYPES = new Set([
  'Original Research Article',
  'Review Article',
  'Short Communication',
  'Case Report',
  'Systematic Review / Meta-Analysis',
  'Editorial / Perspective',
  'Letter to the Editor',
  'Technical Note / Protocol',
  'Data Paper',
  'Other',
]);

// Files are buffered in memory, then uploaded to Cloud Storage (see
// lib/files.js) -- Cloud Run's local filesystem is ephemeral, so
// writing to disk here (the old approach) would lose every file on redeploy,
// scale-to-zero, or when a request lands on a different instance.
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

const uploadFields = upload.fields([
  { name: 'manuscript', maxCount: 1 },
  { name: 'supplementary', maxCount: MAX_SUPPLEMENTARY },
]);

function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed;
  } catch (err) {
    return fallback;
  }
}

function cleanPerson(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim();
  if (!name) return null;
  return {
    name,
    email,
    affiliation: String(p.affiliation || '').trim(),
  };
}

router.post('/', requireAuth, (req, res, next) => {
  uploadFields(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
    }

    try {
    const body = req.body || {};
    const {
      journalCode,
      articleType,
      subjectArea,
      title,
      abstract,
      keywords,
      coverLetter,
    } = body;

    // --- Journal & type ---
    if (!journalCode || !JOURNALS[journalCode]) {
      return res.status(400).json({ error: 'Please select a valid journal.' });
    }
    if (!articleType || !ARTICLE_TYPES.has(articleType)) {
      return res.status(400).json({ error: 'Please select a valid article type.' });
    }

    // --- Manuscript details ---
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Manuscript title is required.' });
    }
    if (!abstract || String(abstract).trim().length < 50) {
      return res.status(400).json({ error: 'Abstract must be at least 50 characters.' });
    }

    // --- Authors ---
    const correspondingAuthor = cleanPerson(safeParseJSON(body.correspondingAuthor, null));
    if (!correspondingAuthor || !correspondingAuthor.email) {
      return res.status(400).json({ error: 'Corresponding author name and email are required.' });
    }
    const coAuthorsRaw = safeParseJSON(body.coAuthorsList, []);
    const coAuthorsList = Array.isArray(coAuthorsRaw)
      ? coAuthorsRaw.map(cleanPerson).filter(Boolean)
      : [];

    // --- Suggested reviewers (optional) ---
    const reviewersRaw = safeParseJSON(body.suggestedReviewers, []);
    const suggestedReviewers = Array.isArray(reviewersRaw)
      ? reviewersRaw.map(cleanPerson).filter(Boolean)
      : [];

    // --- Declarations ---
    const declarationsRaw = safeParseJSON(body.declarations, {});
    const declarations = {
      originality: declarationsRaw.originality === true,
      ethicsCompliance: declarationsRaw.ethicsCompliance === true,
      ethicsApprovalDetails: String(declarationsRaw.ethicsApprovalDetails || '').trim(),
      conflictOfInterest: String(declarationsRaw.conflictOfInterest || 'The authors declare no conflict of interest.').trim(),
    };
    if (!declarations.originality) {
      return res.status(400).json({ error: 'You must confirm this manuscript is original and not under consideration elsewhere.' });
    }
    if (!declarations.ethicsCompliance) {
      return res.status(400).json({ error: 'You must confirm compliance with the journal’s publication ethics policy.' });
    }

    // --- Files ---
    const manuscriptFile = req.files && req.files.manuscript && req.files.manuscript[0];
    if (!manuscriptFile) {
      return res.status(400).json({ error: 'A manuscript file (PDF or Word) is required.' });
    }
    const supplementaryFileList = (req.files && req.files.supplementary) || [];

    const submissionId = uuidv4();
    const manuscript = await uploadBufferedFile(manuscriptFile, `submissions/${submissionId}`);
    const supplementaryFiles = [];
    for (const f of supplementaryFileList) {
      supplementaryFiles.push(await uploadBufferedFile(f, `submissions/${submissionId}`));
    }

    const now = new Date().toISOString();
    const submission = {
      id: submissionId,
      userId: req.user.id,
      journalCode,
      journalName: JOURNALS[journalCode],
      articleType,
      subjectArea: subjectArea ? String(subjectArea).trim() : '',
      title: String(title).trim(),
      abstract: String(abstract).trim(),
      keywords: keywords ? String(keywords).trim() : '',
      correspondingAuthor,
      coAuthorsList,
      coverLetter: coverLetter ? String(coverLetter).trim() : '',
      suggestedReviewers,
      declarations,
      manuscript,
      supplementaryFiles,
      status: 'Submitted',
      // Editorial workflow state (see lib/workflow.js). A new manuscript
      // lands at the Submission stage awaiting editorial screening; no review
      // round exists until an editor sends it to review.
      stage: STAGES.SUBMISSION,
      currentRound: 0,
      editorId: null,
      awaitingRevision: false,
      decisions: [],
      revisions: [],
      statusHistory: [{ status: 'Submitted', note: 'Manuscript received by the editorial office.', at: now }],
      submittedAt: now,
    };
    await createSubmission(submission);
    res.status(201).json({ submission });

    // Receipt to the author, heads-up to the editors. After the response --
    // a mail failure must never make a successful submission look failed.
    notifications
      .submissionReceived({ submission, author: req.user })
      .then((stubs) =>
        stubs && stubs.length ? updateSubmission(submission.id, { notifications: stubs }) : null
      )
      .catch((e) => console.error('[submissions] could not record notification log:', e && e.message));
    } catch (err) {
      next(err);
    }
  });
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json({ submissions: await getSubmissionsByUser(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission || submission.userId !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    // Completed reviews, filtered to what an author may see: the
    // recommendation and the comments written for them. Reviewer identity and
    // the confidential comments-to-editor are stripped by authorViewOfReview.
    const assignments = await getAssignmentsForSubmission(submission.id);
    const reviews = assignments.map(authorViewOfReview).filter(Boolean);

    res.json({ submission, reviews });
  } catch (err) {
    next(err);
  }
});

// Upload a revised manuscript. Only open when an editor has actually asked
// for revisions -- otherwise authors could quietly swap the file mid-review.
router.post('/:id/revision', requireAuth, (req, res, next) => {
  upload.single('manuscript')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
    }
    try {
      const submission = await getSubmissionById(req.params.id);
      if (!submission || submission.userId !== req.user.id) {
        return res.status(404).json({ error: 'Submission not found.' });
      }
      if (!submission.awaitingRevision) {
        return res.status(409).json({
          error: 'No revision has been requested for this submission.',
        });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'A revised manuscript file is required.' });
      }

      const round = submission.currentRound || 1;
      const file = await uploadBufferedFile(req.file, `submissions/${submission.id}/revisions`);
      const now = new Date().toISOString();
      const note = String((req.body && req.body.note) || '').trim();

      const updated = await updateSubmission(submission.id, {
        revisions: (submission.revisions || []).concat({
          round,
          file,
          note,
          uploadedAt: now,
        }),
        awaitingRevision: false,
        status: 'Revision Submitted',
        statusHistory: (submission.statusHistory || []).concat({
          status: 'Revision Submitted',
          note: `Revised manuscript uploaded for round ${round}.`,
          at: now,
        }),
      });

      res.status(201).json({ submission: updated });

      // Receipt to the author, and a nudge to the editors -- without the
      // latter, a requested revision lands silently and the submission waits
      // on an editor who has no idea it is their turn.
      notifications
        .revisionSubmitted({ submission: updated, author: req.user, round, note })
        .then((stubs) =>
          stubs && stubs.length
            ? updateSubmission(submission.id, {
                notifications: (submission.notifications || []).concat(stubs),
              })
            : null
        )
        .catch((e) => console.error('[submissions] revision notification failed:', e && e.message));
    } catch (err) {
      next(err);
    }
  });
});

// ---- Copyediting and proofing, from the author's side ----
//
// After acceptance the exchange stops being "upload a revision" and becomes a
// file conversation: the editor sends a copyedited draft or a proof, the
// author answers it. The author sees only the kinds marked authorVisible in
// lib/workflow.js -- an editor's internal working file is on the same record
// and must never appear here.

router.get('/:id/workflow-files', requireAuth, async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission || submission.userId !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    const files = authorVisibleFiles(submission.stageFiles || []);
    res.json({
      files,
      stage: submission.stage || STAGES.SUBMISSION,
      // What the author may send back right now. Empty outside copyediting
      // and production, which is how the UI knows to show nothing rather than
      // an upload box that would be refused.
      uploadableKinds: fileKindsForStage(submission.stage, 'author')
        .filter((k) => canUploadFile(submission.stage, k.key, 'author'))
        .map((k) => ({ key: k.key, label: k.label, hint: k.hint })),
      awaitingYou: files.filter((f) => f.needsAuthorAction && !f.answeredAt).length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/workflow-files', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
    }
    try {
      const submission = await getSubmissionById(req.params.id);
      if (!submission || submission.userId !== req.user.id) {
        return res.status(404).json({ error: 'Submission not found.' });
      }

      const kindKey = String((req.body || {}).kind || '');
      const kind = FILE_KINDS_BY_KEY[kindKey];
      if (!kind) {
        return res.status(400).json({ error: 'Unknown file type.' });
      }
      if (!canUploadFile(submission.stage, kindKey, 'author')) {
        return res.status(409).json({
          error: 'The editorial office is not expecting this kind of file at the moment.',
        });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Choose a file to upload.' });
      }

      const stored = await uploadBufferedFile(req.file, `submissions/${submission.id}/${kind.stage}`);
      const now = new Date().toISOString();
      const existing = submission.stageFiles || [];
      const entry = {
        id: uuidv4(),
        kind: kind.key,
        stage: kind.stage,
        round: existing.filter((f) => f.kind === kind.key).length + 1,
        file: stored,
        note: String((req.body || {}).note || '').trim(),
        uploadedById: req.user.id,
        uploadedByName: req.user.name,
        uploadedByRole: 'author',
        uploadedAt: now,
        needsAuthorAction: false,
        answeredAt: '',
      };

      // Answering clears the outstanding request. Without this the author's
      // dashboard keeps saying "action needed" after they have acted, which
      // is the fastest way to teach someone to ignore the flag.
      const cleared = existing.map((f) =>
        f.needsAuthorAction && !f.answeredAt && f.stage === kind.stage
          ? Object.assign({}, f, { answeredAt: now })
          : f
      );

      const updated = await updateSubmission(submission.id, {
        stageFiles: cleared.concat(entry),
      });

      res.status(201).json({
        file: authorVisibleFiles([entry])[0],
        files: authorVisibleFiles((updated && updated.stageFiles) || cleared.concat(entry)),
      });

      notifications
        .authorFileUploaded({ submission: updated || submission, author: req.user, entry })
        .catch((e) => console.error('[submissions] author file notification failed:', e && e.message));
    } catch (err) {
      next(err);
    }
  });
});

router.get('/:id/workflow-files/:fileId', requireAuth, async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission || submission.userId !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    const entry = (submission.stageFiles || []).find((f) => f.id === req.params.fileId);
    const kind = entry ? FILE_KINDS_BY_KEY[entry.kind] : null;
    // The visibility check is repeated here rather than trusted from the
    // listing route: a file id is guessable enough that "we only listed the
    // visible ones" is not an access control.
    if (!entry || !entry.file || !kind || !kind.authorVisible) {
      return res.status(404).json({ error: 'File not found.' });
    }
    streamDownload(res, entry.file.storedFileName, entry.file.fileName, next);
  } catch (err) {
    next(err);
  }
});

// Download one of the author's own revision files.
router.get('/:id/revision/:index', requireAuth, async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission || submission.userId !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    const rev = (submission.revisions || [])[parseInt(req.params.index, 10)];
    if (!rev || !rev.file) {
      return res.status(404).json({ error: 'Revision not found.' });
    }
    streamDownload(res, rev.file.storedFileName, rev.file.fileName, next);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/file', requireAuth, async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission || submission.userId !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    streamDownload(res,submission.manuscript.storedFileName, submission.manuscript.fileName, next);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/supplementary/:index', requireAuth, async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission || submission.userId !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    const idx = parseInt(req.params.index, 10);
    const file = (submission.supplementaryFiles || [])[idx];
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }
    streamDownload(res,file.storedFileName, file.fileName, next);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.ARTICLE_TYPES = ARTICLE_TYPES;
