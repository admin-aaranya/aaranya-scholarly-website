// Tests for the copyediting, production and publication rules.
//
// Three things here are worth proving, and they are the three that would hurt
// most if they broke:
//
//   1. File visibility -- an editor's internal working copy must never reach
//      the author, and an author must not be able to upload into an editor's
//      slot.
//   2. The publication gate -- an article cannot go public without the parts
//      that make a public page work.
//   3. The public view -- the whitelist must not leak confidential fields,
//      and generated HTML must not carry author-supplied markup.
//
// Dependency-free, like the rest of test/: run with `npm test`, no GCP.

const assert = require('assert');
const wf = require('../lib/workflow');
const issues = require('../lib/issues');
const galley = require('../lib/galley');

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

// ---- Fixtures ----

const acceptedSubmission = {
  id: 'sub-1',
  userId: 'user-author',
  journalCode: 'alstm',
  journalName: 'Advanced Life Sciences & Translational Medicine',
  articleType: 'Original Research Article',
  subjectArea: 'Molecular Biology',
  title: 'Mitochondrial dynamics in cardiac tissue',
  abstract: 'A long enough abstract to be plausible in a test fixture, describing the study.',
  keywords: 'mitochondria, cardiac',
  correspondingAuthor: {
    name: 'Radhika Sharma',
    email: 'r.sharma@example.edu',
    affiliation: 'Institute of Cardiac Research',
  },
  coAuthorsList: [{ name: 'Arun Patel', email: 'a.patel@example.edu', affiliation: 'Institute of Cardiac Research' }],
  coverLetter: 'CONFIDENTIAL: we previously submitted this elsewhere and it was rejected.',
  suggestedReviewers: [{ name: 'Prof. Someone', email: 'someone@example.edu' }],
  declarations: {
    originality: true,
    ethicsCompliance: true,
    ethicsApprovalDetails: 'Approved by the institutional ethics board, ref 2025/114.',
    conflictOfInterest: 'The authors declare funding from a commercial sponsor.',
  },
  manuscript: { fileName: 'Sharma-final-v3.docx', storedFileName: 'SECRETKEY/manuscript.docx', fileSize: 90000 },
  supplementaryFiles: [{ fileName: 'data.xlsx', storedFileName: 'SECRETKEY/supp.xlsx', fileSize: 4000 }],
  revisions: [{ round: 1, file: { fileName: 'rev.docx', storedFileName: 'SECRETKEY/rev.docx' }, uploadedAt: '2026-03-01' }],
  statusHistory: [{ status: 'Under Review', note: 'internal note', at: '2026-02-01' }],
  decisions: [{ decision: 'accept', editorName: 'Dr Editor', note: 'weak but publishable' }],
  stage: 'production',
  issueId: 'issue-1',
  pages: '112-125',
  doi: '10.1234/alstm.2026.001',
  license: 'CC BY 4.0',
  publishedAt: '2026-06-01T09:00:00.000Z',
  galleys: [
    {
      id: 'g-pdf',
      label: 'PDF',
      format: 'pdf',
      source: 'uploaded',
      order: 1,
      file: { fileName: 'article.pdf', storedFileName: 'SECRETKEY/article.pdf', fileSize: 500000 },
    },
  ],
  stageFiles: [],
};

const sampleIssue = { id: 'issue-1', journalCode: 'alstm', volume: 2, number: 1, year: 2026, status: 'published' };

// ============================================================================
console.log('\nCopyediting and production file rounds');
// ============================================================================

test('an editor cannot upload workflow files before copyediting', () => {
  assert.ok(!wf.canUploadFile('submission', 'copyedit_draft', 'editor'));
  assert.ok(!wf.canUploadFile('review', 'copyedit_draft', 'editor'));
});

test('an editor can upload a copyedited draft at the copyediting stage', () => {
  assert.ok(wf.canUploadFile('copyediting', 'copyedit_draft', 'editor'));
});

test('production files cannot be added before production', () => {
  assert.ok(!wf.canUploadFile('copyediting', 'production_ready', 'editor'));
  assert.ok(wf.canUploadFile('production', 'production_ready', 'editor'));
});

test('copyediting files stay uploadable once the article reaches production', () => {
  // Work that should have been filed earlier still has to go somewhere; the
  // alternative is pushing the stage backwards just to attach a file.
  assert.ok(wf.canUploadFile('production', 'copyedit_final', 'editor'));
});

test('an author cannot upload into an editor-only slot', () => {
  assert.ok(!wf.canUploadFile('copyediting', 'copyedit_draft', 'author'));
  assert.ok(!wf.canUploadFile('production', 'production_ready', 'author'));
  assert.ok(!wf.canUploadFile('production', 'copyedit_internal', 'author'));
});

test('an author can answer a copyedited draft and correct a proof', () => {
  assert.ok(wf.canUploadFile('copyediting', 'author_response', 'author'));
  assert.ok(wf.canUploadFile('production', 'proof_corrections', 'author'));
});

test('an unknown file kind is refused rather than defaulted', () => {
  assert.ok(!wf.canUploadFile('production', 'nonsense_kind', 'editor'));
  assert.ok(!wf.canUploadFile('production', '', 'editor'));
});

test("the editor's internal working file is never author-visible", () => {
  assert.strictEqual(wf.FILE_KINDS.COPYEDIT_INTERNAL.authorVisible, false);
  assert.strictEqual(wf.FILE_KINDS.PRODUCTION_READY.authorVisible, false);
});

test('authorVisibleFiles hides internal files entirely', () => {
  const files = [
    { id: 'f1', kind: 'copyedit_draft', stage: 'copyediting', file: { fileName: 'draft.docx', storedFileName: 'SECRETKEY/a' } },
    { id: 'f2', kind: 'copyedit_internal', stage: 'copyediting', file: { fileName: 'internal.docx', storedFileName: 'SECRETKEY/b' } },
    { id: 'f3', kind: 'production_ready', stage: 'production', file: { fileName: 'typeset.docx', storedFileName: 'SECRETKEY/c' } },
  ];
  const visible = wf.authorVisibleFiles(files);
  assert.strictEqual(visible.length, 1);
  assert.strictEqual(visible[0].id, 'f1');
});

test('authorVisibleFiles carries answeredAt alongside needsAuthorAction', () => {
  // Regression: without answeredAt the author's dashboard cannot tell an
  // answered request from an outstanding one and shows "response needed"
  // forever. Caught by the end-to-end walk, not by the route logic.
  const files = [
    {
      id: 'f1',
      kind: 'copyedit_draft',
      stage: 'copyediting',
      file: { fileName: 'draft.docx', storedFileName: 'k' },
      needsAuthorAction: true,
      answeredAt: '2026-06-02T10:00:00.000Z',
    },
  ];
  const visible = wf.authorVisibleFiles(files);
  assert.strictEqual(visible[0].needsAuthorAction, true);
  assert.strictEqual(visible[0].answeredAt, '2026-06-02T10:00:00.000Z');
  assert.strictEqual(
    visible.filter((f) => f.needsAuthorAction && !f.answeredAt).length,
    0,
    'an answered request must not still read as outstanding'
  );
});

test('authorVisibleFiles never passes a storage key or an editor name through', () => {
  const files = [
    {
      id: 'f1',
      kind: 'copyedit_draft',
      stage: 'copyediting',
      file: { fileName: 'draft.docx', storedFileName: 'SECRETKEY/a', fileSize: 10 },
      uploadedByName: 'Dr Editor',
      uploadedById: 'user-editor',
      uploadedByRole: 'editor',
    },
  ];
  const json = JSON.stringify(wf.authorVisibleFiles(files));
  assert.ok(!json.includes('SECRETKEY'), 'storage key leaked to the author');
  assert.ok(!json.includes('Dr Editor'), 'editor identity leaked to the author');
  assert.ok(!json.includes('user-editor'), 'editor id leaked to the author');
});

// ============================================================================
console.log('\nGalleys');
// ============================================================================

test('a galley format is derived from the file extension', () => {
  assert.strictEqual(wf.galleyFormatForExtension('.pdf'), 'pdf');
  assert.strictEqual(wf.galleyFormatForExtension('.HTML'), 'html');
  assert.strictEqual(wf.galleyFormatForExtension('.xml'), 'xml');
  assert.strictEqual(wf.galleyFormatForExtension('.docx'), null);
});

test('galleys sort by explicit order, then PDF before HTML before XML', () => {
  const sorted = wf.sortGalleys([
    { id: 'x', format: 'xml', label: 'XML' },
    { id: 'h', format: 'html', label: 'HTML' },
    { id: 'p', format: 'pdf', label: 'PDF' },
  ]);
  assert.deepStrictEqual(sorted.map((g) => g.id), ['p', 'h', 'x']);
});

test('an explicit order beats the format default', () => {
  const sorted = wf.sortGalleys([
    { id: 'p', format: 'pdf', order: 2 },
    { id: 'h', format: 'html', order: 1 },
  ]);
  assert.deepStrictEqual(sorted.map((g) => g.id), ['h', 'p']);
});

test('only PDF galleys are marked for inline display', () => {
  // Anything else served inline would run on our origin. See routes/public.js.
  assert.strictEqual(wf.GALLEY_FORMATS.pdf.inline, true);
  assert.strictEqual(wf.GALLEY_FORMATS.html.inline, false);
  assert.strictEqual(wf.GALLEY_FORMATS.xml.inline, false);
});

// ============================================================================
console.log('\nThe publication gate');
// ============================================================================

test('an article with everything in place is ready to publish', () => {
  assert.deepStrictEqual(
    wf.publishBlockers(acceptedSubmission, acceptedSubmission.galleys, sampleIssue),
    []
  );
  assert.ok(wf.isReadyToPublish(acceptedSubmission, acceptedSubmission.galleys, sampleIssue));
});

test('publishing is blocked without a galley', () => {
  const blockers = wf.publishBlockers(acceptedSubmission, [], sampleIssue);
  assert.strictEqual(blockers.length, 1);
  assert.ok(/galley/i.test(blockers[0]));
});

test('publishing is blocked without an issue', () => {
  const sub = Object.assign({}, acceptedSubmission, { issueId: '' });
  const blockers = wf.publishBlockers(sub, sub.galleys, null);
  assert.ok(blockers.some((b) => /issue/i.test(b)));
});

test('publishing is blocked when the assigned issue has vanished', () => {
  const blockers = wf.publishBlockers(acceptedSubmission, acceptedSubmission.galleys, null);
  assert.ok(blockers.some((b) => /no longer exists/i.test(b)));
});

test('publishing is blocked without a page range, because a citation needs one', () => {
  const sub = Object.assign({}, acceptedSubmission, { pages: '   ' });
  const blockers = wf.publishBlockers(sub, sub.galleys, sampleIssue);
  assert.ok(blockers.some((b) => /page range/i.test(b)));
});

test('every blocker is reported at once, not one at a time', () => {
  const bare = { id: 'x', journalCode: 'alstm' };
  assert.strictEqual(wf.publishBlockers(bare, [], null).length, 3);
});

// ============================================================================
console.log('\nThe public view of a published article');
// ============================================================================

const publicView = wf.publicArticleView(acceptedSubmission);

test('the public view carries what a reader and a citation need', () => {
  assert.strictEqual(publicView.title, acceptedSubmission.title);
  assert.strictEqual(publicView.abstract, acceptedSubmission.abstract);
  assert.strictEqual(publicView.doi, '10.1234/alstm.2026.001');
  assert.strictEqual(publicView.pages, '112-125');
  assert.strictEqual(publicView.authors.length, 2);
  assert.strictEqual(publicView.authors[0].corresponding, true);
  assert.strictEqual(publicView.galleys.length, 1);
});

test('the public view never leaks a storage key', () => {
  assert.ok(!JSON.stringify(publicView).includes('SECRETKEY'));
});

test('the public view never leaks the cover letter or suggested reviewers', () => {
  const json = JSON.stringify(publicView);
  assert.ok(!json.includes('CONFIDENTIAL'), 'cover letter leaked');
  assert.ok(!json.includes('Prof. Someone'), 'suggested reviewer leaked');
});

test('the public view never leaks editorial history or decisions', () => {
  const json = JSON.stringify(publicView);
  assert.ok(!json.includes('weak but publishable'), 'editor decision note leaked');
  assert.ok(!json.includes('internal note'), 'status history leaked');
  assert.strictEqual(publicView.decisions, undefined);
  assert.strictEqual(publicView.statusHistory, undefined);
});

test('the public view never leaks the ethics or conflict-of-interest free text', () => {
  // Those were written for editorial eyes. Publishing them is an editorial
  // policy decision that has to be made out loud, not a default.
  const json = JSON.stringify(publicView);
  assert.ok(!json.includes('2025/114'));
  assert.ok(!json.includes('commercial sponsor'));
});

test('the public view never exposes the submitting account', () => {
  assert.strictEqual(publicView.userId, undefined);
  assert.ok(!JSON.stringify(publicView).includes('user-author'));
});

test('a new field on a submission does not appear publicly by accident', () => {
  // The whitelist is the point: this is what a blacklist would get wrong.
  const withNewField = Object.assign({}, acceptedSubmission, {
    internalRiskNote: 'plagiarism software flagged 22% overlap',
  });
  const view = wf.publicArticleView(withNewField);
  assert.ok(!JSON.stringify(view).includes('plagiarism'));
});

test('the corresponding author email can be withheld', () => {
  const view = wf.publicArticleView(acceptedSubmission, { includeAuthorEmail: false });
  assert.strictEqual(view.authors[0].email, '');
  assert.ok(!JSON.stringify(view).includes('r.sharma@example.edu'));
});

test('co-author emails are never published, even when the flag is on', () => {
  assert.strictEqual(publicView.authors[1].email, '');
  assert.ok(!JSON.stringify(publicView).includes('a.patel@example.edu'));
});

// ============================================================================
console.log('\nIssues');
// ============================================================================

const CODES = ['alstm', 'ipsb', 'jec'];

test('a valid issue passes validation and comes back normalized', () => {
  const out = issues.validateIssue(
    { journalCode: 'alstm', volume: '2', number: '1', year: '2026', title: '  Special  ' },
    CODES
  );
  assert.ok(out.ok);
  assert.strictEqual(out.value.volume, 2);
  assert.strictEqual(out.value.number, 1);
  assert.strictEqual(out.value.title, 'Special');
});

test('an unknown journal is refused', () => {
  const out = issues.validateIssue({ journalCode: 'nope', volume: 1, number: 1, year: 2026 }, CODES);
  assert.ok(!out.ok);
});

test('volume and number must be whole positive numbers', () => {
  assert.ok(!issues.validateIssue({ journalCode: 'alstm', volume: 0, number: 1, year: 2026 }, CODES).ok);
  assert.ok(!issues.validateIssue({ journalCode: 'alstm', volume: 1.5, number: 1, year: 2026 }, CODES).ok);
  assert.ok(!issues.validateIssue({ journalCode: 'alstm', volume: 'two', number: 1, year: 2026 }, CODES).ok);
});

test('a year typed into the volume box is caught', () => {
  const out = issues.validateIssue({ journalCode: 'alstm', volume: 1, number: 1, year: 26 }, CODES);
  assert.ok(!out.ok);
});

test('two issues with the same volume and number collide', () => {
  const existing = [{ id: 'a', journalCode: 'alstm', volume: 2, number: 1, year: 2026 }];
  const clash = issues.findIssueClash(existing, { journalCode: 'alstm', volume: 2, number: 1, year: 2027 }, null);
  assert.ok(clash, 'a repeated volume/number should collide whatever the year');
});

test('the same volume and number in a different journal do not collide', () => {
  const existing = [{ id: 'a', journalCode: 'alstm', volume: 2, number: 1, year: 2026 }];
  assert.strictEqual(issues.findIssueClash(existing, { journalCode: 'jec', volume: 2, number: 1 }, null), null);
});

test('an issue does not collide with itself when edited', () => {
  const existing = [{ id: 'a', journalCode: 'alstm', volume: 2, number: 1, year: 2026 }];
  assert.strictEqual(issues.findIssueClash(existing, { journalCode: 'alstm', volume: 2, number: 1 }, 'a'), null);
});

test('issue labels read the way journals write them', () => {
  assert.strictEqual(issues.issueLabel({ volume: 2, number: 1, year: 2026 }), 'Vol. 2, No. 1 (2026)');
  assert.strictEqual(
    issues.issueLabel({ volume: 2, number: 1, year: 2026, title: 'Regenerative Medicine' }),
    'Vol. 2, No. 1 (2026): Regenerative Medicine'
  );
  assert.strictEqual(issues.issueShortLabel({ volume: 2, number: 1 }), '2(1)');
});

test('issues sort newest first', () => {
  const sorted = issues.sortIssues([
    { id: 'a', year: 2025, volume: 1, number: 2 },
    { id: 'b', year: 2026, volume: 2, number: 1 },
    { id: 'c', year: 2025, volume: 1, number: 3 },
  ]);
  assert.deepStrictEqual(sorted.map((i) => i.id), ['b', 'c', 'a']);
});

test('articles in an issue sort by explicit order, then by first page', () => {
  const sorted = issues.sortArticlesInIssue([
    { id: 'a', pages: '30-40', title: 'A' },
    { id: 'b', articleOrder: 1, pages: '99-110', title: 'B' },
    { id: 'c', pages: '10-29', title: 'C' },
  ]);
  assert.deepStrictEqual(sorted.map((a) => a.id), ['b', 'c', 'a']);
});

test('an article with no page range sorts last rather than first', () => {
  const sorted = issues.sortArticlesInIssue([
    { id: 'nopages', title: 'Z' },
    { id: 'paged', pages: '5-9', title: 'A' },
  ]);
  assert.deepStrictEqual(sorted.map((a) => a.id), ['paged', 'nopages']);
});

test('a citation carries the parts needed to find the article again', () => {
  const citation = issues.citationFor(publicView, sampleIssue, 'Advanced Life Sciences');
  assert.ok(citation.includes('Sharma R.'), citation);
  assert.ok(citation.includes('(2026)'), citation);
  assert.ok(citation.includes('2(1)'), citation);
  assert.ok(citation.includes('112-125'), citation);
  assert.ok(citation.includes('doi.org/10.1234/alstm.2026.001'), citation);
});

test('a mononym author is not mangled into initials', () => {
  assert.strictEqual(issues.citationAuthor('Ramanujan'), 'Ramanujan');
  assert.strictEqual(issues.citationAuthor('Radhika Sharma'), 'Sharma R.');
});

// ============================================================================
console.log('\nGenerating an HTML full text');
// ============================================================================

test('known section names become headings', () => {
  assert.ok(galley.looksLikeHeading('Introduction'));
  assert.ok(galley.looksLikeHeading('2. Materials and Methods'));
  assert.ok(galley.looksLikeHeading('RESULTS'));
  assert.ok(galley.looksLikeHeading('References'));
});

test('an ordinary sentence does not become a heading', () => {
  assert.ok(!galley.looksLikeHeading('We measured the response of each sample over twelve hours.'));
  assert.ok(
    !galley.looksLikeHeading(
      'THIS IS A LONG SENTENCE IN CAPITALS THAT SOMEONE LEFT IN THE MANUSCRIPT BY ACCIDENT'
    )
  );
});

test('the text is structured into headings, paragraphs and a reference list', () => {
  const out = galley.textToHtml(
    [
      'Introduction',
      'Cardiac tissue responds to stress in measurable ways.',
      '2. Methods',
      'We used a standard assay.',
      'References',
      '[1] Sharma R. A previous study. Journal of Things, 2024.',
      '[2] Patel A. Another study. Journal of Things, 2025.',
    ].join('\n'),
    { title: 'Mitochondrial dynamics' }
  );
  assert.ok(out.html.includes('<h2>Introduction</h2>'));
  assert.ok(out.html.includes('<h2>Methods</h2>'), 'numbering should be stripped from headings');
  assert.ok(out.html.includes('<ol class="galley-refs">'));
  assert.strictEqual((out.html.match(/<li>/g) || []).length, 2);
  assert.strictEqual(out.sections, 3);
});

test('the reference marker is not repeated inside the list item', () => {
  const out = galley.textToHtml('References\n[1] Sharma R. A study.', {});
  assert.ok(out.html.includes('<li>Sharma R. A study.</li>'), out.html);
});

test('a repeated title at the top of the manuscript is dropped', () => {
  const out = galley.textToHtml('Mitochondrial dynamics\nThe opening paragraph.', {
    title: 'Mitochondrial dynamics',
  });
  assert.ok(!out.html.includes('<p>Mitochondrial dynamics</p>'));
  assert.ok(out.html.includes('<p>The opening paragraph.</p>'));
});

test('markup in a manuscript is escaped, not rendered', () => {
  // This is the load-bearing one. A generated galley is injected into the
  // public article page unescaped, so if this ever fails, a manuscript
  // becomes stored XSS on the journal's own origin.
  const out = galley.textToHtml(
    'A paragraph with <script>alert("xss")</script> and an <img src=x onerror=alert(1)> in it.',
    {}
  );
  assert.ok(!out.html.includes('<script'), out.html);
  assert.ok(!out.html.includes('<img'), out.html);
  assert.ok(out.html.includes('&lt;script&gt;'), out.html);
});

test('markup inside a heading and a reference is escaped too', () => {
  const out = galley.textToHtml('<b>RESULTS</b>\nReferences\n[1] <script>x</script>', {});
  assert.ok(!out.html.includes('<script'), out.html);
  assert.ok(!/<b>/.test(out.html), out.html);
});

test('quotes and ampersands survive without breaking attributes', () => {
  const out = galley.textToHtml('Smith & Jones reported "a large effect".', {});
  assert.ok(out.html.includes('&amp;'));
  assert.ok(out.html.includes('&quot;'));
});

test('generating from a PDF is refused with advice, not a stack trace', () => {
  assert.throws(
    () => galley.generateHtmlGalley({ buffer: Buffer.from('x'), fileName: 'a.pdf', article: {} }),
    /PDF galley|Word file/i
  );
});

test('generating from an old binary .doc explains how to fix it', () => {
  assert.throws(
    () => galley.generateHtmlGalley({ buffer: Buffer.from('x'), fileName: 'a.doc', article: {} }),
    /save it as \.docx/i
  );
});

test('generating from an empty file is refused', () => {
  assert.throws(
    () => galley.generateHtmlGalley({ buffer: Buffer.alloc(0), fileName: 'a.docx', article: {} }),
    /empty/i
  );
});

// ---- Summary ----

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
