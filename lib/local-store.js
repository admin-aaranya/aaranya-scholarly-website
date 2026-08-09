// Local development datastore -- JSON files on disk under data/.
//
// Implements exactly the same async API as the Firestore layer in db.js, so
// the rest of the app cannot tell which one it's talking to. db.js picks
// between them at boot based on whether GCP credentials are available.
//
// This exists because the app should be runnable on a laptop with nothing
// installed but Node. Requiring a cloud project (or the Firestore emulator,
// and therefore the Java runtime it needs) just to see the site render is a
// bad trade for a small editorial team.
//
// NOT for production: no concurrency control beyond atomic file replacement,
// and it obviously doesn't survive a Cloud Run instance being recycled.

const fs = require('fs');
const path = require('path');

// Resolved in config.js so the DATA_DIR override lands in one place rather
// than three.
const { DATA_DIR } = require('../config');

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  submissions: path.join(DATA_DIR, 'submissions.json'),
  reviewAssignments: path.join(DATA_DIR, 'reviewAssignments.json'),
  issues: path.join(DATA_DIR, 'issues.json'),
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  Object.values(FILES).forEach((f) => {
    if (!fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf8');
  });
}

function readAll(collection) {
  ensureStore();
  try {
    const raw = fs.readFileSync(FILES[collection], 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (err) {
    console.error(`[local-store] could not read ${collection}:`, err.message);
    return [];
  }
}

function writeAll(collection, rows) {
  ensureStore();
  // Write to a temp file then rename, so a crash mid-write can't truncate
  // the real file.
  const target = FILES[collection];
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// Firestore's set({merge:true}) semantics: shallow merge of top-level keys.
function upsert(collection, id, patch, replace) {
  const rows = readAll(collection);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) {
    rows.push(Object.assign({ id }, patch));
  } else {
    rows[idx] = replace ? Object.assign({ id }, patch) : Object.assign({}, rows[idx], patch);
  }
  writeAll(collection, rows);
  return rows.find((r) => r.id === id);
}

// ---- Users ----

async function getUsers() {
  return readAll('users');
}

async function saveUsers(users) {
  writeAll('users', users);
}

async function findUserByEmail(email) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return null;
  return readAll('users').find((u) => u.email === norm) || null;
}

async function findUserById(id) {
  if (!id) return null;
  return readAll('users').find((u) => u.id === id) || null;
}

async function findUsersByRole(role) {
  return readAll('users').filter((u) => Array.isArray(u.roles) && u.roles.includes(role));
}

async function createUser(user) {
  upsert('users', user.id, user, true);
  return user;
}

async function updateUser(id, patch) {
  return upsert('users', id, patch, false);
}

// ---- Submissions ----

async function getSubmissions() {
  return readAll('submissions');
}

async function saveSubmissions(subs) {
  writeAll('submissions', subs);
}

async function createSubmission(sub) {
  upsert('submissions', sub.id, sub, true);
  return sub;
}

async function updateSubmission(id, patch) {
  return upsert('submissions', id, patch, false);
}

async function getSubmissionById(id) {
  if (!id) return null;
  return readAll('submissions').find((s) => s.id === id) || null;
}

async function getSubmissionsByUser(userId) {
  return readAll('submissions')
    .filter((s) => s.userId === userId)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

async function getSubmissionsForEditor(stage) {
  return readAll('submissions')
    .filter((s) => !stage || s.stage === stage)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

// ---- Review assignments ----

async function createReviewAssignment(assignment) {
  upsert('reviewAssignments', assignment.id, assignment, true);
  return assignment;
}

async function getReviewAssignmentById(id) {
  if (!id) return null;
  return readAll('reviewAssignments').find((a) => a.id === id) || null;
}

async function updateReviewAssignment(id, patch) {
  return upsert('reviewAssignments', id, patch, false);
}

async function getAssignmentsForSubmission(submissionId) {
  return readAll('reviewAssignments')
    .filter((a) => a.submissionId === submissionId)
    .sort((a, b) => a.round - b.round || new Date(a.assignedAt) - new Date(b.assignedAt));
}

// Full scan, used by the reminder sweep.
async function getAllReviewAssignments() {
  return readAll('reviewAssignments');
}

async function getAssignmentsForReviewer(reviewerId) {
  return readAll('reviewAssignments')
    .filter((a) => a.reviewerId === reviewerId)
    .sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));
}

// ---- Issues ----

async function createIssue(issue) {
  upsert('issues', issue.id, issue, true);
  return issue;
}

async function getIssueById(id) {
  if (!id) return null;
  return readAll('issues').find((i) => i.id === id) || null;
}

async function updateIssue(id, patch) {
  return upsert('issues', id, patch, false);
}

async function getIssues(journalCode) {
  const rows = readAll('issues');
  return journalCode ? rows.filter((i) => i.journalCode === journalCode) : rows;
}

async function deleteIssue(id) {
  const rows = readAll('issues').filter((i) => i.id !== id);
  writeAll('issues', rows);
}

// ---- Published-article queries ----
//
// Both of these are the public site's read path, so they filter on stage
// here rather than trusting the caller to remember.

async function getSubmissionsByIssue(issueId) {
  if (!issueId) return [];
  return readAll('submissions').filter((s) => s.issueId === issueId);
}

async function getPublishedSubmissions(journalCode) {
  return readAll('submissions').filter(
    (s) => s.stage === 'published' && (!journalCode || s.journalCode === journalCode)
  );
}

module.exports = {
  backend: 'local',
  ensureStore,
  findUserByEmail,
  findUserById,
  findUsersByRole,
  createUser,
  updateUser,
  getUsers,
  saveUsers,
  createSubmission,
  getSubmissionsByUser,
  getSubmissionById,
  getSubmissionsForEditor,
  updateSubmission,
  getSubmissions,
  saveSubmissions,
  createReviewAssignment,
  getReviewAssignmentById,
  updateReviewAssignment,
  getAssignmentsForSubmission,
  getAssignmentsForReviewer,
  getAllReviewAssignments,
  createIssue,
  getIssueById,
  updateIssue,
  getIssues,
  deleteIssue,
  getSubmissionsByIssue,
  getPublishedSubmissions,
};
