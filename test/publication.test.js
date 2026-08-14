// Publication details: pagination, running order, DOI minting, licences.
//
// These are the numbers that end up inside citations other people make. A
// citation cannot be corrected once it is in somebody else's reference list,
// so the cost of a wrong page range here is permanent and external. That is
// why the fail-soft paths are tested as carefully as the happy ones -- the
// whole design rests on "returns nothing" being reliable.

const assert = require('assert');
const zlib = require('zlib');

const {
  parsePageRange,
  formatPageRange,
  nextStartPage,
  suggestPages,
  pageOverlaps,
  nextArticleOrder,
  duplicateOrder,
  generateDoi,
  normaliseDoi,
  licenceFor,
  LICENCES,
  DEFAULT_LICENCE,
} = require('../lib/publication');
const { pdfPageCount } = require('../lib/pdf-pages');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Page ranges
// ---------------------------------------------------------------------------

test('parses a plain range', () => {
  assert.deepStrictEqual(parsePageRange('112-125'), { start: 112, end: 125 });
});

test('parses a single page as a range of one', () => {
  assert.deepStrictEqual(parsePageRange('7'), { start: 7, end: 7 });
});

test('accepts the en dash Word produces', () => {
  assert.deepStrictEqual(parsePageRange('112–125'), { start: 112, end: 125 });
});

test('rejects a backwards range rather than swapping it', () => {
  // Swapping would be a guess about what the editor meant.
  assert.strictEqual(parsePageRange('125-112'), null);
});

test('rejects prefixed pagination instead of half-reading it', () => {
  // "A17-A24" is a real convention. Returning {17,24} would quietly drop the
  // section letter and put the next article on top of it.
  assert.strictEqual(parsePageRange('A17-A24'), null);
});

test('empty and rubbish give null', () => {
  assert.strictEqual(parsePageRange(''), null);
  assert.strictEqual(parsePageRange('in press'), null);
  assert.strictEqual(parsePageRange(null), null);
});

test('formats a multi-page and a single-page range', () => {
  assert.strictEqual(formatPageRange(1, 12), '1-12');
  assert.strictEqual(formatPageRange(13, 1), '13');
});

test('formats nothing when the length is unknown', () => {
  assert.strictEqual(formatPageRange(1, 0), '');
  assert.strictEqual(formatPageRange(1, null), '');
});

// ---------------------------------------------------------------------------
// Continuous pagination
// ---------------------------------------------------------------------------

test('an empty issue starts at page 1', () => {
  assert.strictEqual(nextStartPage([], null), 1);
});

test('continues from the highest end page, not the article count', () => {
  const issue = [
    { id: 'a', pages: '1-12' },
    { id: 'b', pages: '13-30' },
  ];
  assert.strictEqual(nextStartPage(issue, null), 31);
});

test('assembly order does not matter', () => {
  // Issues are rarely built front to back.
  const issue = [
    { id: 'b', pages: '13-30' },
    { id: 'a', pages: '1-12' },
  ];
  assert.strictEqual(nextStartPage(issue, null), 31);
});

test('an unparseable range is skipped, not assumed to be zero', () => {
  // The alternative -- treating "A1-A9" as nothing -- would restart the count
  // and stack the next article on top of it.
  const issue = [
    { id: 'a', pages: '1-12' },
    { id: 'b', pages: 'A1-A9' },
  ];
  assert.strictEqual(nextStartPage(issue, null), 13);
});

test('the article being placed does not count against itself', () => {
  // Re-saving an article must not push it further down the issue each time.
  const issue = [
    { id: 'a', pages: '1-12' },
    { id: 'me', pages: '13-20' },
  ];
  assert.strictEqual(nextStartPage(issue, 'me'), 13);
});

test('suggests a range from the PDF length', () => {
  const issue = [{ id: 'a', pages: '1-12' }];
  assert.strictEqual(suggestPages(issue, null, 9), '13-21');
});

test('suggests nothing when the PDF length is unknown', () => {
  assert.strictEqual(suggestPages([], null, null), null);
  assert.strictEqual(suggestPages([], null, 0), null);
});

test('detects an overlap in both directions', () => {
  const issue = [{ id: 'a', title: 'First', pages: '10-20' }];
  assert.strictEqual(pageOverlaps(issue, null, '15-25').length, 1);
  assert.strictEqual(pageOverlaps(issue, null, '5-12').length, 1);
  assert.strictEqual(pageOverlaps(issue, null, '21-30').length, 0);
});

// ---------------------------------------------------------------------------
// Order in issue
// ---------------------------------------------------------------------------

test('the first article in an issue is number 1', () => {
  assert.strictEqual(nextArticleOrder([], null), 1);
  assert.strictEqual(nextArticleOrder([{ id: 'me', articleOrder: null }], 'me'), 1);
});

test('later articles take the next free position', () => {
  const issue = [{ id: 'a', articleOrder: 1 }, { id: 'b', articleOrder: 2 }];
  assert.strictEqual(nextArticleOrder(issue, null), 3);
});

test('a gap left deliberately is not backfilled', () => {
  // An editor who removed position 2 and left it empty meant to.
  const issue = [{ id: 'a', articleOrder: 1 }, { id: 'c', articleOrder: 3 }];
  assert.strictEqual(nextArticleOrder(issue, null), 4);
});

test('articles with no order set do not affect the next one', () => {
  const issue = [{ id: 'a', articleOrder: 1 }, { id: 'b', articleOrder: null }];
  assert.strictEqual(nextArticleOrder(issue, null), 2);
});

test('a duplicate position is reported', () => {
  const issue = [{ id: 'a', title: 'First', articleOrder: 2 }];
  assert.strictEqual(duplicateOrder(issue, null, 2).length, 1);
  assert.strictEqual(duplicateOrder(issue, null, 3).length, 0);
  assert.strictEqual(duplicateOrder(issue, 'a', 2).length, 0);
});

// ---------------------------------------------------------------------------
// DOI
// ---------------------------------------------------------------------------

const DOI_ARGS = {
  prefix: '10.12345',
  journalCode: 'alstm',
  year: 2026,
  volume: 2,
  number: 1,
  articleOrder: 4,
};

test('mints a deterministic DOI from the article position', () => {
  assert.strictEqual(generateDoi(DOI_ARGS), '10.12345/alstm.2026.2.1.4');
  // Twice, because a second identifier for one article is a real failure mode.
  assert.strictEqual(generateDoi(DOI_ARGS), generateDoi(DOI_ARGS));
});

test('MINTS NOTHING WITHOUT A PREFIX', () => {
  // The single most important assertion in this file. A well-formed DOI that
  // resolves nowhere gets printed on CVs and into reference lists, and is
  // checked by DOAJ and Scopus. Empty is incomplete; dead is a false claim.
  assert.strictEqual(generateDoi(Object.assign({}, DOI_ARGS, { prefix: '' })), '');
  assert.strictEqual(generateDoi(Object.assign({}, DOI_ARGS, { prefix: null })), '');
  assert.strictEqual(generateDoi(Object.assign({}, DOI_ARGS, { prefix: '   ' })), '');
});

test('rejects a prefix that is not a real DOI prefix', () => {
  ['12345', '10.abc', 'doi:10.1234', '10.1', ''].forEach((prefix) => {
    assert.strictEqual(generateDoi(Object.assign({}, DOI_ARGS, { prefix })), '');
  });
});

test('mints nothing when the article position is incomplete', () => {
  // Every component is part of what makes the DOI unique. Missing one would
  // mint the same DOI for two different articles.
  ['journalCode', 'year', 'volume', 'number', 'articleOrder'].forEach((field) => {
    const args = Object.assign({}, DOI_ARGS);
    delete args[field];
    assert.strictEqual(generateDoi(args), '', `expected no DOI without ${field}`);
  });
});

test('tolerates a trailing slash on the configured prefix', () => {
  assert.strictEqual(
    generateDoi(Object.assign({}, DOI_ARGS, { prefix: '10.12345/' })),
    '10.12345/alstm.2026.2.1.4'
  );
});

test('normalises a pasted DOI to its bare form', () => {
  const bare = '10.12345/alstm.2026.2.1.4';
  assert.strictEqual(normaliseDoi(`https://doi.org/${bare}`), bare);
  assert.strictEqual(normaliseDoi(`http://dx.doi.org/${bare}`), bare);
  assert.strictEqual(normaliseDoi(`doi: ${bare}`), bare);
  assert.strictEqual(normaliseDoi(`  ${bare}  `), bare);
});

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

test('the default licence is one of the offered options', () => {
  assert.ok(LICENCES.some((l) => l.key === DEFAULT_LICENCE));
});

test('every licence carries a resolvable deed URL', () => {
  LICENCES.forEach((l) => {
    assert.ok(/^https:\/\//.test(l.url), `${l.key} has no https deed URL`);
    assert.ok(l.label && l.note, `${l.key} is missing its label or note`);
  });
});

test('an unrecognised stored licence is preserved, not discarded', () => {
  // The field used to be free text. Silently blanking historic values would
  // remove the terms an article was actually published under.
  const kept = licenceFor('All rights reserved');
  assert.strictEqual(kept.label, 'All rights reserved');
  assert.strictEqual(kept.unknown, true);
  assert.strictEqual(licenceFor(''), null);
});

// ---------------------------------------------------------------------------
// PDF page counting
// ---------------------------------------------------------------------------

function fakePdf(body) {
  return Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, 'latin1');
}

test('reads the page count from the page tree root', () => {
  const pdf = fakePdf('1 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 12 >>\nendobj');
  assert.strictEqual(pdfPageCount(pdf), 12);
});

test('takes the root count, not a subtree count', () => {
  // Picking the first match would return 4 here -- plausible, and wrong.
  const pdf = fakePdf(
    '1 0 obj\n<< /Type /Pages /Count 4 /Kids [3 0 R] >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Count 17 /Kids [1 0 R] >>\nendobj'
  );
  assert.strictEqual(pdfPageCount(pdf), 17);
});

test('finds /Count written before /Type in the same dictionary', () => {
  const pdf = fakePdf('1 0 obj\n<< /Count 8 /Type /Pages /Kids [2 0 R] >>\nendobj');
  assert.strictEqual(pdfPageCount(pdf), 8);
});

test('falls back to counting leaves when no /Count exists', () => {
  const pdf = fakePdf(
    '1 0 obj\n<< /Type /Page /Parent 9 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Page /Parent 9 0 R >>\nendobj'
  );
  assert.strictEqual(pdfPageCount(pdf), 2);
});

test('refuses to count an encrypted PDF', () => {
  const pdf = fakePdf('trailer\n<< /Encrypt 9 0 R >>\n1 0 obj\n<< /Type /Pages /Count 5 >>\nendobj');
  assert.strictEqual(pdfPageCount(pdf), null);
});

test('refuses to count leaves hidden in object streams', () => {
  // Undercounting here would put the next article's first page inside this
  // one's last, which is invisible until a reader follows a citation.
  const pdf = fakePdf('1 0 obj\n<< /Type /ObjStm /N 40 >>\nstream\nbinary\nendstream\nendobj');
  assert.strictEqual(pdfPageCount(pdf), null);
});

test('rejects anything that is not a PDF', () => {
  assert.strictEqual(pdfPageCount(Buffer.from('PK a docx, not a pdf')), null);
  assert.strictEqual(pdfPageCount(Buffer.alloc(0)), null);
  assert.strictEqual(pdfPageCount(null), null);
  assert.strictEqual(pdfPageCount('not a buffer'), null);
});

test('binary stream data does not corrupt the count', () => {
  // latin1 keeps byte offsets aligned; a utf8 read would mangle high bytes and
  // could invent or destroy a match.
  const junk = zlib.gzipSync(Buffer.from('x'.repeat(400))).toString('latin1');
  const pdf = fakePdf(
    `1 0 obj\n<< /Type /Pages /Count 6 >>\nendobj\n2 0 obj\nstream\n${junk}\nendstream\nendobj`
  );
  assert.strictEqual(pdfPageCount(pdf), 6);
});

// ---------------------------------------------------------------------------
// The arithmetic end to end
// ---------------------------------------------------------------------------

test('three articles paginate an issue without gaps or overlaps', () => {
  const issue = [];
  const lengths = [12, 9, 4];
  lengths.forEach((len, i) => {
    const id = `art${i}`;
    issue.push({
      id,
      pages: suggestPages(issue, id, len),
      articleOrder: nextArticleOrder(issue, id),
    });
  });

  assert.deepStrictEqual(issue.map((a) => a.pages), ['1-12', '13-21', '22-25']);
  assert.deepStrictEqual(issue.map((a) => a.articleOrder), [1, 2, 3]);

  issue.forEach((a) => {
    assert.strictEqual(pageOverlaps(issue, a.id, a.pages).length, 0);
    assert.strictEqual(duplicateOrder(issue, a.id, a.articleOrder).length, 0);
  });
});

console.log(`\npublication: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
