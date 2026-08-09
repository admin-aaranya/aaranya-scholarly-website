// End-to-end smoke test: walks a manuscript from submission to a live public
// article page against a real running server.
//
// Unlike the rest of test/, this one needs a server and writes real records,
// so it is NOT part of `npm test`. Run it against a throwaway copy:
//
//   npm run test:e2e
//
// which boots the app on port 4100 with its own data directory, walks the
// whole workflow, and tears down. It covers the seams the unit tests cannot:
// route wiring, multipart uploads, file storage, and -- most importantly --
// what actually reaches the public HTML.

const zlib = require('zlib');

const BASE = process.env.E2E_BASE || 'http://localhost:4100';
let editorToken = '';
let authorToken = '';
let subId = '';
let issueId = '';

let checks = 0;
let fails = 0;

function ok(name, cond, extra) {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    fails += 1;
    console.error(`  FAIL ${name}${extra ? `\n       ${extra}` : ''}`);
  }
}

async function api(pathname, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + pathname, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* an HTML page, not JSON */
  }
  return { status: res.status, json, text };
}

// ---- A real deflated .docx, built without a dependency ----

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach(({ name, data }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

function buildDocx() {
  const body =
    para('Mitochondrial dynamics in cardiac tissue') +
    para('Introduction') +
    para('Cardiac tissue responds to metabolic stress in ways that can be measured directly.') +
    para('2. Materials and Methods') +
    para('We used a standard fluorescence assay across twelve samples, with n = 12 per group.') +
    para('Results') +
    para('The observed effect was large and consistent, with p &lt; 0.05 across all groups.') +
    // A hostile line: if this survives as live markup on the public page, the
    // journal has stored XSS on its own origin.
    para('A troublesome line with &lt;script&gt;alert(1)&lt;/script&gt; left in by a careless author.') +
    para('Discussion') +
    para('These findings extend the earlier literature in a useful direction.') +
    para('References') +
    para('[1] Sharma R. An earlier study. Journal of Things, 2024.') +
    para('[2] Patel A. Another study. Journal of Things, 2025.');

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

  return makeZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'utf8'),
    },
    { name: 'word/document.xml', data: Buffer.from(doc, 'utf8') },
  ]);
}

function formData(fields) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => {
    if (v && v.__file) fd.append(k, new Blob([v.buffer]), v.name);
    else fd.append(k, v);
  });
  return fd;
}

// ---- The walk ----

async function main() {
  const docx = buildDocx();

  console.log('\nAccounts');
  let r = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Dr Editor',
      email: 'editor@aaranyascholarly.com',
      password: 'testpassword123',
      affiliation: 'Aaranya Scholarly',
    },
  });
  ok('editor account created', r.status === 201 || r.status === 200, JSON.stringify(r.json));
  editorToken = r.json && r.json.token;

  r = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Radhika Sharma',
      email: 'author@example.edu',
      password: 'testpassword123',
      affiliation: 'Institute of Cardiac Research',
    },
  });
  ok('author account created', r.status === 201 || r.status === 200, JSON.stringify(r.json));
  authorToken = r.json && r.json.token;

  r = await api('/api/editorial/stats', { token: editorToken });
  ok('editor role bootstrapped from EDITOR_EMAILS', r.status === 200, JSON.stringify(r.json));

  console.log('\nSubmission');
  r = await api('/api/submissions', {
    method: 'POST',
    token: authorToken,
    form: formData({
      journalCode: 'alstm',
      articleType: 'Original Research Article',
      subjectArea: 'Molecular Biology',
      title: 'Mitochondrial dynamics in cardiac tissue',
      abstract:
        'A study of how mitochondrial dynamics respond to metabolic stress in cardiac tissue, using a fluorescence assay across twelve samples.',
      keywords: 'mitochondria, cardiac tissue',
      coverLetter: 'CONFIDENTIAL cover letter that must never be published.',
      correspondingAuthor: JSON.stringify({
        name: 'Radhika Sharma',
        email: 'r.sharma@example.edu',
        affiliation: 'Institute of Cardiac Research',
      }),
      coAuthorsList: JSON.stringify([{ name: 'Arun Patel', affiliation: 'Institute of Cardiac Research' }]),
      suggestedReviewers: JSON.stringify([{ name: 'Prof Nobody', email: 'nobody@example.edu' }]),
      declarations: JSON.stringify({
        originality: true,
        ethicsCompliance: true,
        ethicsApprovalDetails: 'EthicsSentinel ref 2025/114.',
        conflictOfInterest: 'NoneDeclaredSentinel',
      }),
      manuscript: { __file: true, buffer: docx, name: 'Sharma-final-v3.docx' },
    }),
  });
  ok('manuscript submitted', r.status === 201, JSON.stringify(r.json));
  subId = r.json && r.json.submission && r.json.submission.id;

  console.log('\nNothing is public before publication');
  r = await api(`/article/${subId}`);
  ok('an unpublished article 404s on the public site', r.status === 404, `got ${r.status}`);
  ok('the unpublished title does not appear on the 404 page', !r.text.includes('Mitochondrial dynamics in cardiac'));

  console.log('\nStage transitions');
  r = await api(`/api/editorial/submissions/${subId}/decision`, {
    method: 'POST',
    token: editorToken,
    body: { decision: 'accept_skip_review', note: 'Accepted for the smoke test.' },
  });
  ok('accepted into copyediting', r.status === 200, JSON.stringify(r.json));

  console.log('\nCopyediting file rounds');
  r = await api(`/api/editorial/production/submissions/${subId}/files`, {
    method: 'POST',
    token: editorToken,
    form: formData({
      kind: 'copyedit_internal',
      note: 'INTERNALSENTINEL working copy the author must never see.',
      file: { __file: true, buffer: docx, name: 'internal-notes.docx' },
    }),
  });
  ok('editor uploaded an internal working file', r.status === 201, JSON.stringify(r.json));

  r = await api(`/api/editorial/production/submissions/${subId}/files`, {
    method: 'POST',
    token: editorToken,
    form: formData({
      kind: 'copyedit_final',
      note: 'Final copyedited version.',
      needsAuthorAction: 'true',
      file: { __file: true, buffer: docx, name: 'copyedited-final.docx' },
    }),
  });
  ok('editor uploaded the final copyedited file', r.status === 201, JSON.stringify(r.json));

  r = await api(`/api/submissions/${subId}/workflow-files`, { token: authorToken });
  const authorFiles = (r.json && r.json.files) || [];
  ok('the author sees one file, not the internal one', authorFiles.length === 1, JSON.stringify(authorFiles));
  ok('the internal note never reaches the author', !JSON.stringify(authorFiles).includes('INTERNALSENTINEL'));
  ok('the author is told a response is needed', authorFiles[0] && authorFiles[0].needsAuthorAction === true);

  r = await api(`/api/submissions/${subId}/workflow-files`, {
    method: 'POST',
    token: authorToken,
    form: formData({
      kind: 'author_response',
      note: 'Approved with two small corrections.',
      file: { __file: true, buffer: docx, name: 'author-approval.docx' },
    }),
  });
  ok('the author answered the copyedit request', r.status === 201, JSON.stringify(r.json));

  r = await api(`/api/submissions/${subId}/workflow-files`, { token: authorToken });
  const stillWaiting = ((r.json && r.json.files) || []).filter((f) => f.needsAuthorAction && !f.answeredAt);
  ok('answering clears the outstanding request', stillWaiting.length === 0);

  r = await api(`/api/submissions/${subId}/workflow-files`, {
    method: 'POST',
    token: authorToken,
    form: formData({ kind: 'copyedit_draft', file: { __file: true, buffer: docx, name: 'sneaky.docx' } }),
  });
  ok('an author cannot upload into an editor-only slot', r.status === 409, `got ${r.status}`);

  console.log('\nGalleys');
  r = await api(`/api/editorial/production/submissions/${subId}/galleys`, {
    method: 'POST',
    token: editorToken,
    form: formData({ label: 'PDF', file: { __file: true, buffer: Buffer.from('%PDF-1.4 fake'), name: 'article.pdf' } }),
  });
  ok('galleys are refused before production', r.status === 409, `got ${r.status}`);

  r = await api(`/api/editorial/submissions/${subId}/decision`, {
    method: 'POST',
    token: editorToken,
    body: { decision: 'send_to_production' },
  });
  ok('moved to production', r.status === 200, JSON.stringify(r.json));

  r = await api(`/api/editorial/production/submissions/${subId}/galleys`, {
    method: 'POST',
    token: editorToken,
    form: formData({ label: 'PDF', file: { __file: true, buffer: Buffer.from('%PDF-1.4 fake'), name: 'article.pdf' } }),
  });
  ok('PDF galley uploaded in production', r.status === 201, JSON.stringify(r.json));

  r = await api(`/api/editorial/production/submissions/${subId}/galleys`, {
    method: 'POST',
    token: editorToken,
    form: formData({ format: 'html', file: { __file: true, buffer: Buffer.from('%PDF fake'), name: 'mislabelled.pdf' } }),
  });
  ok('a PDF labelled as HTML is refused', r.status === 400, `got ${r.status}`);

  r = await api(`/api/editorial/production/submissions/${subId}/galleys`, { token: editorToken });
  const sources = (r.json && r.json.generateSources) || [];
  ok('the .docx files are offered as generation sources', sources.length >= 2, JSON.stringify(sources));

  const finalSource = sources.find((s) => /Final copyedited/i.test(s.label)) || sources[0];
  r = await api(`/api/editorial/production/submissions/${subId}/galleys/generate`, {
    method: 'POST',
    token: editorToken,
    body: { source: finalSource.ref },
  });
  ok('HTML full text generated', r.status === 201, JSON.stringify(r.json));
  const stats = r.json && r.json.galley && r.json.galley.stats;
  ok('the full text found sections and paragraphs', stats && stats.sections >= 4 && stats.paragraphs >= 5, JSON.stringify(stats));

  r = await api(`/api/editorial/production/submissions/${subId}/galleys/generate`, {
    method: 'POST',
    token: editorToken,
    body: { source: finalSource.ref },
  });
  ok('regenerating replaces rather than duplicates', r.json && r.json.replaced === true);
  ok('there are still exactly two galleys', r.json && r.json.galleys.length === 2, JSON.stringify(r.json && r.json.galleys));

  console.log('\nThe publication gate');
  r = await api(`/api/editorial/submissions/${subId}/decision`, {
    method: 'POST',
    token: editorToken,
    body: { decision: 'publish' },
  });
  ok('publishing is refused without an issue and pages', r.status === 409, `got ${r.status}`);
  ok('the refusal lists every blocker at once', r.json && r.json.blockers && r.json.blockers.length === 2, JSON.stringify(r.json));

  r = await api(`/api/editorial/submissions/${subId}/decision`, {
    method: 'POST',
    token: editorToken,
    body: { decision: 'publish', force: true },
  });
  ok('the publication gate cannot be forced', r.status === 409, `got ${r.status}`);

  console.log('\nIssues');
  r = await api('/api/editorial/production/issues', {
    method: 'POST',
    token: editorToken,
    body: { journalCode: 'alstm', volume: 1, number: 1, year: 2026, title: 'Inaugural Issue' },
  });
  ok('issue created', r.status === 201, JSON.stringify(r.json));
  issueId = r.json && r.json.issue && r.json.issue.id;
  ok('the issue starts planned, not released', r.json && r.json.issue.status === 'planned');

  r = await api('/api/editorial/production/issues', {
    method: 'POST',
    token: editorToken,
    body: { journalCode: 'alstm', volume: 1, number: 1, year: 2027 },
  });
  ok('a duplicate volume/number is refused', r.status === 409, `got ${r.status}`);

  r = await api('/api/editorial/production/issues', {
    method: 'POST',
    token: editorToken,
    body: { journalCode: 'jec', volume: 1, number: 1, year: 2026 },
  });
  ok('the same volume/number in another journal is allowed', r.status === 201, JSON.stringify(r.json));
  const otherIssueId = r.json && r.json.issue && r.json.issue.id;

  r = await api(`/api/editorial/production/issues/${issueId}/status`, {
    method: 'POST',
    token: editorToken,
    body: { status: 'published' },
  });
  ok('an empty issue cannot be released', r.status === 409, `got ${r.status}`);

  r = await api(`/api/editorial/production/submissions/${subId}/publication`, {
    method: 'PATCH',
    token: editorToken,
    body: { issueId: otherIssueId },
  });
  ok("an article cannot be filed into another journal's issue", r.status === 400, `got ${r.status}`);

  r = await api(`/api/editorial/production/submissions/${subId}/publication`, {
    method: 'PATCH',
    token: editorToken,
    body: {
      issueId,
      pages: '1-14',
      doi: 'https://doi.org/10.1234/alstm.2026.001',
      license: 'CC BY 4.0',
      articleOrder: 1,
    },
  });
  ok('publication details saved', r.status === 200, JSON.stringify(r.json));
  ok('a pasted doi.org URL is normalised', r.json && r.json.submission.doi === '10.1234/alstm.2026.001', JSON.stringify(r.json && r.json.submission));
  ok('nothing blocks publication now', r.json && r.json.publishBlockers.length === 0, JSON.stringify(r.json && r.json.publishBlockers));

  console.log('\nPublication');
  r = await api(`/api/editorial/submissions/${subId}/decision`, {
    method: 'POST',
    token: editorToken,
    body: { decision: 'publish' },
  });
  ok('article published', r.status === 200, JSON.stringify(r.json));

  r = await api(`/article/${subId}`);
  ok('an article in an unreleased issue is still not public', r.status === 404, `got ${r.status}`);

  r = await api(`/api/editorial/production/issues/${issueId}/status`, {
    method: 'POST',
    token: editorToken,
    body: { status: 'published' },
  });
  ok('issue released', r.status === 200, JSON.stringify(r.json));

  console.log('\nThe public article page');
  r = await api(`/article/${subId}`);
  const articleHtml = r.text;
  ok('the article page is public', r.status === 200, `got ${r.status}`);
  ok('the title is in the served HTML', articleHtml.includes('Mitochondrial dynamics in cardiac tissue'));
  ok('the abstract is in the served HTML', articleHtml.includes('metabolic stress'));
  ok('the generated full text is rendered', articleHtml.includes('<h2>Materials and Methods</h2>'));
  ek(articleHtml);
  ok('the reference list is rendered', articleHtml.includes('galley-refs'));
  ok('Google Scholar meta tags are present', articleHtml.includes('name="citation_title"'));
  ok('the volume and issue are exposed to Scholar', articleHtml.includes('name="citation_volume" content="1"'));
  ok(
    'the page range is exposed to Scholar',
    articleHtml.includes('name="citation_firstpage" content="1"') &&
      articleHtml.includes('name="citation_lastpage" content="14"')
  );
  ok('the PDF is advertised to Scholar', articleHtml.includes('name="citation_pdf_url"'));
  ok('the citation box is rendered', articleHtml.includes('How to cite'));

  console.log('\nWhat the public page must NOT contain');
  ok('no cover letter', !articleHtml.includes('CONFIDENTIAL cover letter'));
  ok('no suggested reviewers', !articleHtml.includes('Prof Nobody'));
  ok('no conflict-of-interest free text', !articleHtml.includes('NoneDeclaredSentinel'));
  ok('no ethics-approval free text', !articleHtml.includes('EthicsSentinel'));
  ok('no internal copyediting note', !articleHtml.includes('INTERNALSENTINEL'));
  ok('no original manuscript filename', !articleHtml.includes('Sharma-final-v3.docx'));
  ok('the hostile script tag is escaped, not live', !articleHtml.includes('<script>alert(1)</script>'));
  ok('...and its escaped form is present, proving the text rendered', articleHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  console.log('\nArchive, table of contents and feeds');
  r = await api('/archive/alstm');
  ok('the archive lists the released issue', r.status === 200 && r.text.includes('Vol. 1, No. 1 (2026)'), `got ${r.status}`);

  r = await api(`/issue/${issueId}`);
  ok('the table of contents renders', r.status === 200 && r.text.includes('Mitochondrial dynamics'), `got ${r.status}`);

  r = await api('/api/public/latest?journal=alstm');
  ok('the latest-articles feed returns the article', r.json && r.json.articles.length === 1, JSON.stringify(r.json));
  ok('the feed leaks nothing confidential', !JSON.stringify(r.json).includes('CONFIDENTIAL'));

  r = await api('/sitemap.xml');
  ok('the sitemap includes the article', r.text.includes(`/article/${subId}`));

  r = await api(`/article/${subId}/galley/nonexistent`);
  ok('an unknown galley 404s', r.status === 404, `got ${r.status}`);

  console.log('\nWithdrawing an issue takes its articles offline again');
  r = await api(`/api/editorial/production/issues/${issueId}/status`, {
    method: 'POST',
    token: editorToken,
    body: { status: 'planned' },
  });
  ok('issue withdrawn', r.status === 200, JSON.stringify(r.json));
  r = await api(`/article/${subId}`);
  ok('the article is no longer public', r.status === 404, `got ${r.status}`);

  console.log('\nAccess control');
  r = await api(`/api/editorial/production/submissions/${subId}/files`, { token: authorToken });
  ok('an author cannot reach the editorial production API', r.status === 403, `got ${r.status}`);
  r = await api('/api/editorial/production/issues');
  ok('an anonymous caller cannot list issues', r.status === 401, `got ${r.status}`);

  console.log(`\n${checks - fails} passed, ${fails} failed\n`);
  process.exit(fails ? 1 : 0);
}

// Asserts the full text rendered as prose rather than as one run-on blob.
function ek(html) {
  ok('the full text is split into paragraphs', (html.match(/<p>/g) || []).length >= 5);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
