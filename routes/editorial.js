// Editor-facing API. Every route here is editor-only.
//
// Mirrors the OJS editorial workflow: an editor screens new submissions,
// sends them to review, invites reviewers for the current round, reads the
// returned reviews, and records a decision that moves the submission to the
// next stage.

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const {
  getSubmissionsForEditor,
  getSubmissionById,
  updateSubmission,
  findUserById,
  findUsersByRole,
  getUsers,
  updateUser,
  createReviewAssignment,
  getReviewAssignmentById,
  updateReviewAssignment,
  getAssignmentsForSubmission,
  getIssueById,
} = require('../db');
const { requireAuth, requireRole, publicUser } = require('../middleware/auth');
const { streamDownload } = require('../lib/files');
const notifications = require('../lib/notifications');
const { JOURNALS } = require('./auth');
const {
  STAGES,
  STAGE_LABELS,
  DECISIONS_BY_KEY,
  availableDecisions,
  isDecisionAllowed,
  ASSIGNMENT_STATUS,
  ASSIGNMENT_STATUS_LABELS,
  RECOMMENDATIONS,
  ROLES,
  ASSIGNABLE_ROLES,
  JOURNAL_SCOPED_ROLES,
  userRoles,
  hasRole,
  isManagingEditor,
  canEditJournal,
  canReviewJournal,
  editableJournals,
  journalsForRole,
  sanitiseJournals,
  publishBlockers,
} = require('../lib/workflow');
const { issueLabel } = require('../lib/issues');
const { EDITOR_EMAILS } = require('../config');

const router = express.Router();

const ALL_JOURNAL_CODES = Object.keys(JOURNALS);

// ---- Journal scoping ----
//
// A section editor may only act on their own journals. Enforced server-side
// rather than in the UI, because hiding a button is not access control. The
// implementation is shared with routes/production.js -- see
// lib/editor-scope.js for why it isn't defined twice.
const {
  requireEditor,
  myJournals,
  mayEdit,
  loadInScope,
  withWorkflowDefaults,
  stageLabel,
} = require('../lib/editor-scope');

router.use(requireAuth, requireEditor);

// Appends the outcome of a notification dispatch to a record's log, so an
// editor can see who was emailed and whether it actually went out. Runs after
// the HTTP response and swallows its own errors -- a failure to WRITE the log
// must not be louder than the failure to send the email.
function logNotifications(pending, save) {
  pending
    .then((stubs) => {
      if (!stubs || !stubs.length) return null;
      return save(stubs);
    })
    .catch((err) => console.error('[editorial] could not record notification log:', err && err.message));
}

// ---- Queue ----

router.get('/submissions', async (req, res, next) => {
  try {
    const stage = req.query.stage || null;
    if (stage && !STAGE_LABELS[stage]) {
      return res.status(400).json({ error: 'Unknown stage.' });
    }
    const raw = await getSubmissionsForEditor(stage);
    // When filtering by "submission", also catch legacy records that have no
    // stage field at all -- getSubmissionsForEditor's where() can't see them.
    let list = raw;
    if (stage === STAGES.SUBMISSION) {
      const all = await getSubmissionsForEditor(null);
      list = all.filter((s) => !s.stage || s.stage === STAGES.SUBMISSION);
    }

    // Scope: a section editor sees only their journals.
    list = list.filter((s) => mayEdit(req, s.journalCode));

    const submissions = list.map(withWorkflowDefaults).map((s) => ({
      id: s.id,
      title: s.title,
      journalCode: s.journalCode,
      journalName: s.journalName,
      articleType: s.articleType,
      stage: s.stage,
      stageLabel: stageLabel(s.stage),
      status: s.status,
      currentRound: s.currentRound,
      submittedAt: s.submittedAt,
    }));
    res.json({ submissions });
  } catch (err) {
    next(err);
  }
});

// Counts per stage, for the dashboard's tab badges.
router.get('/stats', async (req, res, next) => {
  try {
    const all = (await getSubmissionsForEditor(null))
      .filter((s) => mayEdit(req, s.journalCode))
      .map(withWorkflowDefaults);
    const counts = {};
    Object.keys(STAGE_LABELS).forEach((k) => {
      counts[k] = 0;
    });
    all.forEach((s) => {
      counts[s.stage] = (counts[s.stage] || 0) + 1;
    });
    res.json({
      counts,
      total: all.length,
      // The dashboard uses these to show what this editor covers.
      journals: myJournals(req),
      managingEditor: isManagingEditor(req.user, EDITOR_EMAILS),
    });
  } catch (err) {
    next(err);
  }
});

// ---- One submission, with its reviews ----

router.get('/submissions/:id', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);

    const assignments = await getAssignmentsForSubmission(submission.id);
    // The editor is the one party who sees reviewer identities -- that's what
    // makes double-anonymous review workable.
    const reviews = await Promise.all(
      assignments.map(async (a) => {
        const reviewer = await findUserById(a.reviewerId);
        return {
          id: a.id,
          round: a.round,
          status: a.status,
          statusLabel: ASSIGNMENT_STATUS_LABELS[a.status] || a.status,
          reviewerId: a.reviewerId,
          reviewerName: reviewer ? reviewer.name : '(deleted account)',
          reviewerEmail: reviewer ? reviewer.email : '',
          reviewerAffiliation: reviewer ? reviewer.affiliation : '',
          dueDate: a.dueDate || '',
          assignedAt: a.assignedAt,
          respondedAt: a.respondedAt || '',
          completedAt: a.completedAt || '',
          declineReason: a.declineReason || '',
          recommendation: a.recommendation || '',
          recommendationLabel: a.recommendation ? RECOMMENDATIONS[a.recommendation] : '',
          commentsForEditor: a.commentsForEditor || '',
          commentsForAuthor: a.commentsForAuthor || '',
          reviewFile: a.reviewFile || null,
          notifications: a.notifications || [],
        };
      })
    );

    const author = await findUserById(submission.userId);
    const issue = submission.issueId ? await getIssueById(submission.issueId) : null;

    res.json({
      submission: Object.assign({}, submission, {
        stageLabel: stageLabel(submission.stage),
        authorAccount: author
          ? { id: author.id, name: author.name, email: author.email, affiliation: author.affiliation }
          : null,
      }),
      reviews,
      availableDecisions: availableDecisions(submission.stage).map((d) => ({
        key: d.key,
        label: d.label,
      })),
      // Shown next to the Publish button so an editor learns what is missing
      // before clicking it, rather than from a 409.
      issue: issue ? { id: issue.id, label: issueLabel(issue), status: issue.status } : null,
      publishBlockers: publishBlockers(submission, submission.galleys || [], issue),
    });
  } catch (err) {
    next(err);
  }
});

// ---- Reviewer assignment ----

// Candidate reviewers, annotated with whether they're already on this
// submission (any round) so the editor doesn't double-invite.
router.get('/submissions/:id/reviewer-candidates', async (req, res, next) => {
  try {
    const submission = await loadInScope(req, res, req.params.id);
    if (!submission) return;

    const [reviewers, assignments] = await Promise.all([
      findUsersByRole(ROLES.REVIEWER),
      getAssignmentsForSubmission(req.params.id),
    ]);
    const assignedIds = new Set(
      assignments
        .filter((a) => a.status !== ASSIGNMENT_STATUS.CANCELLED)
        .map((a) => a.reviewerId)
    );
    const candidates = reviewers
      // Only reviewers who actually cover this journal. Offering someone who
      // reviews for a different journal is how you end up with a materials
      // scientist reviewing a management paper.
      .filter((r) => canReviewJournal(r, submission.journalCode))
      .filter((r) => r.id !== submission.userId) // never let an author review their own paper
      .map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        affiliation: r.affiliation,
        alreadyAssigned: assignedIds.has(r.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ candidates });
  } catch (err) {
    next(err);
  }
});

router.post('/submissions/:id/reviewers', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);
    if (submission.stage !== STAGES.REVIEW) {
      return res.status(409).json({
        error: 'Reviewers can only be invited while the submission is in the Review stage. Use "Send to Review" first.',
      });
    }

    const { reviewerId, dueDate } = req.body || {};
    const reviewer = await findUserById(reviewerId);
    if (!reviewer) {
      return res.status(400).json({ error: 'Reviewer account not found.' });
    }
    if (!userRoles(reviewer).includes(ROLES.REVIEWER)) {
      return res.status(400).json({ error: 'That user does not hold the reviewer role.' });
    }
    if (!canReviewJournal(reviewer, submission.journalCode)) {
      return res.status(400).json({
        error: `${reviewer.name} is not registered as a reviewer for ${submission.journalName}. Add that journal to their reviewer role first.`,
      });
    }
    if (reviewer.id === submission.userId) {
      return res.status(400).json({ error: 'An author cannot review their own submission.' });
    }

    const round = submission.currentRound || 1;
    const existing = await getAssignmentsForSubmission(submission.id);
    const duplicate = existing.find(
      (a) =>
        a.reviewerId === reviewer.id &&
        a.round === round &&
        a.status !== ASSIGNMENT_STATUS.CANCELLED
    );
    if (duplicate) {
      return res.status(409).json({ error: 'That reviewer is already invited for this round.' });
    }

    const assignment = {
      id: uuidv4(),
      submissionId: submission.id,
      round,
      reviewerId: reviewer.id,
      status: ASSIGNMENT_STATUS.PENDING,
      dueDate: dueDate ? String(dueDate) : '',
      assignedAt: new Date().toISOString(),
      assignedByEditorId: req.user.id,
      respondedAt: '',
      completedAt: '',
      recommendation: '',
      commentsForAuthor: '',
      commentsForEditor: '',
      declineReason: '',
      reviewFile: null,
    };
    await createReviewAssignment(assignment);

    res.status(201).json({ assignment });

    // Invitation email goes out after the response -- a SendGrid outage must
    // not stop the assignment from being created.
    logNotifications(
      notifications.reviewerInvited({ submission, reviewer, assignment }),
      (stubs) => updateReviewAssignment(assignment.id, { notifications: stubs })
    );
  } catch (err) {
    next(err);
  }
});

// Withdraw an invitation. Kept as a status change rather than a delete so the
// editorial record of who was approached stays intact.
router.post('/assignments/:assignmentId/cancel', async (req, res, next) => {
  try {
    const assignment = await getReviewAssignmentById(req.params.assignmentId);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }
    // Scope via the parent submission -- an assignment id alone must not be
    // a way around the journal check.
    if (!(await loadInScope(req, res, assignment.submissionId))) return;
    if (assignment.status === ASSIGNMENT_STATUS.COMPLETED) {
      return res.status(409).json({ error: 'That review has already been submitted and cannot be withdrawn.' });
    }
    const updated = await updateReviewAssignment(assignment.id, {
      status: ASSIGNMENT_STATUS.CANCELLED,
      cancelledAt: new Date().toISOString(),
    });
    res.json({ assignment: updated });

    const [submission, reviewer] = await Promise.all([
      getSubmissionById(assignment.submissionId),
      findUserById(assignment.reviewerId),
    ]);
    if (submission) {
      logNotifications(
        notifications.invitationWithdrawn({ submission, reviewer }),
        (stubs) =>
          updateReviewAssignment(assignment.id, {
            notifications: (updated.notifications || []).concat(stubs),
          })
      );
    }
  } catch (err) {
    next(err);
  }
});

// ---- Editorial decisions ----

router.post('/submissions/:id/decision', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);

    const { decision: decisionKey, note } = req.body || {};
    const decision = DECISIONS_BY_KEY[decisionKey];
    if (!decision) {
      return res.status(400).json({ error: 'Unknown decision.' });
    }
    if (!isDecisionAllowed(decisionKey, submission.stage)) {
      return res.status(409).json({
        error: `"${decision.label}" is not available while the submission is at the ${stageLabel(submission.stage)} stage.`,
      });
    }

    // Guard rail: don't let an editor accept or decline on the strength of
    // reviews that haven't come back yet. Advisory -- they can still do it,
    // but they have to acknowledge it by passing force.
    const assignments = await getAssignmentsForSubmission(submission.id);
    const thisRound = assignments.filter(
      (a) => a.round === submission.currentRound && a.status !== ASSIGNMENT_STATUS.CANCELLED
    );
    const outstanding = thisRound.filter(
      (a) => a.status === ASSIGNMENT_STATUS.PENDING || a.status === ASSIGNMENT_STATUS.ACCEPTED
    );
    const isReviewOutcome = ['accept', 'decline', 'request_revisions', 'resubmit_for_review'].includes(
      decision.key
    );
    if (
      submission.stage === STAGES.REVIEW &&
      isReviewOutcome &&
      outstanding.length &&
      !req.body.force
    ) {
      return res.status(409).json({
        error: `${outstanding.length} review(s) for round ${submission.currentRound} are still outstanding.`,
        code: 'REVIEWS_OUTSTANDING',
        outstanding: outstanding.length,
      });
    }

    // Publication gate. Unlike the outstanding-reviews warning above, this
    // one has no `force`: every blocker it reports would produce a public
    // article page that is broken rather than merely early -- a "read the
    // article" link with no galley behind it, or a citation with no volume.
    // Forcing past it would put the damage on the public site, where the
    // editor cannot see it and the reader can.
    if (decision.key === 'publish') {
      const issue = submission.issueId ? await getIssueById(submission.issueId) : null;
      const blockers = publishBlockers(submission, submission.galleys || [], issue);
      if (blockers.length) {
        return res.status(409).json({
          error: 'This article is not ready to publish.',
          code: 'NOT_READY_TO_PUBLISH',
          blockers,
        });
      }
    }

    const now = new Date().toISOString();
    const noteText = String(note || '').trim();
    const record = {
      decision: decision.key,
      decisionLabel: decision.label,
      fromStage: submission.stage,
      toStage: decision.to,
      round: submission.currentRound,
      editorId: req.user.id,
      editorName: req.user.name,
      note: noteText,
      at: now,
    };

    const patch = {
      stage: decision.to,
      status: decision.status,
      editorId: submission.editorId || req.user.id,
      decisions: (submission.decisions || []).concat(record),
      statusHistory: (submission.statusHistory || []).concat({
        status: decision.status,
        // The author sees this note, so use the editor's wording when given.
        note: noteText || decision.note,
        at: now,
      }),
      lastDecisionAt: now,
    };

    if (decision.startsRound) {
      patch.currentRound = (submission.currentRound || 0) + 1;
    }
    // Stamped once, on the decision that publishes. Re-publishing after a
    // correction must not silently re-date the article -- a changed
    // publication date breaks every citation already made to it.
    if (decision.to === STAGES.PUBLISHED && !submission.publishedAt) {
      patch.publishedAt = now;
    }
    // When revisions are requested the author needs an upload slot again.
    patch.awaitingRevision = Boolean(decision.requestsRevisions);

    const updated = await updateSubmission(submission.id, patch);
    res.json({ submission: updated, decision: record });

    // Tell the author. Reviewer comments are attached only for decisions that
    // actually communicate a review outcome, and only ever in their
    // anonymized form -- see lib/notifications.js.
    const author = await findUserById(submission.userId);
    logNotifications(
      notifications.decisionRecorded({
        submission: updated,
        author,
        decision: record,
        assignments,
      }),
      (stubs) =>
        updateSubmission(submission.id, {
          notifications: (submission.notifications || []).concat(stubs),
        })
    );

    // Close the loop for the reviewers. Someone who spent hours on a review
    // should learn the outcome -- it's basic courtesy, and it materially
    // affects whether they agree to review again.
    //
    // Only for decisions that actually conclude something; nobody needs an
    // email because a manuscript moved from copyediting to production.
    const REVIEW_OUTCOMES = new Set(['accept', 'decline', 'request_revisions', 'resubmit_for_review']);
    if (REVIEW_OUTCOMES.has(record.decision)) {
      const reviewers = {};
      for (const a of assignments) {
        if (a.status === ASSIGNMENT_STATUS.COMPLETED && !reviewers[a.reviewerId]) {
          reviewers[a.reviewerId] = await findUserById(a.reviewerId);
        }
      }
      notifications.decisionToReviewers({
        submission: updated,
        decision: record,
        assignments,
        reviewers,
      });
    }
  } catch (err) {
    next(err);
  }
});

// ---- Files (editors see everything, under real filenames) ----

router.get('/submissions/:id/file', async (req, res, next) => {
  try {
    const submission = await loadInScope(req, res, req.params.id);
    if (!submission) return;
    if (!submission.manuscript) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    streamDownload(res, submission.manuscript.storedFileName, submission.manuscript.fileName, next);
  } catch (err) {
    next(err);
  }
});

router.get('/submissions/:id/supplementary/:index', async (req, res, next) => {
  try {
    const submission = await loadInScope(req, res, req.params.id);
    if (!submission) return;
    const file = (submission.supplementaryFiles || [])[parseInt(req.params.index, 10)];
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }
    streamDownload(res, file.storedFileName, file.fileName, next);
  } catch (err) {
    next(err);
  }
});

router.get('/submissions/:id/revision/:index', async (req, res, next) => {
  try {
    const submission = await loadInScope(req, res, req.params.id);
    if (!submission) return;
    const rev = (submission.revisions || [])[parseInt(req.params.index, 10)];
    if (!rev || !rev.file) {
      return res.status(404).json({ error: 'Revision not found.' });
    }
    streamDownload(res, rev.file.storedFileName, rev.file.fileName, next);
  } catch (err) {
    next(err);
  }
});

// A file the reviewer attached to their review.
router.get('/assignments/:assignmentId/file', async (req, res, next) => {
  try {
    const assignment = await getReviewAssignmentById(req.params.assignmentId);
    if (!assignment || !assignment.reviewFile) {
      return res.status(404).json({ error: 'File not found.' });
    }
    if (!(await loadInScope(req, res, assignment.submissionId))) return;
    streamDownload(res, assignment.reviewFile.storedFileName, assignment.reviewFile.fileName, next);
  } catch (err) {
    next(err);
  }
});

// ---- Welcome-email backfill ----
//
// Accounts created before the welcome email existed never received one. This
// sends it to them once.
//
// Idempotent by design: every user who has been welcomed carries a
// `welcomeEmailSentAt` timestamp, and this route skips anyone who has one.
// Running it twice cannot double-mail a person -- which matters, because the
// recipients are real authors, not test data.
//
// GET  reports who would be emailed, and sends nothing.
// POST actually sends.

async function usersAwaitingWelcome() {
  const users = await getUsers();
  return users.filter((u) => u.email && !u.welcomeEmailSentAt);
}

router.get('/backfill-welcome', async (_req, res, next) => {
  try {
    const pending = await usersAwaitingWelcome();
    res.json({
      pending: pending.length,
      recipients: pending.map((u) => ({ name: u.name, email: u.email, createdAt: u.createdAt })),
      note: 'This is a dry run. POST to the same path to send.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/backfill-welcome', async (req, res, next) => {
  try {
    const pending = await usersAwaitingWelcome();
    if (!pending.length) {
      return res.json({ sent: 0, results: [], note: 'Everyone has already been welcomed.' });
    }

    const results = [];
    for (const user of pending) {
      const stubs = await notifications.accountCreated({ user, journals: JOURNALS });
      const stub = (stubs && stubs[0]) || { status: 'unknown' };

      // Only mark as welcomed if the message actually got out. A failed send
      // means this person received nothing, so they must stay in the pending
      // list for a retry once the underlying problem is fixed.
      //
      // ("logged" counts as done: that's the local/dev mode where mail is
      // deliberately not configured, and re-running there is pointless.)
      if (stub.status === 'sent' || stub.status === 'logged') {
        await updateUser(user.id, { welcomeEmailSentAt: new Date().toISOString() });
      }

      results.push({
        email: user.email,
        name: user.name,
        status: stub.status,
        error: stub.error || '',
      });
    }

    res.json({
      sent: results.filter((r) => r.status === 'sent').length,
      attempted: results.length,
      results,
    });
  } catch (err) {
    next(err);
  }
});

// ---- People / roles ----

router.get('/users', async (req, res, next) => {
  try {
    const users = await getUsers();
    res.json({
      users: users
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          affiliation: u.affiliation,
          country: u.country,
          orcid: u.orcid,
          roles: userRoles(u),
          journalRoles: {
            reviewer: journalsForRole(u, ROLES.REVIEWER),
            editor: journalsForRole(u, ROLES.EDITOR),
          },
          managingEditor: isManagingEditor(u, EDITOR_EMAILS),
          createdAt: u.createdAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // What the caller may hand out, so the UI can render accordingly.
      journals: JOURNALS,
      myJournals: myJournals(req),
      iAmManagingEditor: isManagingEditor(req.user, EDITOR_EMAILS),
    });
  } catch (err) {
    next(err);
  }
});

// Grant or revoke reviewer/editor. The author role is intrinsic and can't be
// removed; an editor also can't strip their own editor role (which would
// otherwise be an easy way to lock the last editor out of the journal).
router.post('/users/:id/roles', async (req, res, next) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const { role, grant, journals } = req.body || {};
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: 'That role cannot be assigned.' });
    }

    const iAmManaging = isManagingEditor(req.user, EDITOR_EMAILS);

    // Only a managing editor may create editors or other managing editors.
    // A section editor can recruit reviewers for their own journals, which is
    // the day-to-day need, but cannot widen anyone's editorial authority.
    if ((role === ROLES.EDITOR || role === ROLES.MANAGING_EDITOR) && !iAmManaging) {
      return res.status(403).json({
        error: 'Only a managing editor can grant or remove editor roles.',
      });
    }

    // Guard rails against locking the journal out of itself.
    if (target.id === req.user.id && grant === false) {
      if (role === ROLES.EDITOR || role === ROLES.MANAGING_EDITOR) {
        return res.status(400).json({ error: 'You cannot remove your own editor role.' });
      }
    }

    const current = new Set(userRoles(target));
    if (grant === false) current.delete(role);
    else current.add(role);
    current.add(ROLES.AUTHOR);

    const patch = { roles: Array.from(current) };

    // Journal scoping, for the roles that carry it.
    if (JOURNAL_SCOPED_ROLES.includes(role)) {
      const existing = {
        [ROLES.REVIEWER]: journalsForRole(target, ROLES.REVIEWER),
        [ROLES.EDITOR]: journalsForRole(target, ROLES.EDITOR),
      };

      if (grant === false) {
        existing[role] = [];
      } else {
        let requested = sanitiseJournals(journals, ALL_JOURNAL_CODES);

        // A section editor may only hand out journals they themselves cover
        // -- otherwise scoping is trivially escalatable by granting yourself
        // a reviewer a journal you don't run.
        if (!iAmManaging) {
          const mine = myJournals(req);
          requested = requested.filter((c) => mine.includes(c));
        }

        if (!requested.length) {
          return res.status(400).json({
            error: 'Select at least one journal for this role.',
          });
        }
        existing[role] = requested;
      }

      patch.journalRoles = existing;
    }

    const updated = await updateUser(target.id, patch);
    res.json({ user: publicUser(updated) });

    // Only announce a grant, not a revocation -- "you have been removed as a
    // reviewer" is a conversation for a human to have, not an automated mail.
    if (grant !== false) {
      notifications.roleGranted({ user: updated, role });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
