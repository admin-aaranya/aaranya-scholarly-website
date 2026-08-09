// Gmail API transport.
//
// Why this rather than SMTP: Cloud Run's outbound IPs are shared across many
// Google Cloud customers and rotate constantly, so they carry no sending
// reputation. Google's SMTP relay rejects such connections at EHLO with
// "421 4.7.0 Try again later, closing connection" -- before authentication,
// so no amount of correct credentials fixes it. The Gmail API is an ordinary
// HTTPS call and is unaffected.
//
// Authentication is KEYLESS. Rather than downloading a service-account JSON
// key (a long-lived secret that would then need storing and rotating), we:
//
//   1. take the runtime service account's own token from the metadata server
//   2. ask the IAM Credentials API to sign a JWT asserting
//      "this service account, acting as <user>, wants gmail.send"
//   3. exchange that signed JWT for a short-lived OAuth access token
//   4. call gmail.users.messages.send with it
//
// Step 2 is what domain-wide delegation authorises: an administrator grants
// the service account's client ID permission to impersonate users in the
// domain for a specific scope, and nothing wider.

const { GMAIL_IMPERSONATE, RUNTIME_SERVICE_ACCOUNT } = require('../config');

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_EMAIL_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email';

const REQUEST_TIMEOUT_MS = 10000;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

// Access tokens last an hour; cache per impersonated address and refresh a
// little early so a send never races the expiry.
const tokenCache = new Map();

async function metadataFetch(url) {
  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: t.signal });
    if (!res.ok) throw new Error(`metadata server responded ${res.status}`);
    return res;
  } finally {
    t.done();
  }
}

// The service account this instance runs as. On Cloud Run the metadata
// server knows it; locally we fall back to config so tests can run.
let cachedServiceAccount = null;
async function serviceAccountEmail() {
  if (cachedServiceAccount) return cachedServiceAccount;
  if (RUNTIME_SERVICE_ACCOUNT) {
    cachedServiceAccount = RUNTIME_SERVICE_ACCOUNT;
    return cachedServiceAccount;
  }
  const res = await metadataFetch(METADATA_EMAIL_URL);
  cachedServiceAccount = (await res.text()).trim();
  return cachedServiceAccount;
}

async function metadataAccessToken() {
  const res = await metadataFetch(METADATA_TOKEN_URL);
  const body = await res.json();
  return body.access_token;
}

// Asks IAM Credentials to sign a JWT on the service account's behalf. This is
// the step that needs roles/iam.serviceAccountTokenCreator on itself.
async function signJwt(claims) {
  const sa = await serviceAccountEmail();
  const bearer = await metadataAccessToken();
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(
    sa
  )}:signJwt`;

  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`signJwt ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = await res.json();
    return body.signedJwt;
  } finally {
    t.done();
  }
}

// Full flow: signed JWT -> access token that acts as `impersonate`.
async function accessTokenFor(impersonate) {
  const cached = tokenCache.get(impersonate);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const signed = await signJwt({
    iss: await serviceAccountEmail(),
    sub: impersonate, // the user being impersonated -- what DWD authorises
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const t = withTimeout(REQUEST_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: t.signal,
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signed,
      }),
    });
    body = await res.json();
    if (!res.ok) {
      // The useful case: "unauthorized_client" means domain-wide delegation
      // hasn't been granted for this client ID and scope.
      throw new Error(
        `token exchange failed: ${body.error || res.status}${
          body.error_description ? ` — ${body.error_description}` : ''
        }`
      );
    }
  } finally {
    t.done();
  }

  tokenCache.set(impersonate, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  });
  return body.access_token;
}

// ---- MIME ----

// Encodes a header value that may contain non-ASCII (author names routinely
// do) per RFC 2047, so "Dr Priyá Sharma" doesn't arrive mangled.
function encodeHeader(value) {
  const s = String(value == null ? '' : value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Strips CR/LF from header values. Without this, a display name containing a
// newline could inject arbitrary headers (e.g. an extra Bcc).
function sanitiseHeader(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');
}

function buildMime({ from, fromName, to, replyTo, subject, text, html }) {
  const boundary = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const fromHeader = fromName
    ? `${encodeHeader(sanitiseHeader(fromName))} <${sanitiseHeader(from)}>`
    : sanitiseHeader(from);

  const lines = [
    `From: ${fromHeader}`,
    `To: ${sanitiseHeader(to)}`,
    `Reply-To: ${sanitiseHeader(replyTo || from)}`,
    `Subject: ${encodeHeader(sanitiseHeader(subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '', 'utf8').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html || '', 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

// Gmail wants base64url without padding.
function base64Url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---- Send ----

async function sendOnce(message, impersonate) {
  const token = await accessTokenFor(impersonate);
  const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(
    impersonate
  )}/messages/send`;

  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify({ raw: base64Url(buildMime(message)) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`gmail send ${res.status}: ${detail.slice(0, 300)}`);
    }
    return true;
  } finally {
    t.done();
  }
}

// Sends as the message's From address where possible, so a reviewer's
// invitation genuinely comes from that journal's mailbox. If that address
// isn't an impersonable user (it may be an alias or a group), fall back to
// the configured account and let the From header carry the journal address.
async function send(message) {
  try {
    return await sendOnce(message, message.from);
  } catch (err) {
    if (!GMAIL_IMPERSONATE || GMAIL_IMPERSONATE === message.from) throw err;
    console.warn(
      `[gmail] could not send as ${message.from} (${err.message.slice(0, 120)}); ` +
        `retrying as ${GMAIL_IMPERSONATE}`
    );
    return sendOnce(message, GMAIL_IMPERSONATE);
  }
}

module.exports = { send, buildMime, base64Url, encodeHeader, sanitiseHeader };
