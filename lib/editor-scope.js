// Editor authorisation, shared by every editor-facing router.
//
// Extracted from routes/editorial.js when a second editor router (production
// and issues) appeared. Two copies of an access check is how one of them
// quietly stops matching the other, and the thing being checked here is
// whether a section editor can reach another journal's confidential
// submissions.

const {
  STAGES,
  STAGE_LABELS,
  ROLES,
  hasRole,
  isManagingEditor,
  canEditJournal,
  editableJournals,
} = require('./workflow');
const { JOURNAL_CODES } = require('./journals');
const { EDITOR_EMAILS } = require('../config');
const { getSubmissionById } = require('../db');

// Signed in, and holding either editor or managing-editor. Mount after
// requireAuth.
function requireEditor(req, res, next) {
  if (hasRole(req.user, ROLES.EDITOR) || isManagingEditor(req.user, EDITOR_EMAILS)) return next();
  return res.status(403).json({ error: 'You do not have permission to do that.' });
}

function myJournals(req) {
  return editableJournals(req.user, JOURNAL_CODES, EDITOR_EMAILS);
}

function mayEdit(req, journalCode) {
  return canEditJournal(req.user, journalCode, EDITOR_EMAILS);
}

function iAmManagingEditor(req) {
  return isManagingEditor(req.user, EDITOR_EMAILS);
}

// Loads a submission and refuses it if it belongs to a journal this editor
// doesn't cover. Returns null having already responded.
//
// Deliberately 404 rather than 403: telling someone "this exists but isn't
// yours" leaks that a submission exists at all, and submission titles are
// confidential before publication.
async function loadInScope(req, res, id) {
  const submission = await getSubmissionById(id);
  if (!submission) {
    res.status(404).json({ error: 'Submission not found.' });
    return null;
  }
  if (!mayEdit(req, submission.journalCode)) {
    res.status(404).json({ error: 'Submission not found.' });
    return null;
  }
  return submission;
}

// Submissions predate the workflow fields, so normalize on read rather than
// running a migration: anything without a stage is treated as newly
// submitted, which is where it would have been anyway. The production fields
// are defaulted the same way for the same reason.
function withWorkflowDefaults(submission) {
  if (!submission) return null;
  return Object.assign(
    {
      stage: STAGES.SUBMISSION,
      currentRound: 0,
      editorId: null,
      decisions: [],
      stageFiles: [],
      galleys: [],
      issueId: '',
      pages: '',
      doi: '',
      license: '',
    },
    submission
  );
}

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage;
}

module.exports = {
  requireEditor,
  myJournals,
  mayEdit,
  iAmManagingEditor,
  loadInScope,
  withWorkflowDefaults,
  stageLabel,
};
