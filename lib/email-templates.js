// Email templates.
//
// ANONYMITY IS ENFORCED BY THE FUNCTION SIGNATURES HERE, not by remembering
// to leave fields out. The reviewer-facing templates accept only the
// already-anonymized shape produced by workflow.reviewerView(), and the
// author-facing decision template accepts only workflow.authorViewOfReview()
// output. Neither can render an identity it was never handed.
//
// Every template returns { name, subject, text, html }. Plain text is not an
// afterthought: some reviewers read mail in clients that block HTML, and a
// text/plain part materially improves deliverability.

const { SITE_URL } = require('../config');
const { RECOMMENDATIONS, STAGE_LABELS } = require('./workflow');

// ---- Rendering helpers ----

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function url(path) {
  return `${SITE_URL}/${String(path).replace(/^\/+/, '')}`;
}

function fmtDate(d) {
  if (!d) return '';
  const parsed = new Date(d);
  if (isNaN(parsed)) return String(d);
  return parsed.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Shared HTML shell. Inline styles only -- every mail client strips <style>.
function layout({ heading, journalName, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#22303a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f9;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border:1px solid #e1e6ea;border-radius:10px;overflow:hidden;">
        <tr><td style="background:#0b3350;padding:20px 28px;">
          <div style="color:#ffffff;font-family:Georgia,serif;font-size:19px;letter-spacing:.04em;">AARANYA SCHOLARLY</div>
          ${journalName ? `<div style="color:#a9c4d4;font-size:12px;margin-top:3px;">${esc(journalName)}</div>` : ''}
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:20px;color:#082638;">${esc(heading)}</h1>
          ${bodyHtml}
          ${ctaUrl ? `<div style="margin:26px 0 6px;">
            <a href="${esc(ctaUrl)}" style="display:inline-block;background:#c8912a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:4px;">${esc(ctaLabel)}</a>
          </div>
          <div style="font-size:11.5px;color:#5c6b76;margin-top:10px;">Or paste this into your browser:<br><span style="color:#0f5d73;">${esc(ctaUrl)}</span></div>` : ''}
        </td></tr>
        <tr><td style="background:#f4f7f9;border-top:1px solid #e1e6ea;padding:16px 28px;font-size:11.5px;color:#5c6b76;">
          ${footerNote ? `<div style="margin-bottom:8px;">${footerNote}</div>` : ''}
          <div>© ${new Date().getFullYear()} Aaranya Scholarly LLP. This is an automated message from the editorial system.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function p(text) {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#22303a;">${text}</p>`;
}

function factBox(rows) {
  const cells = rows
    .filter((r) => r[1])
    .map(
      ([k, v]) =>
        `<tr><td style="padding:5px 0;font-size:12px;color:#5c6b76;width:130px;vertical-align:top;">${esc(k)}</td>
          <td style="padding:5px 0;font-size:13px;color:#22303a;">${esc(v)}</td></tr>`
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7f9;border:1px solid #e1e6ea;border-radius:6px;padding:12px 14px;margin:0 0 16px;">${cells}</table>`;
}

function quote(text) {
  return `<div style="border-left:3px solid #c8912a;background:#fffdf5;padding:12px 14px;margin:0 0 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;color:#22303a;">${esc(text)}</div>`;
}

// ---- Author templates ----

// Sent on submission. Confirms receipt and sets expectations.
function submissionReceived({ authorName, title, journalName, articleType, submissionId }) {
  const link = url(`submission.html?id=${submissionId}`);
  return {
    name: 'submission_received',
    subject: `Submission received: ${title}`,
    text: `Dear ${authorName},

Thank you for submitting your manuscript to ${journalName}.

Title: ${title}
Article type: ${articleType}

Your manuscript is now with the editorial office for initial screening. You
will be notified by email when there is a decision or when any action is
needed from you. You can track its progress at any time here:

${link}

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Submission received',
      journalName,
      bodyHtml:
        p(`Dear ${esc(authorName)},`) +
        p(`Thank you for submitting your manuscript to <b>${esc(journalName)}</b>.`) +
        factBox([['Title', title], ['Article type', articleType]]) +
        p(
          'Your manuscript is now with the editorial office for initial screening. We will email you when there is a decision or when we need something from you.'
        ),
      ctaLabel: 'Track your submission',
      ctaUrl: link,
    }),
  };
}

// Sent whenever an editor records a decision. `reviews` must already be
// anonymized (workflow.authorViewOfReview) -- this template will render
// whatever it is given, so passing raw assignments here would leak reviewer
// identities. The tests assert that it does not.
function decisionRecorded({
  authorName,
  title,
  journalName,
  decisionLabel,
  statusLabel,
  editorNote,
  awaitingRevision,
  round,
  submissionId,
  reviews,
}) {
  const link = url(`submission.html?id=${submissionId}`);
  const anonReviews = (reviews || []).filter(Boolean);

  const reviewsText = anonReviews.length
    ? '\n\nReviewer comments:\n' +
      anonReviews
        .map(
          (r, i) =>
            `\n--- Reviewer ${i + 1} (${RECOMMENDATIONS[r.recommendation] || r.recommendation}) ---\n${r.commentsForAuthor}`
        )
        .join('\n')
    : '';

  const actionText = awaitingRevision
    ? `\n\nWhat happens next: please upload your revised manuscript${round ? ` for round ${round}` : ''} using the link below. Your submission will not proceed until the revision is received.`
    : '';

  const reviewsHtml = anonReviews.length
    ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5c6b76;font-weight:700;margin:22px 0 10px;">Reviewer comments</div>` +
      anonReviews
        .map(
          (r, i) =>
            `<div style="margin-bottom:14px;"><div style="font-size:13px;font-weight:700;color:#082638;margin-bottom:6px;">Reviewer ${i + 1} — <span style="color:#a97418;">${esc(RECOMMENDATIONS[r.recommendation] || r.recommendation)}</span></div>${quote(r.commentsForAuthor)}</div>`
        )
        .join('')
    : '';

  return {
    name: 'decision_recorded',
    subject: `Editorial decision — ${title}`,
    text: `Dear ${authorName},

An editorial decision has been recorded on your manuscript submitted to
${journalName}.

Title: ${title}
Decision: ${decisionLabel}
Current status: ${statusLabel}${editorNote ? `\n\nNote from the editor:\n${editorNote}` : ''}${actionText}${reviewsText}

Full details, including any files, are available here:

${link}

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Editorial decision',
      journalName,
      bodyHtml:
        p(`Dear ${esc(authorName)},`) +
        p(`An editorial decision has been recorded on your manuscript submitted to <b>${esc(journalName)}</b>.`) +
        factBox([
          ['Title', title],
          ['Decision', decisionLabel],
          ['Current status', statusLabel],
        ]) +
        (editorNote
          ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5c6b76;font-weight:700;margin:0 0 8px;">Note from the editor</div>${quote(editorNote)}`
          : '') +
        (awaitingRevision
          ? p(
              `<b>Action needed:</b> please upload your revised manuscript${round ? ` for round ${round}` : ''} using the button below. Your submission will not proceed until we receive it.`
            )
          : '') +
        reviewsHtml,
      ctaLabel: awaitingRevision ? 'Upload your revision' : 'View your submission',
      ctaUrl: link,
      footerNote: anonReviews.length
        ? 'Peer review at Aaranya Scholarly is double-anonymous: reviewer identities are not disclosed to authors.'
        : '',
    }),
  };
}

// ---- Reviewer templates ----

// The invitation. `submission` MUST be the output of workflow.reviewerView()
// — it has no author fields on it at all, which is what keeps this template
// honest.
function reviewInvitation({ reviewerName, submission, journalName, round, dueDate, assignmentId }) {
  const link = url(`review.html?id=${assignmentId}`);
  return {
    name: 'review_invitation',
    subject: `Invitation to review: ${submission.title}`,
    text: `Dear ${reviewerName},

You have been invited to review a manuscript submitted to ${journalName}.

Title: ${submission.title}
Article type: ${submission.articleType}${submission.subjectArea ? `\nSubject area: ${submission.subjectArea}` : ''}
Review round: ${round}${dueDate ? `\nReview due: ${fmtDate(dueDate)}` : ''}

Abstract:
${submission.abstract}

Please accept or decline this invitation using the link below. Once you
accept, you will be able to download the manuscript and submit your review.

${link}

This journal operates double-anonymous peer review: you will not see the
authors' identities, and they will not see yours.

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Invitation to review',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`You have been invited to review a manuscript submitted to <b>${esc(journalName)}</b>.`) +
        factBox([
          ['Title', submission.title],
          ['Article type', submission.articleType],
          ['Subject area', submission.subjectArea],
          ['Review round', String(round)],
          ['Review due', dueDate ? fmtDate(dueDate) : ''],
        ]) +
        `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5c6b76;font-weight:700;margin:0 0 8px;">Abstract</div>` +
        quote(submission.abstract) +
        p('Please accept or decline using the button below. Once you accept, you can download the manuscript and submit your review.'),
      ctaLabel: 'Accept or decline',
      ctaUrl: link,
      footerNote:
        'This journal operates <b>double-anonymous</b> peer review: you will not see the authors’ identities, and they will not see yours.',
    }),
  };
}

function invitationWithdrawn({ reviewerName, title, journalName }) {
  return {
    name: 'invitation_withdrawn',
    subject: `Review invitation withdrawn: ${title}`,
    text: `Dear ${reviewerName},

The editor has withdrawn the invitation for you to review the following
manuscript submitted to ${journalName}:

${title}

No action is needed from you, and the manuscript is no longer available in
your reviewer dashboard. Thank you for your time.

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Review invitation withdrawn',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`The editor has withdrawn the invitation for you to review the following manuscript submitted to <b>${esc(journalName)}</b>:`) +
        factBox([['Title', title]]) +
        p('No action is needed from you. Thank you for your time.'),
    }),
  };
}

function reviewThanks({ reviewerName, title, journalName, recommendation }) {
  return {
    name: 'review_thanks',
    subject: `Thank you for your review: ${title}`,
    text: `Dear ${reviewerName},

Thank you for completing your review of the following manuscript submitted to
${journalName}:

${title}
Your recommendation: ${RECOMMENDATIONS[recommendation] || recommendation}

Your review has been passed to the editor, who will weigh it alongside the
other reviews in reaching a decision. We are grateful for the time you gave
to this.

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Thank you for your review',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`Thank you for completing your review of the following manuscript submitted to <b>${esc(journalName)}</b>:`) +
        factBox([
          ['Title', title],
          ['Your recommendation', RECOMMENDATIONS[recommendation] || recommendation],
        ]) +
        p('Your review has been passed to the editor, who will weigh it alongside the other reviews in reaching a decision. We are grateful for the time you gave to this.'),
    }),
  };
}

// ---- Revision templates ----

// To the author: confirms the upload actually landed. Authors otherwise have
// no way to know whether a large file made it, and a silent upload is a
// common source of "did you get my revision?" emails.
function revisionReceived({ authorName, title, journalName, round, submissionId }) {
  const link = url(`submission.html?id=${submissionId}`);
  return {
    name: 'revision_received',
    subject: `Revision received: ${title}`,
    text: `Dear ${authorName},

We have received your revised manuscript.

Title: ${title}${round ? `\nReview round: ${round}` : ''}

It is now back with the editorial office. You will be emailed when there is a
decision or if anything further is needed.

${link}

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Revision received',
      journalName,
      bodyHtml:
        p(`Dear ${esc(authorName)},`) +
        p('We have received your revised manuscript. It is now back with the editorial office.') +
        factBox([['Title', title], ['Review round', round ? String(round) : '']]) +
        p('You will be emailed when there is a decision or if anything further is needed.'),
      ctaLabel: 'View your submission',
      ctaUrl: link,
    }),
  };
}

// To the editors: without this, a requested revision arrives and nobody
// knows. The submission then waits on an editor who has no idea it is their
// turn -- the single worst kind of workflow stall, because nothing looks
// broken.
function revisionReceivedForEditor({ title, journalName, round, note, authorName, submissionId }) {
  const link = url(`editor-submission.html?id=${submissionId}`);
  return {
    name: 'revision_received_editor',
    subject: `Revision submitted — ${title}`,
    text: `A revised manuscript has been submitted and is awaiting editorial review.

Title: ${title}
Author: ${authorName}${round ? `\nReview round: ${round}` : ''}${note ? `\n\nAuthor's response to reviewers:\n${note}` : ''}

Open it in the editorial dashboard:
${link}`,
    html: layout({
      heading: 'Revision submitted',
      journalName,
      bodyHtml:
        p('A revised manuscript has been submitted and is <b>awaiting editorial review</b>.') +
        factBox([
          ['Title', title],
          ['Author', authorName],
          ['Review round', round ? String(round) : ''],
        ]) +
        (note
          ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5c6b76;font-weight:700;margin:0 0 8px;">Author's response to reviewers</div>${quote(note)}`
          : ''),
      ctaLabel: 'Open in editorial dashboard',
      ctaUrl: link,
    }),
  };
}

// ---- Reviewer outcome templates ----
//
// Both of these go to reviewers, so they must carry NO author identity. They
// are built from plain strings the caller supplies -- deliberately never from
// a submission object, so there is nothing to leak by accident.

// Closes the loop for someone who gave hours to a review and would otherwise
// never learn what happened. Deliberately the decision only: no author names,
// no other reviewers' comments, no editor's note.
function decisionForReviewer({ reviewerName, title, journalName, decisionLabel, round }) {
  return {
    name: 'decision_for_reviewer',
    subject: `Outcome of a manuscript you reviewed — ${journalName}`,
    text: `Dear ${reviewerName},

Thank you again for reviewing for ${journalName}. An editorial decision has
now been made on the manuscript you reviewed.

Title: ${title}${round ? `\nReview round: ${round}` : ''}
Decision: ${decisionLabel}

Your assessment was one of the inputs the editor weighed. We are grateful for
the time you gave it.

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Outcome of a manuscript you reviewed',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`Thank you again for reviewing for <b>${esc(journalName)}</b>. An editorial decision has now been made on the manuscript you reviewed.`) +
        factBox([
          ['Title', title],
          ['Review round', round ? String(round) : ''],
          ['Decision', decisionLabel],
        ]) +
        p('Your assessment was one of the inputs the editor weighed. We are grateful for the time you gave it.'),
      footerNote:
        'Peer review here is double-anonymous, so author identities are not disclosed to reviewers.',
    }),
  };
}

// When major revisions send a manuscript into a fresh round, the previous
// round's reviewers are told -- both as a courtesy and so a follow-up
// invitation isn't a surprise.
function newRoundForReviewer({ reviewerName, title, journalName, round }) {
  return {
    name: 'new_round_for_reviewer',
    subject: `A manuscript you reviewed is being revised — ${journalName}`,
    text: `Dear ${reviewerName},

The editor has asked the authors to revise a manuscript you reviewed for
${journalName}, and a new review round has opened.

Title: ${title}
New review round: ${round}

You may be invited to review the revised version. If so, you will receive a
separate invitation which you can accept or decline.

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'A manuscript you reviewed is being revised',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`The editor has asked the authors to revise a manuscript you reviewed for <b>${esc(journalName)}</b>, and a new review round has opened.`) +
        factBox([['Title', title], ['New review round', String(round)]]) +
        p('You may be invited to review the revised version. If so, you will receive a separate invitation which you can accept or decline.'),
      footerNote:
        'Peer review here is double-anonymous, so author identities are not disclosed to reviewers.',
    }),
  };
}

// ---- Reminder templates ----
//
// Tone matters more here than anywhere else in this file. Reviewers are
// unpaid volunteers doing a favour; a reminder that reads as a demand is how
// you lose them. These stay short, apologise for the nudge, and always offer
// the option to decline rather than implying the only acceptable answer is
// yes.

function reviewInvitationReminder({ reviewerName, title, journalName, daysWaiting, assignmentId }) {
  const link = url(`review.html?id=${assignmentId}`);
  return {
    name: 'invite_reminder',
    subject: `Reminder: invitation to review — ${title}`,
    text: `Dear ${reviewerName},

A gentle reminder that you have an outstanding invitation to review for
${journalName}. We sent it ${daysWaiting} days ago.

Title: ${title}

If you are able to review, please accept using the link below. If you are
not — because of time, or because it sits outside your area — declining is
genuinely helpful too, as it lets the editor approach someone else without
further delay.

${link}

With thanks for your time either way,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'A reminder about a review invitation',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`A gentle reminder that you have an outstanding invitation to review for <b>${esc(journalName)}</b>, sent ${esc(String(daysWaiting))} days ago.`) +
        factBox([['Title', title]]) +
        p('If you are able to review, please accept below. If you are not — time, or subject fit — <b>declining is genuinely helpful too</b>: it lets the editor approach someone else without further delay.'),
      ctaLabel: 'Accept or decline',
      ctaUrl: link,
      footerNote: 'With thanks for your time either way.',
    }),
  };
}

function reviewOverdueReminder({ reviewerName, title, journalName, daysOverdue, dueDate, assignmentId }) {
  const link = url(`review.html?id=${assignmentId}`);
  return {
    name: 'overdue_reminder',
    subject: `Reminder: review due — ${title}`,
    text: `Dear ${reviewerName},

Thank you again for agreeing to review the following manuscript for
${journalName}. Its review was due on ${fmtDate(dueDate)}, ${daysOverdue} day(s) ago.

Title: ${title}

We know reviewing takes real time and that other commitments intervene. If
you still expect to complete it, no reply is needed — just submit when you
can. If circumstances have changed, please let the editor know so the
manuscript can be reassigned rather than left waiting.

${link}

With thanks,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'A reminder about a review',
      journalName,
      bodyHtml:
        p(`Dear ${esc(reviewerName)},`) +
        p(`Thank you again for agreeing to review for <b>${esc(journalName)}</b>. This review was due on <b>${esc(fmtDate(dueDate))}</b>.`) +
        factBox([['Title', title], ['Days overdue', String(daysOverdue)]]) +
        p('We know reviewing takes real time and that other commitments intervene. If you still expect to complete it, no reply is needed — just submit when you can. If circumstances have changed, please tell the editor so the manuscript can be reassigned rather than left waiting.'),
      ctaLabel: 'Open your review',
      ctaUrl: link,
    }),
  };
}

function revisionOverdueReminder({ authorName, title, journalName, daysWaiting, submissionId }) {
  const link = url(`submission.html?id=${submissionId}`);
  return {
    name: 'revision_reminder',
    subject: `Reminder: revisions awaited — ${title}`,
    text: `Dear ${authorName},

The editor requested revisions to your manuscript ${daysWaiting} days ago and
we have not yet received a revised version.

Title: ${title}

There is no deadline pressure from us — but the manuscript cannot progress
until the revision arrives. If you need longer, or have decided to withdraw,
please let the editorial office know either way.

${link}

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Revisions awaited',
      journalName,
      bodyHtml:
        p(`Dear ${esc(authorName)},`) +
        p(`The editor requested revisions to your manuscript ${esc(String(daysWaiting))} days ago, and we have not yet received a revised version.`) +
        factBox([['Title', title]]) +
        p('There is no deadline pressure from us — but the manuscript cannot progress until the revision arrives. If you need longer, or have decided to withdraw, please let the editorial office know either way.'),
      ctaLabel: 'Upload your revision',
      ctaUrl: link,
    }),
  };
}

// Escalations. These go to editors, so they may name the reviewer -- and
// should, because the editor now has to make a human decision.
function reminderEscalation({ kind, title, journalName, personName, personEmail, days, submissionId }) {
  const link = url(`editor-submission.html?id=${submissionId}`);

  const what = {
    invite_escalate: {
      heading: 'Reviewer has not responded',
      line: `${personName} has not responded to a review invitation in ${days} days, despite reminders.`,
      advice: 'You may want to withdraw the invitation and approach someone else.',
    },
    overdue_escalate: {
      heading: 'Review is significantly overdue',
      line: `${personName}'s review is ${days} days overdue, despite reminders.`,
      advice: 'You may want to contact them directly, or reassign the manuscript.',
    },
    revision_escalate: {
      heading: 'Revision not received',
      line: `${personName} was asked for revisions ${days} days ago and nothing has arrived, despite reminders.`,
      advice: 'You may want to contact the author directly, or decline the submission.',
    },
  }[kind] || { heading: 'Needs attention', line: '', advice: '' };

  return {
    name: kind,
    subject: `Needs your attention: ${title}`,
    text: `${what.line}

Title: ${title}
Person: ${personName}${personEmail ? ` (${personEmail})` : ''}

${what.advice}

Automated reminders have stopped for this one — further chasing is now a
human decision rather than something the system should keep doing.

${link}`,
    html: layout({
      heading: what.heading,
      journalName,
      bodyHtml:
        p(esc(what.line)) +
        factBox([
          ['Title', title],
          ['Person', personName + (personEmail ? ` (${personEmail})` : '')],
        ]) +
        p(esc(what.advice)) +
        p('<i>Automated reminders have stopped for this one — further chasing is now a human decision rather than something the system should keep doing.</i>'),
      ctaLabel: 'Open in editorial dashboard',
      ctaUrl: link,
    }),
  };
}

// ---- Editor templates ----
// Editors are the one party who see everything, so these may carry both
// author and reviewer identities.

function newSubmissionForEditor({ title, journalName, articleType, authorName, authorAffiliation, submissionId }) {
  const link = url(`editor-submission.html?id=${submissionId}`);
  return {
    name: 'new_submission_editor',
    subject: `New submission: ${title}`,
    text: `A new manuscript has been submitted to ${journalName} and is awaiting
initial editorial screening.

Title: ${title}
Article type: ${articleType}
Submitted by: ${authorName}${authorAffiliation ? ` (${authorAffiliation})` : ''}

Open it in the editorial dashboard:
${link}`,
    html: layout({
      heading: 'New submission awaiting screening',
      journalName,
      bodyHtml:
        p(`A new manuscript has been submitted to <b>${esc(journalName)}</b> and is awaiting initial editorial screening.`) +
        factBox([
          ['Title', title],
          ['Article type', articleType],
          ['Submitted by', authorName + (authorAffiliation ? ` (${authorAffiliation})` : '')],
        ]),
      ctaLabel: 'Open in editorial dashboard',
      ctaUrl: link,
    }),
  };
}

function reviewSubmittedForEditor({ title, journalName, reviewerName, recommendation, round, outstanding, submissionId }) {
  const link = url(`editor-submission.html?id=${submissionId}`);
  return {
    name: 'review_submitted_editor',
    subject: `Review received (${RECOMMENDATIONS[recommendation] || recommendation}): ${title}`,
    text: `A review has been submitted for a manuscript in ${journalName}.

Title: ${title}
Reviewer: ${reviewerName}
Recommendation: ${RECOMMENDATIONS[recommendation] || recommendation}
Review round: ${round}
Still outstanding this round: ${outstanding}

Read the review and record a decision:
${link}`,
    html: layout({
      heading: 'Review received',
      journalName,
      bodyHtml:
        p(`A review has been submitted for a manuscript in <b>${esc(journalName)}</b>.`) +
        factBox([
          ['Title', title],
          ['Reviewer', reviewerName],
          ['Recommendation', RECOMMENDATIONS[recommendation] || recommendation],
          ['Review round', String(round)],
          ['Still outstanding', String(outstanding)],
        ]) +
        (outstanding === 0
          ? p('<b>All reviews for this round are now in.</b> The manuscript is ready for an editorial decision.')
          : ''),
      ctaLabel: 'Read the review',
      ctaUrl: link,
    }),
  };
}

function invitationResponseForEditor({ title, journalName, reviewerName, accepted, reason, submissionId }) {
  const link = url(`editor-submission.html?id=${submissionId}`);
  return {
    name: 'invitation_response_editor',
    subject: `Reviewer ${accepted ? 'accepted' : 'declined'}: ${title}`,
    text: `${reviewerName} has ${accepted ? 'accepted' : 'declined'} the invitation to review a
manuscript in ${journalName}.

Title: ${title}${!accepted && reason ? `\nReason given: ${reason}` : ''}
${accepted ? '' : '\nYou may want to invite a replacement reviewer.'}

${link}`,
    html: layout({
      heading: `Reviewer ${accepted ? 'accepted' : 'declined'}`,
      journalName,
      bodyHtml:
        p(`<b>${esc(reviewerName)}</b> has ${accepted ? 'accepted' : 'declined'} the invitation to review a manuscript in <b>${esc(journalName)}</b>.`) +
        factBox([['Title', title], ['Reason given', !accepted ? reason : '']]) +
        (accepted ? '' : p('You may want to invite a replacement reviewer.')),
      ctaLabel: 'Open submission',
      ctaUrl: link,
    }),
  };
}

// ---- Account templates ----

// Sent immediately after registration. Deliberately NOT an address
// verification email -- the account works straight away and this is purely a
// confirmation. If you later want to require verified addresses before
// allowing submission, that's a separate feature (token, verify endpoint, and
// a gate on the submission route), not a change to this template.
function accountCreated({ name, email, affiliation, journalInterest, journals }) {
  const link = url('dashboard.html');
  const submitLink = url('submit.html');

  // journalInterest is a code like "alstm", or the literal "unsure".
  const interest =
    journalInterest && journals && journals[journalInterest] ? journals[journalInterest] : '';

  return {
    name: 'account_created',
    subject: 'Your Aaranya Scholarly author account is ready',
    text: `Dear ${name},

Thank you for registering as an author with Aaranya Scholarly LLP. Your
account is active and you can start submitting straight away.

Account: ${email}${affiliation ? `\nAffiliation: ${affiliation}` : ''}${interest ? `\nJournal of interest: ${interest}` : ''}

One account works across all seven Aaranya Scholarly journals -- you register
once and can submit to any of them from your dashboard.

What you can do now:
  - Submit a manuscript: ${submitLink}
  - Track submissions and see reviewer feedback: ${link}

Every manuscript is peer reviewed. Review at Aaranya Scholarly is
double-anonymous: reviewers do not see author identities, and authors do not
see reviewer identities. You will be emailed at each stage -- when your
manuscript is received, when revisions are requested, and when a decision is
made.

If you did not create this account, please reply to this email and let us
know.

Kind regards,
The Editorial Office
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Your author account is ready',
      journalName: '',
      bodyHtml:
        p(`Dear ${esc(name)},`) +
        p('Thank you for registering as an author with <b>Aaranya Scholarly LLP</b>. Your account is active and you can start submitting straight away.') +
        factBox([
          ['Account', email],
          ['Affiliation', affiliation],
          ['Journal of interest', interest],
        ]) +
        p('One account works across all seven Aaranya Scholarly journals — register once, submit to any of them from your dashboard.') +
        p(
          'Every manuscript is peer reviewed. Review here is <b>double-anonymous</b>: reviewers do not see author identities, and authors do not see reviewer identities. We will email you at each stage — when your manuscript is received, when revisions are requested, and when a decision is made.'
        ),
      ctaLabel: 'Submit a manuscript',
      ctaUrl: submitLink,
      footerNote:
        'If you did not create this account, please reply to this email and let us know.',
    }),
  };
}

function roleGranted({ name, role }) {
  const isEditor = role === 'editor';
  const link = url(isEditor ? 'editor.html' : 'reviewer.html');
  return {
    name: 'role_granted',
    subject: isEditor
      ? 'You have been given editor access — Aaranya Scholarly'
      : 'You have been added as a reviewer — Aaranya Scholarly',
    text: `Dear ${name},

You have been given the ${role} role for Aaranya Scholarly journals.

${
  isEditor
    ? 'You can now screen submissions, invite reviewers, and record editorial decisions from the editorial dashboard.'
    : 'Editors may now invite you to review manuscripts. You will receive an email each time you are invited, and you can accept or decline each invitation individually.'
}

${link}

Kind regards,
Aaranya Scholarly LLP`,
    html: layout({
      heading: isEditor ? 'Editor access granted' : 'You are now a reviewer',
      journalName: '',
      bodyHtml:
        p(`Dear ${esc(name)},`) +
        p(`You have been given the <b>${esc(role)}</b> role for Aaranya Scholarly journals.`) +
        p(
          isEditor
            ? 'You can now screen submissions, invite reviewers, and record editorial decisions from the editorial dashboard.'
            : 'Editors may now invite you to review manuscripts. You will receive an email each time you are invited, and can accept or decline each one individually.'
        ),
      ctaLabel: isEditor ? 'Open editorial dashboard' : 'Open reviewer dashboard',
      ctaUrl: link,
    }),
  };
}

// ---- Copyediting, production and publication ----

// Sent when an editor shares a copyedited draft or a proof AND marks it as
// needing the author's attention. Files shared without that flag are visible
// on the dashboard but generate no mail: an author who is emailed about every
// internal file movement stops reading the mail that actually needs them.
function copyeditingFileShared({ authorName, title, journalName, kindLabel, note, submissionId }) {
  const link = url(`submission.html?id=${submissionId}`);
  return {
    name: 'copyediting_file_shared',
    subject: `Action needed — ${kindLabel.toLowerCase()}: ${title}`,
    text: `Dear ${authorName},

The editorial office has shared a file with you and needs your response.

Title: ${title}
File: ${kindLabel}${note ? `\n\nNote from the editor:\n${note}` : ''}

Open your submission to download it and upload your response:
${link}

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'A file needs your attention',
      journalName,
      bodyHtml:
        p(`Dear ${esc(authorName)},`) +
        p('The editorial office has shared a file with you and needs your response before your article can move forward.') +
        factBox([['Title', title], ['File', kindLabel]]) +
        (note
          ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5c6b76;font-weight:700;margin:0 0 8px;">Note from the editor</div>${quote(note)}`
          : ''),
      ctaLabel: 'Open your submission',
      ctaUrl: link,
    }),
  };
}

function authorFileReceivedForEditor({ title, journalName, kindLabel, authorName, note, submissionId }) {
  const link = url(`editor-submission.html?id=${submissionId}`);
  return {
    name: 'author_file_received_editor',
    subject: `${kindLabel} received — ${title}`,
    text: `An author has uploaded a file to the production workflow.

Title: ${title}
Author: ${authorName}
File: ${kindLabel}${note ? `\n\nAuthor's note:\n${note}` : ''}

Open it in the editorial dashboard:
${link}`,
    html: layout({
      heading: 'Author file received',
      journalName,
      bodyHtml:
        p('An author has uploaded a file to the production workflow.') +
        factBox([['Title', title], ['Author', authorName], ['File', kindLabel]]) +
        (note
          ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5c6b76;font-weight:700;margin:0 0 8px;">Author's note</div>${quote(note)}`
          : ''),
      ctaLabel: 'Open in editorial dashboard',
      ctaUrl: link,
    }),
  };
}

// The one email in this system that is purely good news. It carries the
// public link, because the first thing an author does on publication is send
// that link to somebody.
function articlePublished({ authorName, title, journalName, issueLabel, pages, doi, articleUrl }) {
  return {
    name: 'article_published',
    subject: `Published: ${title}`,
    text: `Dear ${authorName},

Your article has been published.

Title: ${title}
Journal: ${journalName}
Issue: ${issueLabel}${pages ? `\nPages: ${pages}` : ''}${doi ? `\nDOI: https://doi.org/${doi}` : ''}

It is now publicly available here:
${articleUrl}

Thank you for publishing with us.

Kind regards,
The Editorial Office
${journalName}
Aaranya Scholarly LLP`,
    html: layout({
      heading: 'Your article is published',
      journalName,
      bodyHtml:
        p(`Dear ${esc(authorName)},`) +
        p('Your article has been published and is now publicly available.') +
        factBox([
          ['Title', title],
          ['Issue', issueLabel],
          ['Pages', pages || ''],
          ['DOI', doi ? `https://doi.org/${doi}` : ''],
        ]) +
        p('Thank you for publishing with us.'),
      ctaLabel: 'Read the published article',
      ctaUrl: articleUrl,
    }),
  };
}

module.exports = {
  submissionReceived,
  decisionRecorded,
  reviewInvitation,
  invitationWithdrawn,
  reviewThanks,
  newSubmissionForEditor,
  reviewSubmittedForEditor,
  invitationResponseForEditor,
  revisionReceived,
  revisionReceivedForEditor,
  reviewInvitationReminder,
  reviewOverdueReminder,
  revisionOverdueReminder,
  reminderEscalation,
  decisionForReviewer,
  newRoundForReviewer,
  accountCreated,
  roleGranted,
  copyeditingFileShared,
  authorFileReceivedForEditor,
  articlePublished,
  // exported for tests
  _internals: { esc, url, fmtDate, layout },
};
