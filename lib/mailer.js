// Transactional email transport.
//
// Two rules govern everything in this file:
//
// 1. SENDING MUST NEVER BREAK THE WORKFLOW. If SendGrid is down, rate-limits
//    us, or the API key is wrong, an editor must still be able to record a
//    decision and a reviewer must still be able to submit a review. Every
//    send is therefore fire-and-forget: `notify()` returns immediately, the
//    send happens after the HTTP response, and failures are logged rather
//    than thrown. A journal that can't email is degraded; a journal that
//    can't record decisions is broken.
//
// 2. NO SMTP. Google Cloud blocks outbound port 25 on Cloud Run with no
//    exception, so we use SendGrid's HTTPS API (api.sendgrid.com/v3/mail/send)
//    which is unaffected by that block.
//
// With no SENDGRID_API_KEY set, messages are logged to stdout instead of
// sent. That's the local-development mode, and it also means a missing key
// degrades to "no email" rather than "app won't boot".

const {
  SENDGRID_API_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASSWORD,
  MAIL_TRANSPORT,
  JOURNAL_EMAILS,
  EDITORIAL_EMAIL,
} = require('../config');

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';
const SEND_TIMEOUT_MS = 10000;

const isLive = MAIL_TRANSPORT !== 'none';

// nodemailer is only needed for the SMTP path, and only pulled in when that
// path is actually selected -- so a SendGrid-only or log-only deployment
// doesn't pay for it at startup.
let smtpTransport = null;
function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  const nodemailer = require('nodemailer');
  smtpTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    // 587 uses STARTTLS (secure:false then upgrade); 465 is implicit TLS.
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    // Reuse one connection for a burst of messages (e.g. inviting several
    // reviewers), but don't hold it open forever on an idle instance.
    pool: true,
    maxConnections: 2,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  return smtpTransport;
}

// Which address a message comes from. Per-journal where we know the journal,
// so replies land with the right editorial team.
function senderFor(journalCode) {
  return (journalCode && JOURNAL_EMAILS[journalCode]) || EDITORIAL_EMAIL;
}

function senderNameFor(journalName) {
  return journalName ? `${journalName} — Aaranya Scholarly` : 'Aaranya Scholarly';
}

// Records what was sent, for the notification log stored on submissions and
// review assignments. Never includes the message body -- these records are
// visible to editors, and bodies can contain review comments.
function stub(message, status, error) {
  return {
    to: message.to,
    subject: message.subject,
    template: message.template || '',
    status,
    error: error ? String(error).slice(0, 300) : '',
    at: new Date().toISOString(),
  };
}

// The actual HTTPS call. Node 18+ has global fetch, so no dependency needed.
async function sendViaSendGrid(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: message.from, name: message.fromName },
        reply_to: { email: message.replyTo || message.from },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
    });

    if (!res.ok) {
      // SendGrid returns useful detail in the body on 4xx -- capture it,
      // since "403 Forbidden" almost always means the sender address isn't
      // verified, and that's worth seeing in the logs verbatim.
      const detail = await res.text().catch(() => '');
      throw new Error(`SendGrid responded ${res.status}: ${detail.slice(0, 500)}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Sends via Google Workspace SMTP relay. The relay is allowed to send as any
// address on the authenticated account's domain, which is what lets a message
// come from alstm@aaranyascholarly.com while authenticating as one account.
async function sendViaSmtp(message) {
  const info = await getSmtpTransport().sendMail({
    from: { name: message.fromName, address: message.from },
    to: message.to,
    replyTo: message.replyTo || message.from,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  // A 2xx from the relay still isn't proof of delivery, but a rejected
  // recipient is worth surfacing rather than silently treating as success.
  if (info && info.rejected && info.rejected.length) {
    throw new Error(`relay rejected: ${info.rejected.join(', ')}`);
  }
  return true;
}

function logInsteadOfSending(message) {
  console.log(
    [
      '',
      '─────────── EMAIL (not sent — no SENDGRID_API_KEY) ───────────',
      `To:      ${message.to}`,
      `Via:     ${MAIL_TRANSPORT}`,
      `From:    ${message.fromName} <${message.from}>`,
      `Subject: ${message.subject}`,
      '',
      message.text,
      '──────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}

// Send one message. Resolves to a stub describing the outcome; never rejects.
async function send(message) {
  if (!message || !message.to) {
    return stub(message || {}, 'skipped', 'no recipient');
  }

  if (!isLive) {
    logInsteadOfSending(message);
    return stub(message, 'logged');
  }

  try {
    if (MAIL_TRANSPORT === 'gmail') await require('./gmail').send(message);
    else if (MAIL_TRANSPORT === 'smtp') await sendViaSmtp(message);
    else await sendViaSendGrid(message);
    return stub(message, 'sent');
  } catch (err) {
    // Deliberately swallowed. See rule 1 at the top of this file.
    console.error(
      `[mailer] ${MAIL_TRANSPORT} failed to send "${message.subject}" to ${message.to}:`,
      err.message
    );
    return stub(message, 'failed', err.message);
  }
}

// Builds a message from a template result plus routing info.
function compose({ to, template, journalCode, journalName, replyTo }) {
  return {
    to,
    from: senderFor(journalCode),
    fromName: senderNameFor(journalName),
    replyTo: replyTo || senderFor(journalCode),
    subject: template.subject,
    text: template.text,
    html: template.html,
    template: template.name || '',
  };
}

// Fire-and-forget dispatch of one or more messages.
//
// Returns a promise that resolves to the notification stubs, but callers are
// expected NOT to await it before responding to the user -- see how the
// routes use `notify(...).then(record)`. Nothing here can reject.
async function notify(messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  const results = [];
  for (const m of list) {
    results.push(await send(m));
  }
  return results;
}

module.exports = {
  isLive,
  transport: MAIL_TRANSPORT,
  senderFor,
  senderNameFor,
  compose,
  send,
  notify,
};
