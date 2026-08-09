// Firestore-backed datastore -- the production backend.
//
// Collections: "users", "submissions", "reviewAssignments". Document ID is
// our own uuid, so lookups by id are direct doc reads with no query.
//
// Auth: on Cloud Run the attached service account is used automatically. For
// local use against a real project, run `gcloud auth application-default
// login` once, or set GOOGLE_APPLICATION_CREDENTIALS to a key file.
//
// Selected by db.js; see lib/local-store.js for the credential-free
// alternative used in development.

const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

const USERS = firestore.collection('users');
const SUBMISSIONS = firestore.collection('submissions');
const REVIEW_ASSIGNMENTS = firestore.collection('reviewAssignments');
const ISSUES = firestore.collection('issues');

// No-op: Firestore has no "create the file if missing" step. Kept so
// server.js's ensureStore() call is valid against either backend.
function ensureStore() {}

// ---- Users ----

async function getUsers() {
  const snap = await USERS.get();
  return snap.docs.map((d) => d.data());
}

async function saveUsers(users) {
  const batch = firestore.batch();
  users.forEach((u) => batch.set(USERS.doc(u.id), u));
  await batch.commit();
}

async function findUserByEmail(email) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return null;
  const snap = await USERS.where('email', '==', norm).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}

async function findUserById(id) {
  if (!id) return null;
  const doc = await USERS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function findUsersByRole(role) {
  const snap = await USERS.where('roles', 'array-contains', role).get();
  return snap.docs.map((d) => d.data());
}

async function createUser(user) {
  await USERS.doc(user.id).set(user);
  return user;
}

async function updateUser(id, patch) {
  await USERS.doc(id).set(patch, { merge: true });
  return findUserById(id);
}

// ---- Submissions ----

async function getSubmissions() {
  const snap = await SUBMISSIONS.get();
  return snap.docs.map((d) => d.data());
}

async function saveSubmissions(subs) {
  const batch = firestore.batch();
  subs.forEach((s) => batch.set(SUBMISSIONS.doc(s.id), s));
  await batch.commit();
}

async function createSubmission(sub) {
  await SUBMISSIONS.doc(sub.id).set(sub);
  return sub;
}

async function updateSubmission(id, patch) {
  await SUBMISSIONS.doc(id).set(patch, { merge: true });
  return getSubmissionById(id);
}

async function getSubmissionById(id) {
  if (!id) return null;
  const doc = await SUBMISSIONS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function getSubmissionsByUser(userId) {
  const snap = await SUBMISSIONS.where('userId', '==', userId).get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

// Sorted in memory so we don't need a composite index for every
// stage/date combination.
async function getSubmissionsForEditor(stage) {
  const query = stage ? SUBMISSIONS.where('stage', '==', stage) : SUBMISSIONS;
  const snap = await query.get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

// ---- Review assignments ----

async function createReviewAssignment(assignment) {
  await REVIEW_ASSIGNMENTS.doc(assignment.id).set(assignment);
  return assignment;
}

async function getReviewAssignmentById(id) {
  if (!id) return null;
  const doc = await REVIEW_ASSIGNMENTS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateReviewAssignment(id, patch) {
  await REVIEW_ASSIGNMENTS.doc(id).set(patch, { merge: true });
  return getReviewAssignmentById(id);
}

async function getAssignmentsForSubmission(submissionId) {
  const snap = await REVIEW_ASSIGNMENTS.where('submissionId', '==', submissionId).get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => a.round - b.round || new Date(a.assignedAt) - new Date(b.assignedAt));
}

// Full scan, used by the reminder sweep. Fine at journal scale (hundreds of
// assignments); if this ever grows large, filter server-side on status
// instead of pulling everything.
async function getAllReviewAssignments() {
  const snap = await REVIEW_ASSIGNMENTS.get();
  return snap.docs.map((d) => d.data());
}

async function getAssignmentsForReviewer(reviewerId) {
  const snap = await REVIEW_ASSIGNMENTS.where('reviewerId', '==', reviewerId).get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));
}

// ---- Issues ----
//
// Ordering is done in memory (lib/issues.js sortIssues) rather than with
// orderBy, for the same reason as the submission queries above: a composite
// index per sort combination is a deployment step that fails long after the
// code that needed it shipped.

async function createIssue(issue) {
  await ISSUES.doc(issue.id).set(issue);
  return issue;
}

async function getIssueById(id) {
  if (!id) return null;
  const doc = await ISSUES.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateIssue(id, patch) {
  await ISSUES.doc(id).set(patch, { merge: true });
  return getIssueById(id);
}

async function getIssues(journalCode) {
  const query = journalCode ? ISSUES.where('journalCode', '==', journalCode) : ISSUES;
  const snap = await query.get();
  return snap.docs.map((d) => d.data());
}

async function deleteIssue(id) {
  await ISSUES.doc(id).delete();
}

// ---- Published-article queries ----

async function getSubmissionsByIssue(issueId) {
  if (!issueId) return [];
  const snap = await SUBMISSIONS.where('issueId', '==', issueId).get();
  return snap.docs.map((d) => d.data());
}

// The journal filter is applied in memory on purpose. Firestore can serve two
// equality clauses, but every extra indexed field combination is one more
// thing that has to exist in the project before a query stops failing in
// production only. One indexed field, one filter in code.
async function getPublishedSubmissions(journalCode) {
  const snap = await SUBMISSIONS.where('stage', '==', 'published').get();
  return snap.docs.map((d) => d.data()).filter((s) => !journalCode || s.journalCode === journalCode);
}

module.exports = {
  backend: 'firestore',
  firestore,
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
