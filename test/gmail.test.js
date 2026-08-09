// Tests for the Gmail API transport's message construction.
//
// The network path can't be tested without live credentials, but the part
// that's easy to get wrong -- building a correct RFC822 message -- is pure
// and worth pinning. Header injection in particular: a display name is
// attacker-influenced (anyone can register with any name), and an unescaped
// newline in a header is how you smuggle an extra Bcc into someone else's
// email.

const assert = require('assert');

process.env.SITE_URL = 'https://x.test';
const gmail = require('../lib/gmail');

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

const base = {
  from: 'alstm@aaranyascholarly.com',
  fromName: 'Advanced Life Sciences & Translational Medicine — Aaranya Scholarly',
  to: 'reviewer@example.edu',
  replyTo: 'alstm@aaranyascholarly.com',
  subject: 'Invitation to review',
  text: 'Plain text body',
  html: '<p>HTML body</p>',
};

console.log('\nMIME construction');

test('includes the required headers', () => {
  const mime = gmail.buildMime(base);
  ['From:', 'To:', 'Reply-To:', 'Subject:', 'MIME-Version: 1.0'].forEach((h) => {
    assert.ok(mime.includes(h), `missing ${h}`);
  });
});

test('sends as the journal address, not a generic one', () => {
  const mime = gmail.buildMime(base);
  assert.ok(mime.includes('<alstm@aaranyascholarly.com>'), 'from address missing');
});

test('is multipart/alternative with both parts', () => {
  const mime = gmail.buildMime(base);
  assert.ok(/Content-Type: multipart\/alternative; boundary="/.test(mime));
  assert.ok(mime.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(mime.includes('Content-Type: text/html; charset="UTF-8"'));
});

test('bodies are base64 encoded and decode back to the originals', () => {
  const mime = gmail.buildMime(base);
  const parts = mime.split(/--b[a-z0-9]+/);
  const decoded = parts
    .map((p) => {
      const idx = p.indexOf('\r\n\r\n');
      if (idx === -1) return '';
      return Buffer.from(p.slice(idx + 4).trim(), 'base64').toString('utf8');
    })
    .join('\n');
  assert.ok(decoded.includes('Plain text body'), 'text part did not round-trip');
  assert.ok(decoded.includes('<p>HTML body</p>'), 'html part did not round-trip');
});

test('uses CRLF line endings, as the RFC requires', () => {
  const mime = gmail.buildMime(base);
  assert.ok(mime.includes('\r\n'), 'no CRLF found');
  assert.ok(!/[^\r]\n/.test(mime), 'found a bare LF not preceded by CR');
});

test('boundary is unique per message', () => {
  const a = gmail.buildMime(base).match(/boundary="([^"]+)"/)[1];
  const b = gmail.buildMime(base).match(/boundary="([^"]+)"/)[1];
  assert.notStrictEqual(a, b);
});

console.log('\nHeader safety');

test('a newline in a display name cannot inject a header', () => {
  const mime = gmail.buildMime(
    Object.assign({}, base, { fromName: 'Evil\r\nBcc: victim@example.com' })
  );
  assert.ok(!/^Bcc:/m.test(mime), 'header injection succeeded via fromName');
});

test('a newline in the subject cannot inject a header', () => {
  const mime = gmail.buildMime(
    Object.assign({}, base, { subject: 'Hello\r\nBcc: victim@example.com' })
  );
  assert.ok(!/^Bcc:/m.test(mime), 'header injection succeeded via subject');
});

test('a newline in the recipient cannot inject a header', () => {
  const mime = gmail.buildMime(
    Object.assign({}, base, { to: 'a@b.c\r\nBcc: victim@example.com' })
  );
  assert.ok(!/^Bcc:/m.test(mime), 'header injection succeeded via to');
});

console.log('\nEncoding');

test('non-ASCII names are RFC 2047 encoded rather than sent raw', () => {
  const mime = gmail.buildMime(Object.assign({}, base, { fromName: 'Dr Priyá Sharmā' }));
  assert.ok(mime.includes('=?UTF-8?B?'), 'expected encoded-word');
  assert.ok(!mime.includes('Priyá'), 'raw non-ASCII leaked into the header');
});

test('plain ASCII names are left readable', () => {
  const mime = gmail.buildMime(Object.assign({}, base, { fromName: 'Aaranya Scholarly' }));
  assert.ok(mime.includes('Aaranya Scholarly'), 'needlessly encoded an ASCII name');
});

test('a non-ASCII subject survives the round trip', () => {
  const subject = 'Décision éditoriale — Aaranya';
  const mime = gmail.buildMime(Object.assign({}, base, { subject }));
  const m = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mime);
  assert.ok(m, 'subject was not encoded');
  assert.strictEqual(Buffer.from(m[1], 'base64').toString('utf8'), subject);
});

console.log('\nbase64url for the Gmail API');

test('produces url-safe base64 with no padding', () => {
  const out = gmail.base64Url('some text that will certainly need padding ???');
  assert.ok(!out.includes('+'), 'contains +');
  assert.ok(!out.includes('/'), 'contains /');
  assert.ok(!out.includes('='), 'contains padding');
});

test('round-trips exactly', () => {
  const original = 'From: a@b.c\r\nSubject: ünïcödé\r\n\r\nbody';
  const encoded = gmail.base64Url(original);
  const decoded = Buffer.from(
    encoded.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf8');
  assert.strictEqual(decoded, original);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
