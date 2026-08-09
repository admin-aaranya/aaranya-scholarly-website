// Tests for the reminder policy.
//
// The failure mode that matters here is not "a reminder didn't go out" -- it
// is "we chased an unpaid volunteer six times and they now filter our mail".
// So most of these assert that we stay QUIET.

const assert = require('assert');
const R = require('../lib/reminders');

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

const NOW = new Date('2026-08-08T12:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * R.DAY_MS).toISOString();
const daysAhead = (n) => new Date(NOW + n * R.DAY_MS).toISOString();

function invite(overrides = {}) {
  return Object.assign({ status: 'pending', assignedAt: daysAgo(0) }, overrides);
}
function accepted(overrides = {}) {
  return Object.assign(
    { status: 'accepted', assignedAt: daysAgo(10), dueDate: daysAhead(5) },
    overrides
  );
}

// ---- Silence by default ----

console.log('\nStaying quiet when we should');

test('a freshly invited reviewer is not chased', () => {
  assert.strictEqual(R.assignmentReminder(invite(), NOW), null);
});

test('an invitation one day old is not chased', () => {
  assert.strictEqual(R.assignmentReminder(invite({ assignedAt: daysAgo(1) }), NOW), null);
});

test('a review not yet due is not chased', () => {
  assert.strictEqual(R.assignmentReminder(accepted(), NOW), null);
});

test('a review due today is not chased', () => {
  assert.strictEqual(R.assignmentReminder(accepted({ dueDate: daysAgo(0) }), NOW), null);
});

test('a reviewer who already submitted is never chased', () => {
  const a = accepted({ status: 'completed', dueDate: daysAgo(30) });
  assert.strictEqual(R.assignmentReminder(a, NOW), null);
});

test('a reviewer who declined is never chased', () => {
  const a = invite({ status: 'declined', assignedAt: daysAgo(30) });
  assert.strictEqual(R.assignmentReminder(a, NOW), null);
});

test('a withdrawn invitation is never chased', () => {
  const a = invite({ status: 'cancelled', assignedAt: daysAgo(30) });
  assert.strictEqual(R.assignmentReminder(a, NOW), null);
});

test('an accepted review with no due date is never chased', () => {
  // We have no basis to call it late, so we say nothing.
  const a = accepted({ dueDate: '' });
  assert.strictEqual(R.assignmentReminder(a, NOW), null);
});

// ---- Firing when we should ----

console.log('\nChasing when we should');

test('an unanswered invitation is chased at day 3', () => {
  const d = R.assignmentReminder(invite({ assignedAt: daysAgo(3) }), NOW);
  assert.ok(d, 'expected a reminder');
  assert.strictEqual(d.kind, 'invite_reminder');
  assert.strictEqual(d.audience, 'reviewer');
  assert.strictEqual(d.milestone, 3);
});

test('an overdue review is chased the day after it was due', () => {
  const d = R.assignmentReminder(accepted({ dueDate: daysAgo(1) }), NOW);
  assert.ok(d);
  assert.strictEqual(d.kind, 'overdue_reminder');
  assert.strictEqual(d.milestone, 1);
});

test('a several-days-late review jumps to the highest passed milestone, not the first', () => {
  // 7 days late should not start again at day 1.
  const d = R.assignmentReminder(accepted({ dueDate: daysAgo(7) }), NOW);
  assert.strictEqual(d.kind, 'overdue_reminder');
  assert.strictEqual(d.milestone, 7);
});

test('escalation thresholds sit strictly after the last reminder milestone', () => {
  // Otherwise escalation pre-empts the later reminders and they never fire.
  // This invariant is why the overdue escalation moved from 7 days to 14.
  const c = R.DEFAULTS;
  assert.ok(
    c.inviteEscalateDays > Math.max(...c.inviteReminderDays),
    'invite escalation would pre-empt a reminder'
  );
  assert.ok(
    c.overdueEscalateDays > Math.max(...c.overdueReminderDays),
    'overdue escalation would pre-empt a reminder'
  );
  assert.ok(
    c.revisionEscalateDays > Math.max(...c.revisionReminderDays),
    'revision escalation would pre-empt a reminder'
  );
});

test('every configured milestone is actually reachable', () => {
  // Walk time forward and confirm each milestone fires at least once.
  const seen = new Set();
  let a = accepted({ dueDate: daysAgo(0) });
  for (let day = 1; day <= 30; day += 1) {
    const t = NOW + day * R.DAY_MS;
    const d = R.assignmentReminder(a, t);
    if (!d) continue;
    if (d.milestone) seen.add(d.milestone);
    a = Object.assign({}, a, R.bookkeeping(d, a, new Date(t).toISOString()));
  }
  R.DEFAULTS.overdueReminderDays.forEach((m) => {
    assert.ok(seen.has(m), `milestone ${m} never fired — it is dead config`);
  });
});

// ---- Anti-spam: the important part ----

console.log('\nAnti-spam invariants');

test('the same milestone never fires twice', () => {
  const a = invite({ assignedAt: daysAgo(3), highestMilestoneSent: 3, lastReminderAt: daysAgo(5) });
  assert.strictEqual(R.assignmentReminder(a, NOW), null);
});

test('the cooldown blocks a second reminder even when a milestone is due', () => {
  // Day 7 milestone is reached, but we emailed them 6 hours ago.
  const a = invite({
    assignedAt: daysAgo(7),
    highestMilestoneSent: 3,
    lastReminderAt: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(),
  });
  assert.strictEqual(R.assignmentReminder(a, NOW), null);
});

test('once the cooldown expires the next milestone fires', () => {
  const a = invite({
    assignedAt: daysAgo(7),
    highestMilestoneSent: 3,
    lastReminderAt: daysAgo(4),
  });
  const d = R.assignmentReminder(a, NOW);
  assert.ok(d);
  assert.strictEqual(d.milestone, 7);
});

test('the cap stops reviewer reminders entirely', () => {
  const a = accepted({
    dueDate: daysAgo(60),
    reminderCount: 3,
    highestMilestoneSent: 14,
    lastReminderAt: daysAgo(30),
  });
  const d = R.assignmentReminder(a, NOW);
  // Escalation to the editor is allowed; another nag at the reviewer is not.
  assert.ok(!d || d.audience === 'editor', 'reviewer was chased past the cap');
});

test('a reviewer is never chased more than 3 times across a long simulation', () => {
  // Walk 90 days a day at a time, applying the real bookkeeping each send.
  let a = accepted({ dueDate: daysAgo(0) });
  let reviewerEmails = 0;
  let editorEmails = 0;
  for (let day = 1; day <= 90; day += 1) {
    const t = NOW + day * R.DAY_MS;
    const d = R.assignmentReminder(a, t);
    if (!d) continue;
    if (d.audience === 'reviewer') reviewerEmails += 1;
    else editorEmails += 1;
    a = Object.assign({}, a, R.bookkeeping(d, a, new Date(t).toISOString()));
  }
  assert.ok(reviewerEmails <= 3, `reviewer got ${reviewerEmails} emails over 90 days`);
  assert.ok(editorEmails <= 1, `editor got ${editorEmails} escalations`);
});

test('an unanswered invitation over 90 days does not spam either party', () => {
  let a = invite({ assignedAt: daysAgo(0) });
  let reviewerEmails = 0;
  let editorEmails = 0;
  for (let day = 1; day <= 90; day += 1) {
    const t = NOW + day * R.DAY_MS;
    const d = R.assignmentReminder(a, t);
    if (!d) continue;
    if (d.audience === 'reviewer') reviewerEmails += 1;
    else editorEmails += 1;
    a = Object.assign({}, a, R.bookkeeping(d, a, new Date(t).toISOString()));
  }
  assert.ok(reviewerEmails <= 3, `reviewer got ${reviewerEmails}`);
  assert.strictEqual(editorEmails, 1, `editor got ${editorEmails} escalations, expected exactly 1`);
});

// ---- Escalation ----

console.log('\nEscalation to the editor');

test('an unanswered invitation escalates at day 10', () => {
  const d = R.assignmentReminder(
    invite({ assignedAt: daysAgo(10), reminderCount: 2, highestMilestoneSent: 7, lastReminderAt: daysAgo(3) }),
    NOW
  );
  assert.ok(d);
  assert.strictEqual(d.kind, 'invite_escalate');
  assert.strictEqual(d.audience, 'editor');
});

test('escalation happens only once', () => {
  const d = R.assignmentReminder(
    invite({ assignedAt: daysAgo(30), escalatedAt: daysAgo(20), reminderCount: 3, lastReminderAt: daysAgo(20) }),
    NOW
  );
  assert.strictEqual(d, null);
});

test('a badly overdue review escalates to the editor', () => {
  const d = R.assignmentReminder(
    accepted({ dueDate: daysAgo(14), lastReminderAt: daysAgo(5), highestMilestoneSent: 7 }),
    NOW
  );
  assert.ok(d);
  assert.strictEqual(d.audience, 'editor');
  assert.strictEqual(d.kind, 'overdue_escalate');
});

// ---- Author revisions ----

console.log('\nAuthor revision reminders');

test('a submission not awaiting revision is left alone', () => {
  assert.strictEqual(R.revisionReminder({ awaitingRevision: false, lastDecisionAt: daysAgo(60) }, NOW), null);
});

test('a recent revision request is not chased', () => {
  assert.strictEqual(R.revisionReminder({ awaitingRevision: true, lastDecisionAt: daysAgo(3) }, NOW), null);
});

test('an author is chased at 14 days', () => {
  const d = R.revisionReminder({ awaitingRevision: true, lastDecisionAt: daysAgo(14) }, NOW);
  assert.ok(d);
  assert.strictEqual(d.kind, 'revision_reminder');
  assert.strictEqual(d.audience, 'author');
});

test('a long-overdue revision escalates to the editor', () => {
  const d = R.revisionReminder({ awaitingRevision: true, lastDecisionAt: daysAgo(35) }, NOW);
  assert.ok(d);
  assert.strictEqual(d.audience, 'editor');
});

test('an author is never chased more than 3 times over a year', () => {
  let s = { awaitingRevision: true, lastDecisionAt: daysAgo(0) };
  let authorEmails = 0;
  for (let day = 1; day <= 365; day += 1) {
    const t = NOW + day * R.DAY_MS;
    const d = R.revisionReminder(s, t);
    if (!d) continue;
    if (d.audience === 'author') authorEmails += 1;
    s = Object.assign({}, s, R.bookkeeping(d, s, new Date(t).toISOString()));
  }
  assert.ok(authorEmails <= 3, `author got ${authorEmails} emails in a year`);
});

// ---- Bookkeeping ----

console.log('\nBookkeeping');

test('a reviewer send records the milestone and increments the count', () => {
  const patch = R.bookkeeping(
    { audience: 'reviewer', milestone: 7 },
    { reminderCount: 1 },
    '2026-08-08T12:00:00Z'
  );
  assert.strictEqual(patch.reminderCount, 2);
  assert.strictEqual(patch.highestMilestoneSent, 7);
  assert.ok(patch.lastReminderAt);
});

test('an escalation is marked but does not consume a reviewer reminder', () => {
  const patch = R.bookkeeping({ audience: 'editor' }, { reminderCount: 2 }, '2026-08-08T12:00:00Z');
  assert.ok(patch.escalatedAt);
  assert.strictEqual(patch.reminderCount, undefined);
});

test('malformed dates are survived rather than throwing', () => {
  assert.doesNotThrow(() => R.assignmentReminder({ status: 'pending', assignedAt: 'not-a-date' }, NOW));
  assert.strictEqual(R.assignmentReminder({ status: 'pending', assignedAt: 'not-a-date' }, NOW), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
