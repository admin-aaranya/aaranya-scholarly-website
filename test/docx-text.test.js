// Tests for lib/docx-text.js -- the dependency-free Word reader.
//
// These began life inside the manuscript-assistant suite, because reading a
// .docx was something only the assistant did. The assistant is gone; the
// reader is not. It is now what lib/galley.js builds an HTML full text from,
// which means a silent failure here no longer produces a poor AI suggestion
// — it produces a published article whose full text is gibberish, or empty,
// or missing the half of a sentence the author deleted under tracked
// changes.
//
// That is a higher stake than the tests were originally written for, so they
// were kept in full rather than trimmed with the feature that prompted them.
//
// Dependency-free: run with `npm test`, no GCP, no network.

const assert = require('assert');
const zlib = require('zlib');

const { extractDocxText, xmlToText } = require('../lib/docx-text');

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

console.log('\nReading Word documents');

// Builds a real (single-entry, deflated) zip so the reader is exercised
// end-to-end rather than against a mocked-out unzip.
function makeDocx(documentXml) {
  const name = Buffer.from('word/document.xml');
  const raw = Buffer.from(documentXml, 'utf8');
  const deflated = zlib.deflateRawSync(raw);
  const crc = (() => {
    let c = ~0;
    for (const b of raw) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  })();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(deflated.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(0, 42); // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(30 + name.length + deflated.length, 16);

  return Buffer.concat([local, name, deflated, cen, name, eocd]);
}

const P = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const DOC = (body) =>
  `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;

test('a real deflated docx round-trips to plain text', () => {
  const buf = makeDocx(DOC(P('Methods') + P('Rats were randomised.')));
  const text = extractDocxText(buf);
  assert.ok(text.includes('Methods'));
  assert.ok(text.includes('Rats were randomised.'));
});

test('paragraphs become separate lines, not one run-on sentence', () => {
  // lib/galley.js splits on these newlines to find headings and paragraphs.
  // Lose them and the whole article renders as a single wall of text.
  const text = extractDocxText(makeDocx(DOC(P('Alpha') + P('Beta'))));
  assert.ok(/Alpha\s*\n\s*Beta/.test(text), `got: ${JSON.stringify(text)}`);
});

test('XML entities are decoded, so "p &lt; 0.05" is not shown as markup', () => {
  const text = extractDocxText(makeDocx(DOC(P('p &lt; 0.05 &amp; n &gt; 30'))));
  assert.strictEqual(text, 'p < 0.05 & n > 30');
});

test('numeric character references are decoded', () => {
  assert.strictEqual(extractDocxText(makeDocx(DOC(P('37 &#176;C, &#x3B1;=0.05')))), '37 °C, α=0.05');
});

test('no XML markup reaches the caller', () => {
  const text = extractDocxText(
    makeDocx(DOC('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r></w:p>'))
  );
  assert.strictEqual(text, 'Title');
});

test('deleted text under tracked changes is excluded', () => {
  // Publishing text the author had already deleted would be worse than the
  // original concern (critiquing writing that no longer exists) -- it would
  // put a retracted sentence into the version of record.
  const body =
    '<w:p><w:r><w:t>Kept.</w:t></w:r><w:del><w:r><w:delText>Removed.</w:delText></w:r></w:del></w:p>';
  const text = extractDocxText(makeDocx(DOC(body)));
  assert.ok(text.includes('Kept.'));
  assert.ok(!text.includes('Removed.'));
});

test('tabs and explicit breaks survive', () => {
  const body = '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>';
  assert.strictEqual(extractDocxText(makeDocx(DOC(body))), 'A\tB\nC');
});

test('a self-closing w:t does not swallow the rest of the document', () => {
  const body = '<w:p><w:r><w:t/><w:t>Visible</w:t></w:r></w:p>';
  assert.strictEqual(extractDocxText(makeDocx(DOC(body))), 'Visible');
});

test('an old binary .doc is refused with advice, not a stack trace', () => {
  const doc = Buffer.alloc(64);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(doc);
  assert.throws(() => extractDocxText(doc), /save it as \.docx or PDF/i);
});

test('a zip with no document body is refused clearly', () => {
  const buf = makeDocx(DOC(P('x')));
  // Rename the entry in both the local and central headers.
  const broken = Buffer.from(buf);
  const at = [];
  let idx = broken.indexOf('word/document.xml');
  while (idx !== -1) {
    at.push(idx);
    idx = broken.indexOf('word/document.xml', idx + 1);
  }
  at.forEach((i) => Buffer.from('word/xxxxxxxx.xml').copy(broken, i));
  assert.throws(() => extractDocxText(broken), /could not find the document body/i);
});

test('an empty document is refused rather than returned as blank text', () => {
  assert.throws(() => extractDocxText(makeDocx(DOC(''))), /appears to be empty/i);
});

test('truncated garbage does not throw a RangeError', () => {
  assert.throws(() => extractDocxText(Buffer.from('PK')), /does not look like a Word document/i);
});

test('xmlToText is safe on unbalanced markup', () => {
  assert.doesNotThrow(() => xmlToText('<w:t>hello'));
  assert.doesNotThrow(() => xmlToText('</w:t>stray'));
  assert.doesNotThrow(() => xmlToText(''));
});

// ---- Summary ----

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
