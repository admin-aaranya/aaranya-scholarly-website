// Tests for the canonical-host redirect.
//
// These rules are unusually unforgiving to get wrong in production: a mistake
// here is either an infinite redirect loop on the live site, or a silently
// broken Cloud Scheduler POST that stops every reviewer reminder without
// anything appearing to fail. Both are cheap to prove here and expensive to
// discover there.

const assert = require('assert');
const { redirectTarget, hostOf, isExemptHost } = require('../lib/canonical-host');

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

const SITE = 'https://journals.aaranyascholarly.com';

const at = (over) =>
  redirectTarget(Object.assign({ method: 'GET', host: 'aaranya-scholarly.web.app', originalUrl: '/', siteUrl: SITE }, over));

console.log('\nSending every address to the canonical one');

test('a request to the web.app host is redirected', () => {
  assert.strictEqual(at({}), 'https://journals.aaranyascholarly.com/');
});

test('the path and query survive the redirect', () => {
  assert.strictEqual(
    at({ originalUrl: '/article/abc-123?utm_source=x' }),
    'https://journals.aaranyascholarly.com/article/abc-123?utm_source=x'
  );
});

test('a request already on the canonical host is left alone', () => {
  // The loop guard. If this ever returns a target, the live site redirects
  // to itself forever.
  assert.strictEqual(at({ host: 'journals.aaranyascholarly.com' }), null);
});

test('the host comparison ignores case', () => {
  assert.strictEqual(at({ host: 'Journals.AaranyaScholarly.com' }), null);
});

test('the bare parked domain is redirected too', () => {
  assert.strictEqual(
    at({ host: 'aaranyascholarly.com', originalUrl: '/archive/alstm' }),
    'https://journals.aaranyascholarly.com/archive/alstm'
  );
});

console.log('\nWhat must never be redirected');

test('a POST is never redirected', () => {
  // Cloud Scheduler POSTs the reminder sweep. A 301 is not reliably re-issued
  // as a POST, and the failure would be silent.
  assert.strictEqual(at({ method: 'POST', originalUrl: '/api/cron/reminders' }), null);
});

test('no write method is redirected', () => {
  ['POST', 'PUT', 'PATCH', 'DELETE'].forEach((m) => {
    assert.strictEqual(at({ method: m }), null, `${m} should not redirect`);
  });
});

test('HEAD is redirected, like GET', () => {
  assert.ok(at({ method: 'HEAD' }));
});

test('the raw Cloud Run URL passes through', () => {
  // Health checks and `gcloud run services proxy` reach the service here.
  assert.strictEqual(at({ host: 'aaranya-website-502653105588.asia-south1.run.app' }), null);
});

test('localhost passes through, so development does not bounce to production', () => {
  assert.strictEqual(at({ host: 'localhost' }), null);
  assert.strictEqual(at({ host: '127.0.0.1' }), null);
});

test('nothing is redirected when SITE_URL is unset', () => {
  // Refusing to act on a missing config beats guessing a canonical host.
  assert.strictEqual(at({ siteUrl: '' }), null);
  assert.strictEqual(at({ siteUrl: undefined }), null);
  assert.strictEqual(at({ siteUrl: 'not-a-url' }), null);
});

test('a missing host is left alone rather than guessed at', () => {
  assert.strictEqual(at({ host: '' }), null);
});

console.log('\nHelpers');

test('hostOf pulls the hostname out of a URL', () => {
  assert.strictEqual(hostOf('https://journals.aaranyascholarly.com'), 'journals.aaranyascholarly.com');
  assert.strictEqual(hostOf('http://localhost:4000/x'), 'localhost');
  assert.strictEqual(hostOf('rubbish'), '');
});

test('isExemptHost covers run.app and the loopback names', () => {
  assert.ok(isExemptHost('x.run.app'));
  assert.ok(isExemptHost('localhost'));
  assert.ok(!isExemptHost('aaranya-scholarly.web.app'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
