// Central config. JWT_SECRET must be set via environment variable in production
// -- on Cloud Run, bind it from Secret Manager
// (https://cloud.google.com/run/docs/configuring/services/secrets) so it's
// never checked into git or baked into the container image. Locally, a random
// secret is generated on first run and persisted to data/jwt_secret.txt so
// tokens keep working across restarts.
//
// GCS_BUCKET must be set in production -- it's the Cloud Storage bucket that
// holds uploaded manuscript/supplementary files (see db.js's sibling,
// routes/submissions.js). Not needed for local dev if you're using the
// Firestore + GCS emulators, but there is currently no local emulator wiring
// in this project -- see README.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Local-development storage root. Overridable so the end-to-end test can run
// against a throwaway directory instead of trampling the developer's own
// data/ -- see test/run-e2e.js. Ignored in production, where records live in
// Firestore and files in Cloud Storage.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const SECRET_FILE = path.join(DATA_DIR, 'jwt_secret.txt');

// Cloud Run always sets K_SERVICE. Use that to detect "we're running as the
// real deployed service" and refuse to fall back to an ephemeral per-instance
// secret, which would silently invalidate sessions on every redeploy/scale
// event and differ between instances.
const IS_CLOUD_RUN = Boolean(process.env.K_SERVICE);

function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (IS_CLOUD_RUN) {
    throw new Error(
      'JWT_SECRET is not set. On Cloud Run this must be bound from Secret Manager -- see docs/gcp-deploy-setup.md.'
    );
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  return secret;
}

const GCS_BUCKET = process.env.GCS_BUCKET || '';
if (IS_CLOUD_RUN && !GCS_BUCKET) {
  throw new Error('GCS_BUCKET is not set -- see docs/gcp-deploy-setup.md.');
}

// Bootstrap editors. There is deliberately no way to self-register as an
// editor -- accounts whose email appears here are granted the editor role on
// registration or next login. Everyone else starts as an author, and the
// reviewer/editor roles are granted by an existing editor from the editor
// dashboard.
//
// Set as a comma-separated list, e.g.
//   EDITOR_EMAILS="chief.editor@aaranyascholarly.com,managing@aaranyascholarly.com"
const EDITOR_EMAILS = String(process.env.EDITOR_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// ---- Email ----
//
// Two supported transports; whichever is configured wins, SMTP first.
//
//   SMTP  -- Google Workspace SMTP relay (smtp-relay.gmail.com). Chosen for
//            this deployment because aaranyascholarly.com is already a
//            Workspace domain, so Google's SPF and DKIM records are already
//            published -- no domain-authentication step, no new DNS records.
//            The relay can send as any address on the domain, which is what
//            makes the per-journal from-addresses work.
//
//   SendGrid HTTPS API -- kept as an alternative. Note it must be the HTTPS
//            API rather than SendGrid's SMTP, since some providers' SMTP
//            ports are awkward from serverless platforms.
//
// A note on ports: Google Cloud blocks outbound port 25 everywhere with no
// exception, but 587 and 465 are open -- which is why SMTP relay works from
// Cloud Run at all.
//
// With neither configured, the mailer logs messages to the console instead
// of sending. That's the local-development mode, and it means a missing
// credential degrades to "no email" rather than "app won't boot".

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp-relay.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
// App Password for the Workspace account, bound from Secret Manager.
// Never hard-code this.
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';

// SMTP is considered configured only when we have credentials to present.
// The relay also supports IP-based auth, but Cloud Run egress IPs are
// dynamic, so credentials are the only workable option here.
const SMTP_CONFIGURED = Boolean(SMTP_USER && SMTP_PASSWORD);

// ---- Gmail API (preferred transport) ----
//
// SMTP from Cloud Run does not work reliably: egress IPs are shared and
// rotate, so Google's relay rejects the connection at EHLO with
// "421 4.7.0 Try again later" before authentication is even attempted. The
// Gmail API is plain HTTPS and sidesteps that entirely, while keeping the
// advantages that made Google attractive here -- no new vendor, and no DNS
// changes, because Workspace already publishes SPF and DKIM for the domain.
//
// GMAIL_ENABLED turns it on. GMAIL_IMPERSONATE is the fallback Workspace
// account used when a journal from-address isn't itself an impersonable
// user (an alias or group, say).
const GMAIL_ENABLED = String(process.env.GMAIL_ENABLED || '').toLowerCase() === 'true';
const GMAIL_IMPERSONATE = process.env.GMAIL_IMPERSONATE || '';

// Only needed off Cloud Run; on Cloud Run the metadata server reports it.
const RUNTIME_SERVICE_ACCOUNT = process.env.RUNTIME_SERVICE_ACCOUNT || '';

// The AI manuscript assistant (Vertex AI Gemini) was removed. Its settings --
// GEMINI_ENABLED, VERTEX_LOCATION, GEMINI_MODEL, GCP_PROJECT_ID and
// AI_CHECKS_PER_DAY -- are gone with it. If any are still set as environment
// variables on the Cloud Run service they are now inert, but they are worth
// clearing so nobody reads them later as evidence the feature still exists.

// ---- Scheduled jobs ----
//
// Shared secret guarding the reminder-sweep endpoint. Required because this
// service runs with Cloud Run's invoker IAM check disabled (the org's Domain
// Restricted Sharing policy forbids granting allUsers), so Cloud Run does not
// reject unauthenticated callers for us.
//
// With no secret set the endpoint returns 404 and never runs -- refusing is
// safer than running an unauthenticated job that emails people.
const CRON_SECRET = process.env.CRON_SECRET || '';

// gmail | smtp | sendgrid | none
const MAIL_TRANSPORT = GMAIL_ENABLED
  ? 'gmail'
  : SMTP_CONFIGURED
    ? 'smtp'
    : SENDGRID_API_KEY
      ? 'sendgrid'
      : 'none';

// Absolute base URL used to build links in emails. Emails are read outside
// the browser session, so relative links are useless here.
const SITE_URL = (process.env.SITE_URL || 'http://localhost:4000').replace(/\/+$/, '');

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'aaranyascholarly.com';

// Per-journal sending addresses. Each must be verified in SendGrid (domain
// authentication on MAIL_DOMAIN covers all of them at once -- you do not need
// to verify each address individually once the domain is authenticated).
const JOURNAL_EMAILS = {
  alstm: `alstm@${MAIL_DOMAIN}`,
  ipsb: `ipsb@${MAIL_DOMAIN}`,
  ghesb: `ghesb@${MAIL_DOMAIN}`,
  jec: `jec@${MAIL_DOMAIN}`,
  jtim: `jtim@${MAIL_DOMAIN}`,
  jsamp: `jsamp@${MAIL_DOMAIN}`,
  acfdi: `acfdi@${MAIL_DOMAIN}`,
};

// Crossref DOI prefix (the "10.xxxxx" half), assigned to the publisher on
// membership. EMPTY UNTIL THAT EXISTS, AND THAT IS THE CORRECT STATE.
//
// While it is empty the platform offers no DOI at all. It could trivially
// generate a well-formed string, and that is exactly the trap: a DOI that
// resolves nowhere looks authoritative, gets printed on CVs and into other
// people's reference lists, and is checked by DOAJ and Scopus assessors. An
// empty field is incomplete; a dead DOI is a false claim you cannot recall.
//
// Setting this switches suggestion on. It does NOT register anything --
// depositing metadata with Crossref is a separate step this platform does not
// yet perform, so a minted DOI stays unresolvable until that exists too.
const DOI_PREFIX = String(process.env.DOI_PREFIX || '').trim();

// Used for mail that isn't tied to a single journal (e.g. "you've been made a
// reviewer"), and as the fallback if a journal code is ever unrecognized.
const EDITORIAL_EMAIL = process.env.EDITORIAL_EMAIL || `editorial@${MAIL_DOMAIN}`;

// Where "a new submission arrived" / "a review came in" notices go. Falls
// back to the bootstrap editors so these are never silently dropped.
const EDITORIAL_NOTIFY_EMAILS = String(process.env.EDITORIAL_NOTIFY_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

module.exports = {
  DATA_DIR,
  PORT: process.env.PORT || 4000,
  JWT_SECRET: loadOrCreateSecret(),
  TOKEN_EXPIRY: '30d',
  GCS_BUCKET,
  IS_CLOUD_RUN,
  EDITOR_EMAILS,
  SENDGRID_API_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASSWORD,
  SMTP_CONFIGURED,
  GMAIL_ENABLED,
  GMAIL_IMPERSONATE,
  RUNTIME_SERVICE_ACCOUNT,
  CRON_SECRET,
  MAIL_TRANSPORT,
  SITE_URL,
  DOI_PREFIX,
  MAIL_DOMAIN,
  JOURNAL_EMAILS,
  EDITORIAL_EMAIL,
  EDITORIAL_NOTIFY_EMAILS,
};
