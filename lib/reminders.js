// Reminder policy: who is chased, when, and how often.
//
// Deliberately pure -- no database, no email, no clock of its own. Everything
// is passed in, so the whole policy is testable without standing anything up,
// and "why did this person get an email" is answerable by reading one file.
//
// The governing constraint is NOT "remind as much as possible". Reviewers are
// unpaid volunteers; over-chasing them is how a journal trains people to
// filter its mail, after which no reminder works at all. So:
//
//   - a cooldown means nobody hears from us twice in quick succession
//   - a cap means chasing stops rather than continuing forever
//   - once the cap is hit the EDITOR is told, because at that point the
//     problem needs a human decision (chase personally, or replace)
//   - anyone who has completed, declined, or been withdrawn is never chased

const DAY_MS = 24 * 60 * 60 * 1000;

// Defaults, all overridable from config so a journal can tune them without a
// code change.
const DEFAULTS = {
  // Reviewer invited but hasn't accepted or declined.
  inviteReminderDays: [3, 7],
  inviteEscalateDays: 10,

  // Reviewer accepted but the review is past its due date.
  //
  // Escalation must sit strictly AFTER the last reminder, otherwise it fires
  // first and the later milestones become dead code. (Caught by a test: with
  // escalation at 7 and a reminder at 14, the day-14 reminder could never
  // happen.)
  overdueReminderDays: [1, 7],
  overdueEscalateDays: 14,

  // Editor requested revisions but no revised file has arrived.
  revisionReminderDays: [14, 28],
  revisionEscalateDays: 35,

  // Never send the same party two reminders inside this window, whatever
  // the milestones say.
  cooldownHours: 48,

  // Hard ceiling per assignment/submission, so a stuck record can't become
  // a recurring nuisance.
  maxReminders: 3,
};

function daysBetween(from, to) {
  if (!from) return null;
  const a = new Date(from).getTime();
  if (Number.isNaN(a)) return null;
  return Math.floor((to - a) / DAY_MS);
}

// Has the milestone been reached, and not already been used?
// Milestones fire once each: we track the highest one already sent.
function nextMilestone(milestones, elapsedDays, highestSent) {
  if (elapsedDays == null) return null;
  const due = milestones.filter((m) => elapsedDays >= m && m > (highestSent || 0));
  return due.length ? Math.max(...due) : null;
}

function inCooldown(lastReminderAt, now, cooldownHours) {
  if (!lastReminderAt) return false;
  const last = new Date(lastReminderAt).getTime();
  if (Number.isNaN(last)) return false;
  return now - last < cooldownHours * 60 * 60 * 1000;
}

// ---- Review assignments ----
//
// Returns null (leave alone) or a decision object describing what to send.
function assignmentReminder(assignment, now, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const a = assignment || {};

  // Only these two states are ever chased. Completed, declined, and
  // cancelled reviewers are finished with us.
  const chaseable = a.status === 'pending' || a.status === 'accepted';
  if (!chaseable) return null;

  if (inCooldown(a.lastReminderAt, now, cfg.cooldownHours)) return null;

  const sentCount = a.reminderCount || 0;
  const highest = a.highestMilestoneSent || 0;

  if (a.status === 'pending') {
    const elapsed = daysBetween(a.assignedAt, now);

    // Escalate to the editor once chasing has clearly failed.
    if (elapsed != null && elapsed >= cfg.inviteEscalateDays && !a.escalatedAt) {
      return { kind: 'invite_escalate', audience: 'editor', elapsedDays: elapsed };
    }
    if (sentCount >= cfg.maxReminders) return null;

    const milestone = nextMilestone(cfg.inviteReminderDays, elapsed, highest);
    if (milestone == null) return null;
    return { kind: 'invite_reminder', audience: 'reviewer', milestone, elapsedDays: elapsed };
  }

  // status === 'accepted' -- chase only once the due date has passed. An
  // assignment with no due date is never chased; we have no basis to.
  if (!a.dueDate) return null;
  const overdue = daysBetween(a.dueDate, now);
  if (overdue == null || overdue < 1) return null;

  if (overdue >= cfg.overdueEscalateDays && !a.escalatedAt) {
    return { kind: 'overdue_escalate', audience: 'editor', elapsedDays: overdue };
  }
  if (sentCount >= cfg.maxReminders) return null;

  const milestone = nextMilestone(cfg.overdueReminderDays, overdue, highest);
  if (milestone == null) return null;
  return { kind: 'overdue_reminder', audience: 'reviewer', milestone, elapsedDays: overdue };
}

// ---- Author revisions ----

function revisionReminder(submission, now, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const s = submission || {};

  if (!s.awaitingRevision) return null;
  if (inCooldown(s.lastReminderAt, now, cfg.cooldownHours)) return null;

  // Measured from the decision that asked for revisions.
  const since = s.lastDecisionAt || s.submittedAt;
  const elapsed = daysBetween(since, now);
  if (elapsed == null) return null;

  if (elapsed >= cfg.revisionEscalateDays && !s.escalatedAt) {
    return { kind: 'revision_escalate', audience: 'editor', elapsedDays: elapsed };
  }
  if ((s.reminderCount || 0) >= cfg.maxReminders) return null;

  const milestone = nextMilestone(cfg.revisionReminderDays, elapsed, s.highestMilestoneSent || 0);
  if (milestone == null) return null;
  return { kind: 'revision_reminder', audience: 'author', milestone, elapsedDays: elapsed };
}

// The record update to apply after a reminder is actually sent, so the next
// sweep knows not to repeat it.
function bookkeeping(decision, record, nowIso) {
  const patch = { lastReminderAt: nowIso };
  if (decision.audience === 'editor') {
    patch.escalatedAt = nowIso;
  } else {
    patch.reminderCount = (record.reminderCount || 0) + 1;
    patch.highestMilestoneSent = decision.milestone;
  }
  return patch;
}

module.exports = {
  DEFAULTS,
  DAY_MS,
  assignmentReminder,
  revisionReminder,
  bookkeeping,
  // exported for tests
  _internals: { daysBetween, nextMilestone, inCooldown },
};
