// Tests for the author's manuscript assistant.
//
// The failure modes that matter here are not "the model gave a mediocre
// suggestion". They are:
//
//   * the assistant stops someone submitting a paper
//   * a malformed model response crashes the page, or worse, gets rendered
//     as HTML
//   * the daily quota can be bypassed, so one script runs up a Vertex bill
//   * the prompt drifts into peer review and starts recommending rejection
//   * a Word document silently comes out as gibberish
//
// So that is what is asserted.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const check = require('../lib/manuscript-check');
const gemini = require('../lib/gemini');
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

// ---- The prompt must not authorise peer review ----

console.log('\nKeeping the assistant out of peer review');

const SYS = check.systemInstruction();

test('the prompt forbids recommending acceptance or rejection', () => {
  assert.ok(
    /recommend acceptance or rejection/i.test(SYS),
    'system instruction must explicitly forbid accept/reject recommendations'
  );
});

test('the prompt forbids judging novelty or significance', () => {
  assert.ok(/novelty/i.test(SYS) && /significance/i.test(SYS));
});

test('the prompt forbids asserting the science is correct or incorrect', () => {
  assert.ok(/scientific conclusions are correct/i.test(SYS));
});

test('the prompt states the output never affects the editorial decision', () => {
  assert.ok(/never affects the editorial decision/i.test(SYS));
});

test('the prompt forbids fabricating absences', () => {
  assert.ok(/invent findings/i.test(SYS) && /appears to be/i.test(SYS));
});

test('the prompt tells the model not to manufacture problems', () => {
  assert.ok(/do not\s*\n?\s*manufacture problems/i.test(SYS.replace(/\s+/g, ' ')));
});

// A model asked to grade a paper will grade a paper. The response schema is
// the second line of defence: there is simply nowhere for a verdict to go.
test('the response schema has no field a verdict could occupy', () => {
  const json = JSON.stringify(check.RESPONSE_SCHEMA).toLowerCase();
  ['accept', 'reject', 'recommendation', 'verdict', 'score', 'rating', 'quality'].forEach((word) => {
    assert.ok(!json.includes(word), `schema must not contain a "${word}" field`);
  });
});

test('severity wording describes journal expectations, not manuscript quality', () => {
  assert.deepStrictEqual(
    [...check.SEVERITIES].sort(),
    ['likely_required', 'suggestion', 'worth_addressing']
  );
});

// ---- Article-type awareness ----

console.log('\nApplying the right reporting guideline');

test('systematic reviews get PRISMA', () => {
  assert.ok(check.userPrompt({ articleType: 'Systematic Review / Meta-Analysis' }).includes('PRISMA'));
});

test('case reports get CARE, not CONSORT', () => {
  const p = check.userPrompt({ articleType: 'Case Report' });
  assert.ok(p.includes('CARE'));
  assert.ok(!p.includes('CONSORT'));
});

test('original research is told to choose between CONSORT, STROBE and ARRIVE', () => {
  const p = check.userPrompt({ articleType: 'Original Research Article' });
  ['CONSORT', 'STROBE', 'ARRIVE'].forEach((g) => assert.ok(p.includes(g), `missing ${g}`));
});

test('an unknown article type falls back rather than inventing a checklist', () => {
  const p = check.userPrompt({ articleType: 'Interpretive Dance' });
  assert.ok(p.includes('No formal reporting checklist applies'));
});

test('the prompt asks the model to cross-check title and abstract against the text', () => {
  const p = check.userPrompt({
    articleType: 'Original Research Article',
    title: 'A study of X',
    abstract: 'We studied X.',
  });
  assert.ok(p.includes('A study of X'));
  assert.ok(p.includes('We studied X.'));
  assert.ok(/match what the manuscript/i.test(p));
});

test('missing metadata does not produce empty labelled lines', () => {
  const p = check.userPrompt({ articleType: 'Case Report' });
  assert.ok(!p.includes('Title as entered'));
  assert.ok(!p.includes('Abstract as entered'));
});

// ---- Normalising whatever the model returns ----

console.log('\nSurviving a bad model response');

test('null does not throw', () => {
  const r = check.normalise(null);
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(typeof r.summary, 'string');
});

test('a string instead of an object does not throw', () => {
  assert.deepStrictEqual(check.normalise('sorry, I could not comply').findings, []);
});

test('findings that are not objects are dropped, not rendered', () => {
  const r = check.normalise({ findings: [null, 'text', 42, [], { issue: 'real one' }] });
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].issue, 'real one');
});

test('a finding with no issue text is dropped', () => {
  const r = check.normalise({ findings: [{ issue: '   ', suggestion: 'do something' }] });
  assert.strictEqual(r.findings.length, 0);
});

test('an unknown category is coerced rather than passed through to the CSS class', () => {
  const r = check.normalise({ findings: [{ issue: 'x', category: '"><script>alert(1)</script>' }] });
  assert.ok(check.CATEGORIES.has(r.findings[0].category));
});

test('an unknown severity is coerced -- it becomes a CSS class name in the page', () => {
  const r = check.normalise({ findings: [{ issue: 'x', severity: 'CRITICAL REJECT' }] });
  assert.ok(check.SEVERITIES.has(r.findings[0].severity));
});

test('findings are ordered most-required first', () => {
  const r = check.normalise({
    findings: [
      { issue: 'c', severity: 'suggestion' },
      { issue: 'a', severity: 'likely_required' },
      { issue: 'b', severity: 'worth_addressing' },
    ],
  });
  assert.deepStrictEqual(
    r.findings.map((f) => f.issue),
    ['a', 'b', 'c']
  );
});

test('an overlong list is capped so the page stays usable', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ issue: `issue ${i}` }));
  assert.strictEqual(check.normalise({ findings: many }).findings.length, check.MAX_FINDINGS);
});

test('a runaway issue string is truncated', () => {
  const r = check.normalise({ findings: [{ issue: 'x'.repeat(50000) }] });
  assert.ok(r.findings[0].issue.length < 700);
});

test('counts match the findings actually returned', () => {
  const r = check.normalise({
    findings: [
      { issue: 'a', severity: 'likely_required' },
      { issue: 'b', severity: 'likely_required' },
      { issue: 'c', severity: 'suggestion' },
    ],
  });
  assert.strictEqual(r.counts.likely_required, 2);
  assert.strictEqual(r.counts.suggestion, 1);
  assert.strictEqual(r.counts.worth_addressing, 0);
  assert.strictEqual(
    r.counts.likely_required + r.counts.worth_addressing + r.counts.suggestion,
    r.findings.length
  );
});

test('strengths are capped and non-strings dropped', () => {
  const r = check.normalise({ strengths: ['a', 'b', 'c', 'd', null, 7] });
  assert.ok(r.strengths.length <= 3);
  r.strengths.forEach((s) => assert.strictEqual(typeof s, 'string'));
});

test('a missing location gets a usable default rather than "undefined"', () => {
  const r = check.normalise({ findings: [{ issue: 'x' }] });
  assert.strictEqual(r.findings[0].location, 'Throughout');
});

// ---- Vertex response handling ----

console.log('\nReading Vertex responses honestly');

test('a safety-blocked prompt reports as blocked, not as an empty result', () => {
  assert.throws(
    () => gemini.extractText({ promptFeedback: { blockReason: 'SAFETY' } }),
    /blocked by safety/i
  );
});

test('a truncated response is an error, not half a report', () => {
  assert.throws(
    () =>
      gemini.extractText({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"find' }] } }],
      }),
    /cut short/i
  );
});

test('a RECITATION stop is reported rather than silently returning nothing', () => {
  assert.throws(
    () => gemini.extractText({ candidates: [{ finishReason: 'RECITATION', content: {} }] }),
    /stopped early/i
  );
});

test('an empty candidate list does not throw a TypeError', () => {
  assert.throws(() => gemini.extractText({}), /no candidates/i);
});

test('multi-part responses are joined, not truncated to the first part', () => {
  const text = gemini.extractText({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
  });
  assert.strictEqual(text, '{"a":1}');
});

test('the endpoint stays in-region so manuscripts do not leave asia-south1', () => {
  const url = gemini.endpoint('proj', 'asia-south1', 'gemini-2.5-flash');
  assert.ok(url.startsWith('https://asia-south1-aiplatform.googleapis.com/'));
  assert.ok(url.includes('/locations/asia-south1/'));
  assert.ok(url.endsWith(':generateContent'));
});

test('the global location uses the unprefixed host', () => {
  assert.ok(gemini.endpoint('p', 'global', 'm').startsWith('https://aiplatform.googleapis.com/'));
});

test('the assistant is unavailable off Cloud Run without an explicit token', () => {
  // Guards against a developer machine quietly making live billed calls.
  const saved = process.env.GOOGLE_ACCESS_TOKEN;
  delete process.env.GOOGLE_ACCESS_TOKEN;
  assert.strictEqual(gemini.isAvailable(), false);
  if (saved) process.env.GOOGLE_ACCESS_TOKEN = saved;
});

// ---- Quota ----

console.log('\nHolding the cost line');

const { recentChecks, MAX_CHECK_BYTES } = require('../routes/assistant');
const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();

test('checks older than 24 hours drop out of the window', () => {
  const user = { aiCheckTimes: [hoursAgo(25), hoursAgo(30), hoursAgo(2)] };
  assert.strictEqual(recentChecks(user).length, 1);
});

test('a user who has never run a check counts as zero, not undefined', () => {
  assert.strictEqual(recentChecks({}).length, 0);
});

test('checks exactly inside the window still count', () => {
  assert.strictEqual(recentChecks({ aiCheckTimes: [hoursAgo(23.9)] }).length, 1);
});

test('the assistant file cap is below the submission cap', () => {
  // If these ever cross, an author could attach a file they can submit but
  // not check, with no explanation of why.
  const { MAX_FILE_BYTES } = require('../lib/files');
  assert.ok(MAX_CHECK_BYTES < MAX_FILE_BYTES);
});

test('the inline cap and the route cap agree', () => {
  assert.strictEqual(MAX_CHECK_BYTES, gemini.MAX_INLINE_BYTES);
});

// ---- DOCX extraction ----

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

test('no XML markup reaches the model', () => {
  const text = extractDocxText(
    makeDocx(DOC('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r></w:p>'))
  );
  assert.strictEqual(text, 'Title');
});

test('deleted text under tracked changes is excluded', () => {
  // Sending text the author has already removed would have the assistant
  // critique writing that no longer exists.
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

test('an empty document is refused rather than sent as a blank prompt', () => {
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
process.exit(failed === 0 ? 0 : 1);
