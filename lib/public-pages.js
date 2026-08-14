// Server-rendered HTML for the public archive.
//
// WHY SERVER-RENDERED, when the rest of the site is static pages calling an
// API from the browser:
//
// A published article that search engines cannot read has not really been
// published. Google Scholar in particular does not execute JavaScript -- it
// reads the HTML it is served, looks for citation_* meta tags, and indexes
// the full text it can see. A client-rendered article page is, to Scholar, a
// blank document. For a journal, indexing is not a nice-to-have; it is the
// distribution channel.
//
// So these three page types are built here, as strings, on the server. They
// reuse assets/style.css so they match the rest of the site, and they carry
// no application JavaScript at all.
//
// ESCAPING: everything interpolated goes through esc(). The single exception
// is a generated HTML galley, which was itself produced by lib/galley.js from
// escaped plain text -- see the comment at the injection point. Uploaded HTML
// is never rendered here; it is served as a download by routes/public.js.

const { JOURNALS } = require('./journals');
const { issueLabel, issueShortLabel, citationFor } = require('./issues');
const { SITE_URL } = require('../config');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function attr(s) {
  return esc(s);
}

function fmtDate(d) {
  if (!d) return '';
  const parsed = new Date(d);
  if (isNaN(parsed)) return String(d);
  return parsed.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

// YYYY/MM/DD -- the format Google Scholar expects in citation_publication_date.
function scholarDate(d) {
  if (!d) return '';
  const parsed = new Date(d);
  if (isNaN(parsed)) return '';
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  return `${parsed.getFullYear()}/${mm}/${dd}`;
}

const NAV_JOURNALS = Object.keys(JOURNALS)
  .map((code) => `<a href="/journals/${esc(code)}.html">${esc(JOURNALS[code])}</a>`)
  .join('\n          ');

// The site chrome, shared by all three page types. Kept deliberately smaller
// than the marketing pages' navigation: a reader who arrived from a search
// result wants the article, a way back to the journal, and nothing else.
function shell({ title, description, head, breadcrumb, bodyHtml, canonical }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${attr(description)}">` : ''}
${canonical ? `<link rel="canonical" href="${attr(canonical)}">` : ''}
<link rel="icon" type="image/svg+xml" href="/assets/logo/favicon.svg">
<link rel="stylesheet" href="/assets/style.css">
${head || ''}
<style>
  .archive-wrap { max-width: 980px; margin: 0 auto; }
  .crumb { font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
  .crumb a { color: var(--teal); text-decoration: none; font-weight: 600; }
  .crumb a:hover { text-decoration: underline; }
  .issue-row { display:flex; justify-content:space-between; gap:16px; align-items:baseline;
    padding:14px 0; border-bottom:1px solid var(--line); }
  .issue-row:last-child { border-bottom:none; }
  .issue-row h3 { margin:0 0 3px; font-size:16px; }
  .issue-row a { color: var(--ink); text-decoration:none; }
  .issue-row a:hover { color: var(--teal); }
  .toc-item { padding:16px 0; border-bottom:1px solid var(--line); }
  .toc-item:last-child { border-bottom:none; }
  .toc-item h3 { margin:0 0 5px; font-size:16.5px; line-height:1.35; }
  .toc-item h3 a { color: var(--ink); text-decoration:none; }
  .toc-item h3 a:hover { color: var(--teal); }
  .toc-authors { font-size:13px; color:var(--muted); margin-bottom:6px; }
  .toc-meta { font-size:12px; color:var(--muted); }
  .article-head h1 { font-family:Georgia,serif; font-size:27px; line-height:1.3; margin:0 0 12px; }
  .article-authors { font-size:14.5px; margin-bottom:4px; }
  .article-affils { font-size:12.5px; color:var(--muted); margin-bottom:16px; }
  .article-affils div { margin-bottom:2px; }
  .galley-links { display:flex; gap:10px; flex-wrap:wrap; margin:18px 0 4px; }
  .fulltext { margin-top:26px; font-size:15px; line-height:1.72; }
  .fulltext h2 { font-family:Georgia,serif; font-size:18px; margin:28px 0 10px;
    padding-bottom:6px; border-bottom:1px solid var(--line); }
  .fulltext p { margin:0 0 14px; }
  .fulltext ol.galley-refs { padding-left:22px; font-size:13.5px; line-height:1.6; }
  .fulltext ol.galley-refs li { margin-bottom:8px; }
  .cite-box { background:var(--bg-soft); border:1px solid var(--line); border-radius:6px;
    padding:14px 16px; font-size:13px; line-height:1.6; margin-top:22px; }
  .cite-box .k { font-size:11px; text-transform:uppercase; letter-spacing:.05em;
    color:var(--muted); font-weight:700; margin-bottom:6px; }
  .empty-archive { padding:40px 0; text-align:center; color:var(--muted); font-size:14px; }
</style>
</head>
<body data-base="/">

<div class="utility">
  <div class="wrap">
    <div class="issn"><a class="home-link" href="/index.html">Aaranya Scholarly LLP</a></div>
    <div class="promise">Open Access<span class="sep">&hellip;</span> Open Science<span class="sep">&hellip;</span> Open to All<span class="sep">&hellip;</span></div>
    <div class="social"><a href="/index.html">Home</a></div>
  </div>
</div>

<header class="main">
  <div class="wrap">
    <div class="logo-mark"><img src="/assets/logo/mark-reversed.svg" alt="Aaranya Scholarly"></div>
    <div class="title-block">
      <h1>${esc(title)}</h1>
    </div>
    <a class="btn btn-outline" href="/index.html">All Journals</a>
  </div>
</header>

<section class="section">
  <div class="wrap archive-wrap">
    ${breadcrumb ? `<div class="crumb">${breadcrumb}</div>` : ''}
    ${bodyHtml}
  </div>
</section>

<footer>
  <div class="wrap footer-grid">
    <div>
      <img class="foot-logo" src="/assets/logo/lockup-reversed.svg" alt="Aaranya Scholarly">
      <p>Open Access&hellip; Open Science&hellip; Open to All&hellip;<br>Transforming Research into Global Impact.</p>
    </div>
    <div>
      <h4>Journals</h4>
      ${NAV_JOURNALS}
    </div>
  </div>
  <div class="wrap foot-bottom">
    <span>© ${new Date().getFullYear()} Aaranya Scholarly LLP. All Rights Reserved.</span>
  </div>
</footer>

</body>
</html>`;
}

function authorLine(authors) {
  return (authors || []).map((a) => esc(a.name)).join(', ');
}

// ---- Archive: every released issue of one journal ----

function archivePage({ journalCode, issues }) {
  const journalName = JOURNALS[journalCode] || journalCode;
  const rows = issues.length
    ? issues
        .map(
          (i) => `<div class="issue-row">
      <div>
        <h3><a href="/issue/${esc(i.id)}">${esc(issueLabel(i))}</a></h3>
        ${i.description ? `<div class="toc-meta">${esc(i.description)}</div>` : ''}
      </div>
      <div class="toc-meta">${i.articleCount} article${i.articleCount === 1 ? '' : 's'}${
            i.publishedAt ? ` · ${esc(fmtDate(i.publishedAt))}` : ''
          }</div>
    </div>`
        )
        .join('\n')
    : `<div class="empty-archive">No issues have been published yet.<br>
       <a href="/journals/${esc(journalCode)}.html" style="color:var(--teal);font-weight:600;">See the journal's aims and scope</a></div>`;

  return shell({
    title: journalName,
    description: `Published issues and articles of ${journalName}, an open-access journal from Aaranya Scholarly LLP.`,
    canonical: `${SITE_URL}/archive/${journalCode}`,
    breadcrumb: `<a href="/index.html">Home</a> › <a href="/journals/${esc(journalCode)}.html">${esc(journalName)}</a> › Archive`,
    bodyHtml: `<div class="panel">
      <div class="panel-head"><div><h3>Archive</h3><p class="panel-sub">All published issues, most recent first.</p></div></div>
      ${rows}
    </div>`,
  });
}

// ---- One issue: its table of contents ----

function issuePage({ issue, articles }) {
  const journalName = JOURNALS[issue.journalCode] || issue.journalCode;
  const items = articles.length
    ? articles
        .map(
          (a) => `<div class="toc-item">
      <h3><a href="/article/${esc(a.id)}">${esc(a.title)}</a></h3>
      <div class="toc-authors">${authorLine(a.authors)}</div>
      <div class="toc-meta">${esc(a.articleType || '')}${a.pages ? ` · pp. ${esc(a.pages)}` : ''}${
            a.doi ? ` · <a href="https://doi.org/${attr(a.doi)}" style="color:var(--teal);">https://doi.org/${esc(a.doi)}</a>` : ''
          }</div>
    </div>`
        )
        .join('\n')
    : '<div class="empty-archive">This issue has no articles yet.</div>';

  return shell({
    title: `${journalName} — ${issueLabel(issue)}`,
    description: `Table of contents for ${issueLabel(issue)} of ${journalName}.`,
    canonical: `${SITE_URL}/issue/${issue.id}`,
    breadcrumb: `<a href="/index.html">Home</a> › <a href="/journals/${esc(issue.journalCode)}.html">${esc(journalName)}</a> › <a href="/archive/${esc(issue.journalCode)}">Archive</a> › ${esc(issueShortLabel(issue))}`,
    bodyHtml: `<div class="panel">
      <div class="panel-head">
        <div>
          <h3>${esc(issueLabel(issue))}</h3>
          <p class="panel-sub">${esc(journalName)}${issue.publishedAt ? ` · published ${esc(fmtDate(issue.publishedAt))}` : ''}</p>
        </div>
      </div>
      ${issue.description ? `<p style="font-size:13.5px;color:var(--ink);margin:0 0 16px;">${esc(issue.description)}</p>` : ''}
      ${items}
    </div>`,
  });
}

// ---- One article ----

// Google Scholar's inclusion guidelines: citation_title, citation_author (one
// tag per author), citation_publication_date, citation_journal_title,
// citation_volume, citation_issue, citation_firstpage/lastpage, and a link to
// the full text. Getting these wrong is the difference between being indexed
// and being invisible.
function scholarMeta({ article, issue, journalName, pdfUrl, htmlUrl }) {
  const tags = [];
  const add = (name, content) => {
    if (content) tags.push(`<meta name="${attr(name)}" content="${attr(content)}">`);
  };

  add('citation_title', article.title);
  (article.authors || []).forEach((a) => add('citation_author', a.name));
  add('citation_publication_date', scholarDate(article.publishedAt || (issue && issue.publishedAt)));
  add('citation_journal_title', journalName);
  add('citation_publisher', 'Aaranya Scholarly LLP');
  if (issue) {
    add('citation_volume', String(issue.volume));
    add('citation_issue', String(issue.number));
  }
  const pages = String(article.pages || '');
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(pages);
  if (range) {
    add('citation_firstpage', range[1]);
    add('citation_lastpage', range[2]);
  } else if (/^\d+$/.test(pages.trim())) {
    add('citation_firstpage', pages.trim());
  }
  if (article.doi) add('citation_doi', article.doi);
  if (pdfUrl) add('citation_pdf_url', pdfUrl);
  if (htmlUrl) add('citation_fulltext_html_url', htmlUrl);
  add('citation_abstract_html_url', `${SITE_URL}/article/${article.id}`);
  (article.keywords ? String(article.keywords).split(/[;,]/) : [])
    .map((k) => k.trim())
    .filter(Boolean)
    .forEach((k) => add('citation_keywords', k));

  // Open Graph, so a shared link looks like an article rather than a URL.
  tags.push(`<meta property="og:type" content="article">`);
  tags.push(`<meta property="og:title" content="${attr(article.title)}">`);
  if (article.abstract) {
    tags.push(
      `<meta property="og:description" content="${attr(String(article.abstract).slice(0, 300))}">`
    );
  }
  tags.push(`<meta property="og:url" content="${attr(`${SITE_URL}/article/${article.id}`)}">`);

  return tags.join('\n');
}

function articlePage({ article, issue, fullTextHtml }) {
  const journalName = article.journalName || JOURNALS[article.journalCode] || article.journalCode;
  const galleys = article.galleys || [];
  const pdf = galleys.find((g) => g.format === 'pdf');
  const generatedHtml = galleys.find((g) => g.format === 'html' && g.source === 'generated');

  const pdfUrl = pdf ? `${SITE_URL}/article/${article.id}/galley/${pdf.id}` : '';
  const htmlUrl = generatedHtml ? `${SITE_URL}/article/${article.id}` : '';

  const affiliations = (article.authors || [])
    .filter((a) => a.affiliation)
    .map(
      (a) =>
        `<div>${esc(a.name)} — ${esc(a.affiliation)}${
          a.corresponding && a.email
            ? ` · <a href="mailto:${attr(a.email)}" style="color:var(--teal);">${esc(a.email)}</a>`
            : ''
        }</div>`
    )
    .join('\n');

  const galleyLinks = galleys
    .map((g) => {
      const isReadable = g.source === 'generated' && g.format === 'html';
      if (isReadable) return ''; // rendered inline below, no download link needed
      return `<a class="btn btn-navy btn-sm" href="/article/${esc(article.id)}/galley/${esc(g.id)}">${esc(g.label)}</a>`;
    })
    .filter(Boolean)
    .join('\n      ');

  const citation = citationFor(article, issue, journalName);

  const metaRows = [
    ['Journal', journalName],
    ['Issue', issue ? issueLabel(issue) : ''],
    ['Pages', article.pages],
    ['Article type', article.articleType],
    ['Published', fmtDate(article.publishedAt || (issue && issue.publishedAt))],
    ['DOI', article.doi ? `https://doi.org/${article.doi}` : ''],
    ['Licence', article.license],
  ]
    .filter((r) => r[1])
    .map(
      (r) =>
        `<div><div class="k">${esc(r[0])}</div><div class="v">${
          r[0] === 'DOI'
            ? `<a href="${attr(r[1])}" style="color:var(--teal);">${esc(r[1])}</a>`
            : esc(r[1])
        }</div></div>`
    )
    .join('\n');

  // fullTextHtml is injected unescaped. It is safe because it can only ever
  // be the output of lib/galley.js, which builds every node itself from
  // escaped plain text -- there is no path by which author-supplied markup
  // reaches this string. Uploaded .html galleys deliberately do NOT come
  // through here; routes/public.js serves those as sandboxed downloads.
  const fullText = fullTextHtml
    ? `<div class="panel">
      <h3>Full text</h3>
      <p class="panel-sub">Generated from the accepted manuscript for reading and indexing. The PDF is the version of record.</p>
      <div class="fulltext">${fullTextHtml}</div>
    </div>`
    : '';

  return shell({
    title: article.title,
    description: String(article.abstract || '').slice(0, 300),
    canonical: `${SITE_URL}/article/${article.id}`,
    head: scholarMeta({ article, issue, journalName, pdfUrl, htmlUrl }),
    breadcrumb: `<a href="/index.html">Home</a> › <a href="/journals/${esc(article.journalCode)}.html">${esc(journalName)}</a> › <a href="/archive/${esc(article.journalCode)}">Archive</a>${
      issue ? ` › <a href="/issue/${esc(issue.id)}">${esc(issueShortLabel(issue))}</a>` : ''
    }`,
    bodyHtml: `<div class="panel article-head">
      <h1>${esc(article.title)}</h1>
      <div class="article-authors">${authorLine(article.authors)}</div>
      ${affiliations ? `<div class="article-affils">${affiliations}</div>` : ''}
      ${galleyLinks ? `<div class="galley-links">${galleyLinks}</div>` : ''}
    </div>

    <div class="panel">
      <h3>Abstract</h3>
      <div style="font-size:14px;line-height:1.7;white-space:pre-wrap;">${esc(article.abstract)}</div>
      ${article.keywords ? `<div style="margin-top:14px;font-size:13px;"><b>Keywords:</b> ${esc(article.keywords)}</div>` : ''}
      <div class="meta-grid" style="margin-top:18px;">${metaRows}</div>
      <div class="cite-box"><div class="k">How to cite</div>${esc(citation)}</div>
    </div>

    ${fullText}`,
  });
}

// A plain 404 that still looks like the site. Public pages must never leak
// whether an id exists but is unpublished, so this is what both cases get.
function notFoundPage(what) {
  return shell({
    title: 'Not found',
    bodyHtml: `<div class="panel"><h3>Not found</h3>
      <p class="panel-sub">This ${esc(what || 'page')} does not exist, or has not been published yet.</p>
      <div style="margin-top:14px;"><a class="btn btn-navy btn-sm" href="/index.html">Back to the journals</a></div>
    </div>`,
  });
}

module.exports = {
  esc,
  scholarDate,
  shell,
  archivePage,
  issuePage,
  articlePage,
  scholarMeta,
  notFoundPage,
};
