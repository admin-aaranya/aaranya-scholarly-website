// Notification orchestration -- the single place that answers "who gets an
// email when X happens".
//
// Route handlers call one function from here and do not await it before
// responding. Everything below is best-effort: see the contract at the top of
// lib/mailer.js.

const { EDITOR_EMAILS, EDITORIAL_NOTIFY_EMAILS } = require('../config');
const { findUsersByRole, findUserById } = require('../db');
const mailer = require('./mailer');
const T = require('./email-templates');
const {
  reviewerView,
  authorViewOfReview,
  ASSIGNMENT_STATUS,
  ROLES,
  canEditJournal,
  FILE_KINDS_BY_KEY,
} = require('./workflow');

// Editorial notices go to EDITORIAL_NOTIFY_EMAILS if configured, otherwise to
// the bootstrap editors -- so these are never silently dropped just because
// one env var wasn't set.
//
// This is the journal-agnostic fallback; prefer editorRecipientsFor below.
function editorRecipients() {
  const list = EDITORIAL_NOTIFY_EMAILS.length ? EDITORIAL_NOTIFY_EMAILS : EDITOR_EMAILS;
  return Array.from(new Set(list));
}

// Journal-aware recipients: the editors who actually cover this journal, plus
// managing editors.
//
// This matters now that scoping is enforced. Without it, an ALSTM editor
// would be emailed about a JEC submission they cannot even open -- an alert
// they can do nothing about, which is how people learn to ignore alerts.
//
// Falls back to the configured addresses when a journal has no editor
// assigned yet, so a submission to a new journal is never silently unnoticed.
async function editorRecipientsFor(journalCode) {
  try {
    const [editors, managing] = await Promise.all([
      findUsersByRole(ROLES.EDITOR),
      findUsersByRole(ROLES.MANAGING_EDITOR),
    ]);

    const scoped = editors.filter((u) => canEditJournal(u, journalCode, EDITOR_EMAILS));
    const all = scoped.concat(managing);
    const emails = Array.from(
      new Set(all.map((u) => u && u.email).filter(Boolean))
    );

    // Always include the configured addresses -- they're the safety net, and
    // for a small journal they're usually the same people anyway.
    editorRecipients().forEach((e) => {
      if (!emails.includes(e)) emails.push(e);
    });

    return emails.length ? emails : editorRecipients();
  } catch (err) {
    console.error('[notifications] could not resolve journal editors:', err && err.message);
    return editorRecipients();
  }
}

// Runs a dispatch without letting anything it does reach the caller. Returns
// a promise so tests can await it; routes deliberately don't.
function dispatch(build) {
  return Promise.resolve()
    .then(build)
    .then((messages) => mailer.notify(messages))
    .catch((err) => {
      console.error('[notifications] dispatch failed:', err && err.message);
      return [];
    });
}

// ---- Submission ----

function submissionReceived({ submission, author }) {
  return dispatch(async () => {
    const messages = [];

    if (author && author.email) {
      messages.push(
        mailer.compose({
          to: author.email,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template: T.submissionReceived({
            authorName: author.name,
            title: submission.title,
            journalName: submission.journalName,
            articleType: submission.articleType,
            submissionId: submission.id,
          }),
        })
      );
    }

    (await editorRecipientsFor(submission.journalCode)).forEach((to) => {
      messages.push(
        mailer.compose({
          to,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template: T.newSubmissionForEditor({
            title: submission.title,
            journalName: submission.journalName,
            articleType: submission.articleType,
            authorName: author ? author.name : 'Unknown',
            authorAffiliation: author ? author.affiliation : '',
            submissionId: submission.id,
          }),
        })
      );
    });

    return messages;
  });
}

// ---- Editorial decision ----

// `assignments` are the raw review assignments; they are passed through
// authorViewOfReview here so the author's email can only ever contain the
// anonymized subset. Reviewer comments are included only when the decision
// actually communicates review outcomes -- an author shouldn't receive
// reviewer comments attached to, say, "Send to Production".
const DECISIONS_THAT_SHARE_REVIEWS = new Set([
  'accept',
  'decline',
  'request_revisions',
  'resubmit_for_review',
]);

function decisionRecorded({ submission, author, decision, assignments }) {
  return dispatch(() => {
    if (!author || !author.email) return [];

    const shareReviews = DECISIONS_THAT_SHARE_REVIEWS.has(decision.decision);
    const reviews = shareReviews
      ? (assignments || [])
          .filter((a) => a.round === decision.round && a.status === ASSIGNMENT_STATUS.COMPLETED)
          .map(authorViewOfReview)
          .filter(Boolean)
      : [];

    return [
      mailer.compose({
        to: author.email,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.decisionRecorded({
          authorName: author.name,
          title: submission.title,
          journalName: submission.journalName,
          decisionLabel: decision.decisionLabel,
          statusLabel: submission.status,
          editorNote: decision.note,
          awaitingRevision: Boolean(submission.awaitingRevision),
          round: submission.currentRound,
          submissionId: submission.id,
          reviews,
        }),
      }),
    ];
  });
}

// ---- Revision uploaded ----

// Receipt to the author, and -- the important half -- a nudge to the editors.
// Without the editor notice a requested revision arrives silently and the
// submission waits on someone who doesn't know it's their turn.
function revisionSubmitted({ submission, author, round, note }) {
  return dispatch(async () => {
    const messages = [];

    if (author && author.email) {
      messages.push(
        mailer.compose({
          to: author.email,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template: T.revisionReceived({
            authorName: author.name,
            title: submission.title,
            journalName: submission.journalName,
            round,
            submissionId: submission.id,
          }),
        })
      );
    }

    (await editorRecipientsFor(submission.journalCode)).forEach((to) => {
      messages.push(
        mailer.compose({
          to,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template: T.revisionReceivedForEditor({
            title: submission.title,
            journalName: submission.journalName,
            round,
            note,
            authorName: author ? author.name : 'Unknown',
            submissionId: submission.id,
          }),
        })
      );
    });

    return messages;
  });
}

// ---- Reviewer outcome ----

// Tells the reviewers who actually completed a review what the decision was.
// Only completed reviewers of the relevant round -- someone who declined or
// never responded has no stake in the outcome.
//
// Note the templates receive plain strings, never the submission object, so
// there is structurally no author identity available to leak.
function decisionToReviewers({ submission, decision, assignments, reviewers }) {
  return dispatch(() => {
    const completed = (assignments || []).filter(
      (a) => a.status === ASSIGNMENT_STATUS.COMPLETED
    );
    if (!completed.length) return [];

    const isNewRound = decision.decision === 'resubmit_for_review';

    return completed
      .map((a) => {
        const reviewer = reviewers[a.reviewerId];
        if (!reviewer || !reviewer.email) return null;

        const template = isNewRound
          ? T.newRoundForReviewer({
              reviewerName: reviewer.name,
              title: submission.title,
              journalName: submission.journalName,
              round: submission.currentRound,
            })
          : T.decisionForReviewer({
              reviewerName: reviewer.name,
              title: submission.title,
              journalName: submission.journalName,
              decisionLabel: decision.decisionLabel,
              round: a.round,
            });

        return mailer.compose({
          to: reviewer.email,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template,
        });
      })
      .filter(Boolean);
  });
}

// ---- Review assignment ----

function reviewerInvited({ submission, reviewer, assignment }) {
  return dispatch(() => {
    if (!reviewer || !reviewer.email) return [];
    return [
      mailer.compose({
        to: reviewer.email,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.reviewInvitation({
          reviewerName: reviewer.name,
          // Anonymized by construction -- the template never sees the raw
          // submission, so it cannot render author identity.
          submission: reviewerView(submission),
          journalName: submission.journalName,
          round: assignment.round,
          dueDate: assignment.dueDate,
          assignmentId: assignment.id,
        }),
      }),
    ];
  });
}

function invitationWithdrawn({ submission, reviewer }) {
  return dispatch(() => {
    if (!reviewer || !reviewer.email) return [];
    return [
      mailer.compose({
        to: reviewer.email,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.invitationWithdrawn({
          reviewerName: reviewer.name,
          title: submission.title,
          journalName: submission.journalName,
        }),
      }),
    ];
  });
}

function invitationAnswered({ submission, reviewer, accepted, reason }) {
  return dispatch(async () =>
    (await editorRecipientsFor(submission.journalCode)).map((to) =>
      mailer.compose({
        to,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.invitationResponseForEditor({
          title: submission.title,
          journalName: submission.journalName,
          reviewerName: reviewer.name,
          accepted,
          reason,
          submissionId: submission.id,
        }),
      })
    )
  );
}

function reviewSubmitted({ submission, reviewer, assignment, outstanding }) {
  return dispatch(async () => {
    const messages = [];

    // Thank-you to the reviewer.
    if (reviewer && reviewer.email) {
      messages.push(
        mailer.compose({
          to: reviewer.email,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template: T.reviewThanks({
            reviewerName: reviewer.name,
            title: submission.title,
            journalName: submission.journalName,
            recommendation: assignment.recommendation,
          }),
        })
      );
    }

    // Editors get the substance -- including the reviewer's identity, which
    // is theirs alone to see.
    (await editorRecipientsFor(submission.journalCode)).forEach((to) => {
      messages.push(
        mailer.compose({
          to,
          journalCode: submission.journalCode,
          journalName: submission.journalName,
          template: T.reviewSubmittedForEditor({
            title: submission.title,
            journalName: submission.journalName,
            reviewerName: reviewer ? reviewer.name : 'Unknown reviewer',
            recommendation: assignment.recommendation,
            round: assignment.round,
            outstanding,
            submissionId: submission.id,
          }),
        })
      );
    });

    return messages;
  });
}

// ---- Account ----

// Welcome email on registration. `journals` is the code->name map from
// routes/auth.js, passed in so this module doesn't have to import a route.
function accountCreated({ user, journals }) {
  return dispatch(() => {
    if (!user || !user.email) return [];
    return [
      mailer.compose({
        to: user.email,
        template: T.accountCreated({
          name: user.name,
          email: user.email,
          affiliation: user.affiliation,
          journalInterest: user.journalInterest,
          journals,
        }),
      }),
    ];
  });
}

function roleGranted({ user, role }) {
  return dispatch(() => {
    if (!user || !user.email) return [];
    return [
      mailer.compose({
        to: user.email,
        template: T.roleGranted({ name: user.name, role }),
      }),
    ];
  });
}

// ---- Copyediting, production and publication ----

// An editor shared a file and flagged it as needing the author's response.
function copyeditingFileShared({ submission, entry }) {
  return dispatch(async () => {
    const author = await findUserById(submission.userId);
    if (!author || !author.email) return [];
    return [
      mailer.compose({
        to: author.email,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.copyeditingFileShared({
          authorName: author.name,
          title: submission.title,
          journalName: submission.journalName,
          kindLabel: (FILE_KINDS_BY_KEY[entry.kind] || {}).label || entry.kind,
          note: entry.note || '',
          submissionId: submission.id,
        }),
      }),
    ];
  });
}

// The author answered. Unlike the editor->author direction this is never
// silent: a response sitting unnoticed is exactly the stall the revision
// notice was added to prevent.
function authorFileUploaded({ submission, author, entry }) {
  return dispatch(async () => {
    const recipients = await editorRecipientsFor(submission.journalCode);
    return recipients.map((to) =>
      mailer.compose({
        to,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.authorFileReceivedForEditor({
          title: submission.title,
          journalName: submission.journalName,
          kindLabel: (FILE_KINDS_BY_KEY[entry.kind] || {}).label || entry.kind,
          authorName: author ? author.name : 'Unknown',
          note: entry.note || '',
          submissionId: submission.id,
        }),
      })
    );
  });
}

// Sent when the issue carrying an article is released, not when the editor
// records the Publish decision -- an article in an unreleased issue is not
// yet visible, and an email pointing at a page the author cannot open is
// worse than no email.
function articlePublished({ submission, issueLabel, articleUrl }) {
  return dispatch(async () => {
    const author = await findUserById(submission.userId);
    if (!author || !author.email) return [];
    return [
      mailer.compose({
        to: author.email,
        journalCode: submission.journalCode,
        journalName: submission.journalName,
        template: T.articlePublished({
          authorName: author.name,
          title: submission.title,
          journalName: submission.journalName,
          issueLabel,
          pages: submission.pages || '',
          doi: submission.doi || '',
          articleUrl,
        }),
      }),
    ];
  });
}

module.exports = {
  editorRecipients,
  submissionReceived,
  decisionRecorded,
  reviewerInvited,
  invitationWithdrawn,
  invitationAnswered,
  reviewSubmitted,
  revisionSubmitted,
  decisionToReviewers,
  accountCreated,
  roleGranted,
  copyeditingFileShared,
  authorFileUploaded,
  articlePublished,
};
