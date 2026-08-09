// Runs the reminder policy over everything and sends what's due.
//
// Split from lib/reminders.js on purpose: that file decides WHO and WHEN with
// no I/O, this one does the fetching and sending. Keeping the decision logic
// pure is what makes the anti-spam rules testable.

const {
  getAllReviewAssignments,
  getSubmissions,
  getSubmissionById,
  findUserById,
  updateReviewAssignment,
  updateSubmission,
} = require('../db');
const mailer = require('./mailer');
const T = require('./email-templates');
const reminders = require('./reminders');
const { editorRecipients } = require('./notifications');

// Builds the message for a decision. Returns null when we can't (missing
// person, deleted submission) rather than guessing.
function buildMessages(decision, context) {
  const { submission, reviewer, author } = context;
  if (!submission) return [];

  const common = { journalCode: submission.journalCode, journalName: submission.journalName };

  switch (decision.kind) {
    case 'invite_reminder':
      if (!reviewer || !reviewer.email) return [];
      return [
        mailer.compose({
          to: reviewer.email,
          ...common,
          template: T.reviewInvitationReminder({
            reviewerName: reviewer.name,
            title: submission.title,
            journalName: submission.journalName,
            daysWaiting: decision.elapsedDays,
            assignmentId: context.assignment.id,
          }),
        }),
      ];

    case 'overdue_reminder':
      if (!reviewer || !reviewer.email) return [];
      return [
        mailer.compose({
          to: reviewer.email,
          ...common,
          template: T.reviewOverdueReminder({
            reviewerName: reviewer.name,
            title: submission.title,
            journalName: submission.journalName,
            daysOverdue: decision.elapsedDays,
            dueDate: context.assignment.dueDate,
            assignmentId: context.assignment.id,
          }),
        }),
      ];

    case 'revision_reminder':
      if (!author || !author.email) return [];
      return [
        mailer.compose({
          to: author.email,
          ...common,
          template: T.revisionOverdueReminder({
            authorName: author.name,
            title: submission.title,
            journalName: submission.journalName,
            daysWaiting: decision.elapsedDays,
            submissionId: submission.id,
          }),
        }),
      ];

    case 'invite_escalate':
    case 'overdue_escalate':
    case 'revision_escalate': {
      const person = decision.kind === 'revision_escalate' ? author : reviewer;
      return editorRecipients().map((to) =>
        mailer.compose({
          to,
          ...common,
          template: T.reminderEscalation({
            kind: decision.kind,
            title: submission.title,
            journalName: submission.journalName,
            personName: person ? person.name : 'Unknown',
            personEmail: person ? person.email : '',
            days: decision.elapsedDays,
            submissionId: submission.id,
          }),
        })
      );
    }

    default:
      return [];
  }
}

// dryRun reports what WOULD be sent without sending or recording anything.
// Worth having: the first live run of something that emails real people is
// exactly when you want to look before you leap.
async function run({ now = Date.now(), dryRun = false, config = {} } = {}) {
  const nowIso = new Date(now).toISOString();
  const results = { checkedAssignments: 0, checkedSubmissions: 0, actions: [], sent: 0, failed: 0 };

  // --- review assignments ---
  const assignments = await getAllReviewAssignments();
  results.checkedAssignments = assignments.length;

  for (const assignment of assignments) {
    const decision = reminders.assignmentReminder(assignment, now, config);
    if (!decision) continue;

    const [submission, reviewer] = await Promise.all([
      getSubmissionById(assignment.submissionId),
      findUserById(assignment.reviewerId),
    ]);

    const action = {
      kind: decision.kind,
      audience: decision.audience,
      days: decision.elapsedDays,
      title: submission ? submission.title : '(missing submission)',
      to: decision.audience === 'editor' ? editorRecipients().join(', ') : (reviewer && reviewer.email) || '(unknown)',
    };

    if (dryRun) {
      results.actions.push(Object.assign({ dryRun: true }, action));
      continue;
    }

    const messages = buildMessages(decision, { submission, reviewer, assignment });
    if (!messages.length) continue;

    const stubs = await mailer.notify(messages);
    const ok = stubs.filter((s) => s.status === 'sent' || s.status === 'logged').length;
    results.sent += ok;
    results.failed += stubs.length - ok;

    // Only record the reminder as delivered if something actually went out.
    // Otherwise a mail outage would silently burn a reviewer's reminder
    // allowance without them ever hearing from us.
    if (ok) {
      await updateReviewAssignment(
        assignment.id,
        reminders.bookkeeping(decision, assignment, nowIso)
      );
    }
    results.actions.push(Object.assign({ sent: ok }, action));
  }

  // --- author revisions ---
  const submissions = await getSubmissions();
  results.checkedSubmissions = submissions.length;

  for (const submission of submissions) {
    const decision = reminders.revisionReminder(submission, now, config);
    if (!decision) continue;

    const author = await findUserById(submission.userId);
    const action = {
      kind: decision.kind,
      audience: decision.audience,
      days: decision.elapsedDays,
      title: submission.title,
      to: decision.audience === 'editor' ? editorRecipients().join(', ') : (author && author.email) || '(unknown)',
    };

    if (dryRun) {
      results.actions.push(Object.assign({ dryRun: true }, action));
      continue;
    }

    const messages = buildMessages(decision, { submission, author });
    if (!messages.length) continue;

    const stubs = await mailer.notify(messages);
    const ok = stubs.filter((s) => s.status === 'sent' || s.status === 'logged').length;
    results.sent += ok;
    results.failed += stubs.length - ok;

    if (ok) {
      await updateSubmission(submission.id, reminders.bookkeeping(decision, submission, nowIso));
    }
    results.actions.push(Object.assign({ sent: ok }, action));
  }

  return results;
}

module.exports = { run, buildMessages };
