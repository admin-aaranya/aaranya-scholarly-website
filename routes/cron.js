// Scheduled-job endpoint for the reminder sweep.
//
// AUTHENTICATION NOTE: this service runs with Cloud Run's invoker IAM check
// disabled -- we had to, because the organisation's Domain Restricted Sharing
// policy forbids granting allUsers. That means Cloud Run will NOT reject
// unauthenticated callers for us, and anything sensitive must be guarded in
// the application.
//
// So this route requires a shared secret in a header. Cloud Scheduler is
// configured to send it; nobody else knows it. Without the secret the
// endpoint is indistinguishable from a 404, so its existence isn't
// advertised to a scanner.

const express = require('express');
const { CRON_SECRET } = require('../config');
const sweep = require('../lib/reminder-sweep');

const router = express.Router();

// Constant-time-ish comparison. Not strictly necessary for a scheduler token
// over HTTPS, but comparing secrets with === is a bad habit to leave lying
// around in a codebase.
function secretMatches(provided) {
  if (!CRON_SECRET || !provided) return false;
  if (provided.length !== CRON_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ CRON_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

function requireCronSecret(req, res, next) {
  if (!CRON_SECRET) {
    // Refuse rather than run unguarded. An unauthenticated endpoint that
    // emails people is worse than one that doesn't work.
    return res.status(404).end();
  }
  if (!secretMatches(req.get('X-Cron-Key'))) {
    return res.status(404).end();
  }
  next();
}

router.post('/reminders', requireCronSecret, async (req, res, next) => {
  try {
    const dryRun = String(req.query.dryRun || '') === 'true';
    const results = await sweep.run({ dryRun });
    console.log(
      `[cron] reminder sweep${dryRun ? ' (dry run)' : ''}: ` +
        `${results.actions.length} action(s), ${results.sent} sent, ${results.failed} failed, ` +
        `from ${results.checkedAssignments} assignment(s) and ${results.checkedSubmissions} submission(s)`
    );
    res.json(results);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
