// Tests for journal-scoped roles.
//
// Two failure modes matter here and they pull in opposite directions:
//
//   too permissive -> a JEC editor can decline an ALSTM paper
//   too strict     -> a migration bug locks the journal's owner out of it
//
// Both are tested. The lockout case is why bootstrap addresses are always
// treated as managing editors.

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

const ALL = ['alstm', 'ipsb', 'ghesb', 'jec', 'jtim', 'jsamp', 'acfdi'];
const BOOTSTRAP = ['owner@aaranyascholarly.com'];

const sectionEditor = {
  email: 'jec.editor@example.edu',
  roles: ['author', 'editor'],
  journalRoles: { editor: ['jec'] },
};
const reviewer = {
  email: 'rev@example.edu',
  roles: ['author', 'reviewer'],
  journalRoles: { reviewer: ['alstm', 'ipsb'] },
};
const managing = {
  email: 'chief@example.edu',
  roles: ['author', 'editor', 'managing_editor'],
  journalRoles: {},
};
const bootstrapOwner = { email: 'owner@aaranyascholarly.com', roles: ['author'] };
const plainAuthor = { email: 'a@example.edu', roles: ['author'] };

// ---- Editor scope ----

console.log('\nEditor scope');

test('a section editor can edit their own journal', () => {
  assert.strictEqual(wf.canEditJournal(sectionEditor, 'jec', BOOTSTRAP), true);
});

test('a section editor CANNOT edit another journal', () => {
  assert.strictEqual(wf.canEditJournal(sectionEditor, 'alstm', BOOTSTRAP), false);
});

test('a managing editor can edit every journal', () => {
  ALL.forEach((c) => assert.strictEqual(wf.canEditJournal(managing, c, BOOTSTRAP), true, c));
});

test('a plain author can edit nothing', () => {
  ALL.forEach((c) => assert.strictEqual(wf.canEditJournal(plainAuthor, c, BOOTSTRAP), false, c));
});

test('a reviewer is not thereby an editor', () => {
  assert.strictEqual(wf.canEditJournal(reviewer, 'alstm', BOOTSTRAP), false);
});

test('an editor role with no journals grants nothing', () => {
  // Strict rather than permissive: an empty list must not mean "all".
  const orphan = { email: 'x@e.edu', roles: ['author', 'editor'], journalRoles: {} };
  ALL.forEach((c) => assert.strictEqual(wf.canEditJournal(orphan, c, BOOTSTRAP), false, c));
});

test('an unknown journal code is refused', () => {
  assert.strictEqual(wf.canEditJournal(managing, 'not-a-journal', BOOTSTRAP), true);
  // Managing editors span everything, but a section editor must not match a
  // code that isn't theirs.
  assert.strictEqual(wf.canEditJournal(sectionEditor, 'not-a-journal', BOOTSTRAP), false);
});

// ---- Lockout safety ----

console.log('\nLockout safety');

test('a bootstrap address is a managing editor even with no roles stored', () => {
  assert.strictEqual(wf.isManagingEditor(bootstrapOwner, BOOTSTRAP), true);
  ALL.forEach((c) => assert.strictEqual(wf.canEditJournal(bootstrapOwner, c, BOOTSTRAP), true, c));
});

test('bootstrap matching is case-insensitive', () => {
  const shouty = { email: 'OWNER@AaranyaScholarly.com', roles: ['author'] };
  assert.strictEqual(wf.isManagingEditor(shouty, BOOTSTRAP), true);
});

test('a bootstrap address survives having its roles wiped', () => {
  // The exact scenario a bad migration would produce.
  const wiped = { email: 'owner@aaranyascholarly.com', roles: [], journalRoles: {} };
  assert.strictEqual(wf.canEditJournal(wiped, 'alstm', BOOTSTRAP), true);
});

test('a non-bootstrap address gets no such protection', () => {
  assert.strictEqual(wf.isManagingEditor(sectionEditor, BOOTSTRAP), false);
});

// ---- Reviewer scope ----

console.log('\nReviewer scope');

test('a reviewer covers only their assigned journals', () => {
  assert.strictEqual(wf.canReviewJournal(reviewer, 'alstm'), true);
  assert.strictEqual(wf.canReviewJournal(reviewer, 'ipsb'), true);
  assert.strictEqual(wf.canReviewJournal(reviewer, 'jec'), false);
});

test('being a managing editor does not make someone a reviewer', () => {
  // Running the journal is not the same as being a subject-matter reviewer.
  assert.strictEqual(wf.canReviewJournal(managing, 'alstm'), false);
});

test('an editor is not automatically a reviewer for their journal', () => {
  assert.strictEqual(wf.canReviewJournal(sectionEditor, 'jec'), false);
});

// ---- Journal lists ----

console.log('\nJournal lists');

test('editableJournals returns all for a managing editor', () => {
  assert.deepStrictEqual(wf.editableJournals(managing, ALL, BOOTSTRAP).sort(), ALL.slice().sort());
});

test('editableJournals returns only the scoped ones for a section editor', () => {
  assert.deepStrictEqual(wf.editableJournals(sectionEditor, ALL, BOOTSTRAP), ['jec']);
});

test('editableJournals is empty for an author', () => {
  assert.deepStrictEqual(wf.editableJournals(plainAuthor, ALL, BOOTSTRAP), []);
});

test('a stale journal code stored against a user is filtered out', () => {
  const stale = {
    email: 'x@e.edu',
    roles: ['author', 'editor'],
    journalRoles: { editor: ['jec', 'retired-journal'] },
  };
  assert.deepStrictEqual(wf.editableJournals(stale, ALL, BOOTSTRAP), ['jec']);
});

// ---- Input sanitising ----

console.log('\nSanitising requested journals');

test('unknown codes are dropped rather than stored', () => {
  assert.deepStrictEqual(wf.sanitiseJournals(['alstm', 'nope', 'jec'], ALL), ['alstm', 'jec']);
});

test('duplicates are collapsed', () => {
  assert.deepStrictEqual(wf.sanitiseJournals(['jec', 'jec', 'jec'], ALL), ['jec']);
});

test('non-array input yields an empty list rather than throwing', () => {
  assert.deepStrictEqual(wf.sanitiseJournals(null, ALL), []);
  assert.deepStrictEqual(wf.sanitiseJournals('jec', ALL), []);
  assert.deepStrictEqual(wf.sanitiseJournals(undefined, ALL), []);
});

test('managing_editor is grantable but not journal-scoped', () => {
  assert.ok(wf.ASSIGNABLE_ROLES.includes('managing_editor'));
  assert.ok(!wf.JOURNAL_SCOPED_ROLES.includes('managing_editor'));
  assert.deepStrictEqual(wf.JOURNAL_SCOPED_ROLES.sort(), ['editor', 'reviewer']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
