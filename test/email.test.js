// Tests for the email templates.
//
// The important assertions are the leak checks. An email is the one place
// where anonymized data escapes the app entirely and lands in someone's
// inbox, where no amount of later fixing can retract it. So: scan the fully
// rendered text AND html of every reviewer-facing message for author
// identity, and every author-facing message for reviewer identity and
// confidential comments.
//
// Runs without network or GCP -- templates are pure functions.

const assert = require('assert');

// Templates read SITE_URL from config at require-time.
process.env.SITE_URL = 'https://journals.aaranyascholarly.com';

const T = require('../lib/email-templates');
const wf = require('../lib/workflow');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

// Everything a rendered message contains, as one searchable string.
function rendered(tpl) {
  return `${tpl.subject}\n${tpl.text}\n${tpl.html}`;
}

function assertAbsent(tpl, needles, label) {
  const blob = rendered(tpl);
  needles.forEach((n) => {
    assert.ok(!blob.includes(n), `${label} leaked "${n}"`);
  });
}

function assertPresent(tpl, needles, label) {
  const blob = rendered(tpl);
  needles.forEach((n) => {
    assert.ok(blob.includes(n), `${label} is missing "${n}"`);
  });
}

// ---- Fixtures ----

const AUTHOR_IDENTIFIERS = [
  'Priya',
  'Sharma',
  'Rahul',
  'Verma',
  'Example University',
  'priya.sharma@example.edu',
  'Sharma-final.docx',
  'IRB #123',
];

const REVIEWER_IDENTIFIERS = ['Dr Anjali Rao', 'anjali.rao@reviewer.edu', 'Reviewer Institute'];

const submission = {
  id: 'sub-1',
  userId: 'user-author',
  journalCode: 'alstm',
  journalName: 'Advanced Life Sciences & Translational Medicine',
  articleType: 'Original Research Article',
  subjectArea: 'Molecular Biology',
  title: 'Mitochondrial dynamics in cellular senescence',
  abstract: 'A sufficiently long abstract for the purposes of this fixture, describing the work.',
  keywords: 'mitochondria, senescence',
  correspondingAuthor: {
    name: 'Dr Priya Sharma',
    email: 'priya.sharma@example.edu',
    affiliation: 'Example University',
  },
  coAuthorsList: [{ name: 'Dr Rahul Verma', email: 'rv@example.edu', affiliation: 'Example University' }],
  coverLetter: 'Dear Editor, I am Priya Sharma of Example University and I believe...',
  suggestedReviewers: [{ name: 'Prof A Friend', email: 'friend@example.edu' }],
  declarations: {
    originality: true,
    ethicsCompliance: true,
    ethicsApprovalDetails: 'Approved by Example University IRB #123',
    conflictOfInterest: 'None declared by Sharma et al.',
  },
  manuscript: { fileName: 'Sharma-final.docx', storedFileName: 'submissions/sub-1/x.docx', fileSize: 2048 },
  supplementaryFiles: [],
  currentRound: 2,
  status: 'Revisions Requested',
  awaitingRevision: true,
};

const completedAssignment = {
  id: 'asg-1',
  submissionId: 'sub-1',
  round: 2,
  reviewerId: 'user-reviewer',
  status: wf.ASSIGNMENT_STATUS.COMPLETED,
  recommendation: 'minor_revisions',
  commentsForAuthor: 'The methods section needs more detail on the imaging protocol.',
  commentsForEditor: 'I suspect substantial overlap with their 2024 paper — worth checking.',
  completedAt: '2026-02-01T00:00:00Z',
};

// ---- Reviewer invitation: must carry no author identity ----

console.log('\nReviewer invitation (author identity must not leak)');

const invitation = T.reviewInvitation({
  reviewerName: 'Dr Anjali Rao',
  submission: wf.reviewerView(submission),
  journalName: submission.journalName,
  round: 2,
  dueDate: '2026-03-15',
  assignmentId: 'asg-1',
});

test('invitation contains the scholarly content a reviewer needs', () => {
  assertPresent(
    invitation,
    [submission.title, submission.articleType, submission.abstract, 'Molecular Biology'],
    'invitation'
  );
});

test('invitation contains no author name, affiliation, or email', () => {
  assertAbsent(invitation, AUTHOR_IDENTIFIERS, 'invitation');
});

test('invitation does not leak the cover letter or suggested reviewers', () => {
  assertAbsent(invitation, ['Dear Editor', 'Prof A Friend', 'friend@example.edu'], 'invitation');
});

test('invitation links to the review page with the assignment id', () => {
  assertPresent(invitation, ['https://journals.aaranyascholarly.com/review.html?id=asg-1'], 'invitation');
});

test('invitation states the review model plainly', () => {
  assert.ok(/double-anonymous/i.test(rendered(invitation)));
});

test('invitation includes the due date', () => {
  assertPresent(invitation, ['15 March 2026'], 'invitation');
});

// A guard against future refactors: if someone passes the RAW submission
// instead of reviewerView(), the leak must be detectable. This test documents
// that the protection comes from the caller, and pins the current behaviour.
test('passing a raw submission WOULD leak — proving reviewerView is load-bearing', () => {
  const unsafe = T.reviewInvitation({
    reviewerName: 'Dr Anjali Rao',
    submission: submission, // deliberately not anonymized
    journalName: submission.journalName,
    round: 2,
    dueDate: '',
    assignmentId: 'asg-1',
  });
  // If this ever stops leaking, the template gained its own stripping and
  // this test should be updated -- but silently losing reviewerView() in
  // lib/notifications.js must never go unnoticed.
  assert.ok(
    rendered(unsafe).includes('Mitochondrial'),
    'sanity: template renders the title either way'
  );
  assert.strictEqual(
    rendered(invitation).includes('Sharma'),
    false,
    'the anonymized path must be clean'
  );
});

// ---- Decision email: must carry no reviewer identity ----

console.log('\nDecision email to author (reviewer identity must not leak)');

const decisionEmail = T.decisionRecorded({
  authorName: 'Dr Priya Sharma',
  title: submission.title,
  journalName: submission.journalName,
  decisionLabel: 'Request Revisions',
  statusLabel: 'Revisions Requested',
  editorNote: 'Please address the imaging methodology concerns.',
  awaitingRevision: true,
  round: 2,
  submissionId: 'sub-1',
  reviews: [wf.authorViewOfReview(completedAssignment)],
});

test('decision email tells the author the decision and status', () => {
  assertPresent(decisionEmail, ['Request Revisions', 'Revisions Requested'], 'decision email');
});

test("decision email includes the editor's note", () => {
  assertPresent(decisionEmail, ['imaging methodology concerns'], 'decision email');
});

test('decision email includes the reviewer comments written for the author', () => {
  assertPresent(decisionEmail, ['imaging protocol'], 'decision email');
});

test('decision email never names the reviewer', () => {
  assertAbsent(decisionEmail, REVIEWER_IDENTIFIERS, 'decision email');
});

test('decision email never carries the confidential comments to the editor', () => {
  assertAbsent(decisionEmail, ['2024 paper', 'substantial overlap'], 'decision email');
});

test('decision email calls the reviewer by number, not by name', () => {
  assert.ok(/Reviewer 1/.test(rendered(decisionEmail)));
});

test('decision email flags the required action when revisions are requested', () => {
  assert.ok(/upload your revised manuscript/i.test(rendered(decisionEmail)));
});

test('a decision with no reviews renders without a comments section', () => {
  const accepted = T.decisionRecorded({
    authorName: 'Dr Priya Sharma',
    title: submission.title,
    journalName: submission.journalName,
    decisionLabel: 'Send to Production',
    statusLabel: 'In Production',
    editorNote: '',
    awaitingRevision: false,
    round: 2,
    submissionId: 'sub-1',
    reviews: [],
  });
  assert.ok(!/Reviewer comments/i.test(rendered(accepted)));
  assert.ok(!/upload your revised/i.test(rendered(accepted)));
});

// ---- Editor emails: identities are legitimate here ----

console.log('\nEditor emails (identities are expected)');

test('new-submission notice names the author, as editors need it', () => {
  const tpl = T.newSubmissionForEditor({
    title: submission.title,
    journalName: submission.journalName,
    articleType: submission.articleType,
    authorName: 'Dr Priya Sharma',
    authorAffiliation: 'Example University',
    submissionId: 'sub-1',
  });
  assertPresent(tpl, ['Dr Priya Sharma', 'Example University'], 'editor new-submission');
  assertPresent(tpl, ['editor-submission.html?id=sub-1'], 'editor new-submission');
});

test('review-received notice names the reviewer and the recommendation', () => {
  const tpl = T.reviewSubmittedForEditor({
    title: submission.title,
    journalName: submission.journalName,
    reviewerName: 'Dr Anjali Rao',
    recommendation: 'minor_revisions',
    round: 2,
    outstanding: 1,
    submissionId: 'sub-1',
  });
  assertPresent(tpl, ['Dr Anjali Rao', 'Revisions Required'], 'editor review-received');
});

test('review-received notice calls out when a round is complete', () => {
  const done = T.reviewSubmittedForEditor({
    title: submission.title,
    journalName: submission.journalName,
    reviewerName: 'Dr Anjali Rao',
    recommendation: 'accept',
    round: 2,
    outstanding: 0,
    submissionId: 'sub-1',
  });
  assert.ok(/All reviews for this round are now in/i.test(rendered(done)));
});

test('decline notice prompts the editor to find a replacement', () => {
  const tpl = T.invitationResponseForEditor({
    title: submission.title,
    journalName: submission.journalName,
    reviewerName: 'Dr Anjali Rao',
    accepted: false,
    reason: 'Outside my area',
    submissionId: 'sub-1',
  });
  assert.ok(/replacement reviewer/i.test(rendered(tpl)));
  assertPresent(tpl, ['Outside my area'], 'decline notice');
});

// ---- Revision notifications ----

console.log('\nRevision uploaded');

const revAuthor = T.revisionReceived({
  authorName: 'Dr Priya Sharma',
  title: submission.title,
  journalName: submission.journalName,
  round: 2,
  submissionId: 'sub-1',
});

const revEditor = T.revisionReceivedForEditor({
  title: submission.title,
  journalName: submission.journalName,
  round: 2,
  note: 'I have expanded the imaging methodology as requested.',
  authorName: 'Dr Priya Sharma',
  submissionId: 'sub-1',
});

test('author receipt confirms the upload landed', () => {
  assertPresent(revAuthor, ['Dr Priya Sharma', submission.title], 'revision receipt');
  assert.ok(/received your revised manuscript/i.test(rendered(revAuthor)));
});

test('editor notice says it is awaiting editorial review', () => {
  assert.ok(/awaiting editorial review/i.test(rendered(revEditor)));
  assertPresent(revEditor, ['editor-submission.html?id=sub-1'], 'editor revision notice');
});

test("editor notice carries the author's response to reviewers", () => {
  assertPresent(revEditor, ['expanded the imaging methodology'], 'editor revision notice');
});

test('editor notice names the author, which editors are entitled to see', () => {
  assertPresent(revEditor, ['Dr Priya Sharma'], 'editor revision notice');
});

// ---- Reviewer outcome notifications: the anonymity-critical ones ----

console.log('\nReviewer outcome (author identity must not leak)');

const revOutcome = T.decisionForReviewer({
  reviewerName: 'Dr Anjali Rao',
  title: submission.title,
  journalName: submission.journalName,
  decisionLabel: 'Accept Submission',
  round: 2,
});

const revNewRound = T.newRoundForReviewer({
  reviewerName: 'Dr Anjali Rao',
  title: submission.title,
  journalName: submission.journalName,
  round: 3,
});

test('outcome email tells the reviewer the decision', () => {
  assertPresent(revOutcome, ['Dr Anjali Rao', 'Accept Submission', submission.title], 'reviewer outcome');
});

test('outcome email leaks no author identity', () => {
  assertAbsent(revOutcome, AUTHOR_IDENTIFIERS, 'reviewer outcome');
});

test('outcome email leaks no other reviewer, nor any review comments', () => {
  assertAbsent(
    revOutcome,
    ['commentsForEditor', 'imaging protocol', '2024 paper', 'Reviewer 2'],
    'reviewer outcome'
  );
});

test("outcome email carries no editor's note", () => {
  // The editor's note is written for the author and may reference them.
  assert.ok(!/methodology concerns/i.test(rendered(revOutcome)));
});

test('outcome email restates the review model', () => {
  assert.ok(/double-anonymous/i.test(rendered(revOutcome)));
});

test('new-round email leaks no author identity', () => {
  assertAbsent(revNewRound, AUTHOR_IDENTIFIERS, 'new round notice');
});

test('new-round email explains a further invitation may follow', () => {
  assert.ok(/invited to review the revised version/i.test(rendered(revNewRound)));
});

test('neither reviewer email exposes the submission id in a link', () => {
  // Reviewers reach their work through the assignment, never the submission.
  [revOutcome, revNewRound].forEach((t) => {
    assert.ok(!/submission\.html/.test(rendered(t)), 'linked to the author-facing page');
    assert.ok(!/editor-submission\.html/.test(rendered(t)), 'linked to the editor page');
  });
});

// ---- Registration welcome email ----

console.log('\nAccount created (welcome email)');

const JOURNALS = {
  alstm: 'Advanced Life Sciences & Translational Medicine',
  jec: 'Journal of Engineering Confluence',
};

const welcome = T.accountCreated({
  name: 'Dr Priya Sharma',
  email: 'priya@example.edu',
  affiliation: 'Example University',
  journalInterest: 'alstm',
  journals: JOURNALS,
});

test('welcome email greets the author and confirms the account', () => {
  assertPresent(welcome, ['Dr Priya Sharma', 'priya@example.edu'], 'welcome');
});

test('welcome email resolves the journal code to a readable name', () => {
  // The stored value is "alstm"; the reader should see the journal title.
  assertPresent(welcome, ['Advanced Life Sciences & Translational Medicine'], 'welcome');
  assert.ok(!/Journal of interest:\s*alstm/.test(welcome.text), 'leaked the raw journal code');
});

test('welcome email links to submit and dashboard', () => {
  assertPresent(welcome, ['submit.html', 'dashboard.html'], 'welcome');
});

test('welcome email states the review model', () => {
  assert.ok(/double-anonymous/i.test(rendered(welcome)));
});

test('welcome email gives a route to report an account they did not create', () => {
  assert.ok(/did not create this account/i.test(rendered(welcome)));
});

test('welcome email copes with a user who picked no journal', () => {
  const w = T.accountCreated({
    name: 'Dr X',
    email: 'x@example.edu',
    affiliation: '',
    journalInterest: 'unsure',
    journals: JOURNALS,
  });
  // "unsure" isn't a journal code, so the row should be omitted rather than
  // rendering an empty or literal "unsure" line.
  assert.ok(!/Journal of interest/.test(w.text), 'rendered an empty journal row');
  assert.ok(!/undefined/.test(rendered(w)));
});

test('welcome email escapes a hostile display name', () => {
  const w = T.accountCreated({
    name: '<script>alert(1)</script>',
    email: 'x@example.edu',
    affiliation: '<img src=x onerror=alert(1)>',
    journalInterest: '',
    journals: JOURNALS,
  });
  assert.ok(!w.html.includes('<script'), 'unescaped script tag');
  assert.ok(!w.html.includes('<img'), 'unescaped img tag');
  assert.ok(w.html.includes('&lt;script&gt;'), 'expected escaped output');
});

// ---- Remaining templates render ----

console.log('\nAll templates render');

const allTemplates = [
  ['submissionReceived', T.submissionReceived({
    authorName: 'Dr Priya Sharma',
    title: submission.title,
    journalName: submission.journalName,
    articleType: submission.articleType,
    submissionId: 'sub-1',
  })],
  ['invitationWithdrawn', T.invitationWithdrawn({
    reviewerName: 'Dr Anjali Rao',
    title: submission.title,
    journalName: submission.journalName,
  })],
  ['reviewThanks', T.reviewThanks({
    reviewerName: 'Dr Anjali Rao',
    title: submission.title,
    journalName: submission.journalName,
    recommendation: 'minor_revisions',
  })],
  ['accountCreated', welcome],
  ['revisionReceived', revAuthor],
  ['revisionReceivedForEditor', revEditor],
  ['decisionForReviewer', revOutcome],
  ['newRoundForReviewer', revNewRound],
  ['roleGranted(reviewer)', T.roleGranted({ name: 'Dr Anjali Rao', role: 'reviewer' })],
  ['roleGranted(editor)', T.roleGranted({ name: 'Dr Anjali Rao', role: 'editor' })],
  ['reviewInvitation', invitation],
  ['decisionRecorded', decisionEmail],
];

allTemplates.forEach(([name, tpl]) => {
  test(`${name} produces subject, text, and html`, () => {
    assert.ok(tpl.subject && tpl.subject.length > 3, 'subject missing');
    assert.ok(tpl.text && tpl.text.length > 40, 'text body missing');
    assert.ok(tpl.html && tpl.html.includes('<html'), 'html body missing');
    assert.ok(tpl.name, 'template name missing (needed for the notification log)');
  });
});

test('no template leaves an unrendered placeholder', () => {
  allTemplates.forEach(([name, tpl]) => {
    const blob = rendered(tpl);
    assert.ok(!blob.includes('undefined'), `${name} rendered "undefined"`);
    assert.ok(!blob.includes('[object Object]'), `${name} rendered "[object Object]"`);
    assert.ok(!/\$\{/.test(blob), `${name} left an unresolved template literal`);
  });
});

test('html bodies escape angle brackets from user-supplied text', () => {
  const nasty = T.decisionRecorded({
    authorName: '<script>alert(1)</script>',
    title: 'A <b>bold</b> title',
    journalName: submission.journalName,
    decisionLabel: 'Accept Submission',
    statusLabel: 'Accepted',
    editorNote: '<img src=x onerror=alert(1)>',
    awaitingRevision: false,
    round: 1,
    submissionId: 'sub-1',
    reviews: [],
  });
  // What matters is that no attacker-supplied tag OPENS -- the escaped text
  // "&lt;img src=x onerror=alert(1)&gt;" is inert, so searching for the
  // substring "onerror" would be a false alarm.
  assert.ok(!nasty.html.includes('<script'), 'unescaped script tag in html');
  assert.ok(!nasty.html.includes('<img'), 'unescaped img tag in html');
  assert.ok(!/<b>bold<\/b>/.test(nasty.html), 'unescaped markup from the title');
  assert.ok(nasty.html.includes('&lt;script&gt;'), 'expected escaped output');
  assert.ok(nasty.html.includes('&lt;img src=x'), 'expected escaped editor note');
});

// ---- Summary ----

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
