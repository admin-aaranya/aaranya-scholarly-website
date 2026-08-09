// Tests for the editorial workflow rules in lib/workflow.js.
//
// These cover the two things most worth proving: that stage transitions can't
// be jumped, and that the anonymity guarantees actually hold (a reviewer
// never receives author identity; an author never receives reviewer identity
// or the confidential comments meant for the editor).
//
// Deliberately dependency-free -- run with `npm test`, no GCP needed.

const assert = require('assert');
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

// ---- Fixtures ----

const fullSubmission = {
  id: 'sub-1',
  userId: 'user-author',
  journalCode: 'alstm',
  journalName: 'Advanced Life Sciences & Translational Medicine',
  articleType: 'Original Research Article',
  subjectArea: 'Molecular Biology',
  title: 'A study of things',
  abstract: 'An abstract long enough to be plausible for this test fixture.',
  keywords: 'things, study',
  correspondingAuthor: {
    name: 'Dr Priya Sharma',
    email: 'priya.sharma@example.edu',
    affiliation: 'Example University',
  },
  coAuthorsList: [{ name: 'Dr Rahul Verma', email: 'rv@example.edu', affiliation: 'Example University' }],
  coverLetter: 'Dear Editor, I am Priya Sharma of Example University...',
  suggestedReviewers: [{ name: 'Prof A Friend', email: 'friend@example.edu', affiliation: 'Friendly Inst' }],
  declarations: {
    originality: true,
    ethicsCompliance: true,
    ethicsApprovalDetails: 'Approved by Example University IRB #123',
    conflictOfInterest: 'None declared by Sharma et al.',
  },
  manuscript: { fileName: 'Sharma-final.docx', storedFileName: 'submissions/sub-1/abc.docx', fileSize: 1024 },
  supplementaryFiles: [
    { fileName: 'Sharma-data.pdf', storedFileName: 'submissions/sub-1/def.pdf', fileSize: 2048 },
  ],
  currentRound: 2,
  statusHistory: [{ status: 'Submitted', note: 'x', at: '2026-01-01T00:00:00Z' }],
  decisions: [{ decision: 'send_to_review', editorName: 'Editor Person' }],
};

const completedAssignment = {
  id: 'asg-1',
  submissionId: 'sub-1',
  round: 2,
  reviewerId: 'user-reviewer',
  status: wf.ASSIGNMENT_STATUS.COMPLETED,
  recommendation: 'minor_revisions',
  commentsForAuthor: 'The methods section needs more detail.',
  commentsForEditor: 'I suspect this overlaps with their 2024 paper.',
  completedAt: '2026-02-01T00:00:00Z',
};

// ---- Stage transitions ----

console.log('\nStage transitions');

test('a new submission can be sent to review', () => {
  assert.strictEqual(wf.isDecisionAllowed('send_to_review', wf.STAGES.SUBMISSION), true);
});

test('a new submission cannot be accepted straight from peer review decisions', () => {
  // "Accept Submission" is a post-review decision; from the Submission stage
  // the editor must use "Accept and Skip Review" instead.
  assert.strictEqual(wf.isDecisionAllowed('accept', wf.STAGES.SUBMISSION), false);
  assert.strictEqual(wf.isDecisionAllowed('accept_skip_review', wf.STAGES.SUBMISSION), true);
});

test('review-stage decisions are unavailable before review starts', () => {
  ['request_revisions', 'resubmit_for_review'].forEach((d) => {
    assert.strictEqual(wf.isDecisionAllowed(d, wf.STAGES.SUBMISSION), false, d);
  });
});

test('a declined submission accepts no further decisions', () => {
  assert.strictEqual(wf.availableDecisions(wf.STAGES.DECLINED).length, 0);
});

test('a published submission accepts no further decisions', () => {
  assert.strictEqual(wf.availableDecisions(wf.STAGES.PUBLISHED).length, 0);
});

test('publishing requires passing through production', () => {
  assert.strictEqual(wf.isDecisionAllowed('publish', wf.STAGES.COPYEDITING), false);
  assert.strictEqual(wf.isDecisionAllowed('publish', wf.STAGES.PRODUCTION), true);
});

test('decline is available at every pre-terminal stage', () => {
  [wf.STAGES.SUBMISSION, wf.STAGES.REVIEW, wf.STAGES.COPYEDITING].forEach((s) => {
    assert.strictEqual(wf.isDecisionAllowed('decline', s), true, s);
  });
});

test('an unknown decision key is rejected', () => {
  assert.strictEqual(wf.isDecisionAllowed('accept_because_i_said_so', wf.STAGES.REVIEW), false);
});

test('only resubmit_for_review and send_to_review open a new round', () => {
  const starters = Object.values(wf.DECISIONS).filter((d) => d.startsRound).map((d) => d.key).sort();
  assert.deepStrictEqual(starters, ['resubmit_for_review', 'send_to_review']);
});

test('every decision targets a real stage', () => {
  Object.values(wf.DECISIONS).forEach((d) => {
    assert.ok(wf.STAGE_LABELS[d.to], `${d.key} -> unknown stage ${d.to}`);
  });
});

// ---- Reviewer anonymity (double-anonymous) ----

console.log('\nReviewer view (author identity must not leak)');

const rv = wf.reviewerView(fullSubmission);

test('reviewer view keeps the scholarly content', () => {
  assert.strictEqual(rv.title, fullSubmission.title);
  assert.strictEqual(rv.abstract, fullSubmission.abstract);
  assert.strictEqual(rv.journalName, fullSubmission.journalName);
});

test('reviewer view strips the corresponding author and co-authors', () => {
  assert.strictEqual(rv.correspondingAuthor, undefined);
  assert.strictEqual(rv.coAuthorsList, undefined);
});

test('reviewer view strips the cover letter and suggested reviewers', () => {
  assert.strictEqual(rv.coverLetter, undefined);
  assert.strictEqual(rv.suggestedReviewers, undefined);
});

test('reviewer view strips the submitting account id', () => {
  assert.strictEqual(rv.userId, undefined);
});

test('reviewer view strips identifying free-text declarations', () => {
  // Ethics approval names the institution; CoI text often names the authors.
  assert.strictEqual(rv.declarations.ethicsApprovalDetails, undefined);
  assert.strictEqual(rv.declarations.conflictOfInterest, undefined);
  // The booleans a reviewer legitimately needs are kept.
  assert.strictEqual(rv.declarations.originality, true);
  assert.strictEqual(rv.declarations.ethicsCompliance, true);
});

test('reviewer view strips storage keys, decisions, and editorial history', () => {
  assert.strictEqual(rv.manuscript.storedFileName, undefined);
  assert.strictEqual(rv.supplementaryFiles[0].storedFileName, undefined);
  assert.strictEqual(rv.decisions, undefined);
  assert.strictEqual(rv.statusHistory, undefined);
});

test('reviewer view strips original filenames but keeps type and size', () => {
  // Regression: authors name files "Sharma-final.docx", so the filename is
  // itself identifying and must not reach the reviewer.
  assert.strictEqual(rv.manuscript.fileName, undefined);
  assert.strictEqual(rv.manuscript.fileType, '.docx');
  assert.strictEqual(rv.manuscript.fileSize, 1024);
  assert.strictEqual(rv.supplementaryFiles[0].fileName, undefined);
  assert.strictEqual(rv.supplementaryFiles[0].fileType, '.pdf');
});

test('no author name appears anywhere in the serialized reviewer view', () => {
  const blob = JSON.stringify(rv);
  ['Priya', 'Sharma', 'Rahul', 'Verma', 'Example University', 'priya.sharma@example.edu'].forEach((needle) => {
    assert.ok(!blob.includes(needle), `reviewer view leaked "${needle}"`);
  });
});

test('reviewer view of a missing submission is null, not a crash', () => {
  assert.strictEqual(wf.reviewerView(null), null);
});

// ---- Author view of a review (reviewer identity must not leak) ----

console.log('\nAuthor view of a review (reviewer identity must not leak)');

const av = wf.authorViewOfReview(completedAssignment);

test('author sees the recommendation and the comments written for them', () => {
  assert.strictEqual(av.recommendation, 'minor_revisions');
  assert.strictEqual(av.recommendationLabel, 'Revisions Required');
  assert.strictEqual(av.commentsForAuthor, completedAssignment.commentsForAuthor);
});

test('author never sees the reviewer id', () => {
  assert.strictEqual(av.reviewerId, undefined);
});

test('author never sees the confidential comments to the editor', () => {
  assert.strictEqual(av.commentsForEditor, undefined);
  assert.ok(!JSON.stringify(av).includes('2024 paper'));
});

test('an in-progress review is not exposed to the author at all', () => {
  [wf.ASSIGNMENT_STATUS.PENDING, wf.ASSIGNMENT_STATUS.ACCEPTED, wf.ASSIGNMENT_STATUS.DECLINED].forEach((status) => {
    const partial = Object.assign({}, completedAssignment, { status });
    assert.strictEqual(wf.authorViewOfReview(partial), null, status);
  });
});

// ---- Roles ----

console.log('\nRoles');

test('a legacy record with role:"author" still resolves', () => {
  assert.deepStrictEqual(wf.userRoles({ role: 'author' }), ['author']);
});

test('a record with no role at all defaults to author', () => {
  assert.deepStrictEqual(wf.userRoles({}), ['author']);
});

test('the roles array wins when both are present', () => {
  assert.deepStrictEqual(wf.userRoles({ role: 'author', roles: ['author', 'editor'] }), ['author', 'editor']);
});

test('hasRole is accurate for granted and missing roles', () => {
  const editor = { roles: ['author', 'editor'] };
  assert.strictEqual(wf.hasRole(editor, wf.ROLES.EDITOR), true);
  assert.strictEqual(wf.hasRole(editor, wf.ROLES.REVIEWER), false);
});

test('the author role cannot be granted or revoked through the roles API', () => {
  assert.ok(!wf.ASSIGNABLE_ROLES.includes(wf.ROLES.AUTHOR));
});

// ---- Recommendations ----

console.log('\nReviewer recommendations');

test('the OJS recommendation set is present', () => {
  ['accept', 'minor_revisions', 'resubmit_for_review', 'resubmit_elsewhere', 'decline', 'see_comments'].forEach((k) => {
    assert.ok(wf.RECOMMENDATIONS[k], `missing recommendation ${k}`);
  });
});

// ---- Summary ----

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
