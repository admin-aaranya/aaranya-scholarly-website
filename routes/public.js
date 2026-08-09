// The public archive -- the only part of this system that serves anything to
// someone who is not logged in.
//
// ONE VISIBILITY RULE, ENFORCED IN ONE FUNCTION.
//
// An article is public when, and only when:
//
//   * the editor has recorded the Publish decision (stage === 'published'),
//     AND
//   * the issue it is assigned to has been released (issue.status ===
//     'published')
//
// Every route below reaches its data through publicArticle() or
// publicIssues(), so there is no second path to widen by accident. That
// matters more here than anywhere else in the codebase: everything upstream
// of publication -- reviewer identities, cover letters, confidential comments
// to the editor, unpublished manuscripts -- lives on the same records this
// file reads from.
//
// The shape that leaves this file is built by workflow.publicArticleView(),
// which is a whitelist. Adding a field to a submission cannot leak it here;
// somebody has to go and publish it deliberately.

const express = require('express');

const {
  getSubmissionById,
  getIssueById,
  getIssues,
  getSubmissionsByIssue,
  getPublishedSubmissions,
} = require('../db');
const { streamDownload, readStoredFile } = require('../lib/files');
const { STAGES, publicArticleView, sortGalleys, GALLEY_FORMATS } = require('../lib/workflow');
const { ISSUE_STATUS, sortIssues, sortArticlesInIssue, issueLabel } = require('../lib/issues');
const { JOURNALS, JOURNAL_CODES } = require('../lib/journals');
const pages = require('../lib/public-pages');
const { SITE_URL } = require('../config');

const router = express.Router();

// ---- The visibility rule ----

async function publicIssue(issueId) {
  if (!issueId) return null;
  const issue = await getIssueById(issueId);
  if (!issue || issue.status !== ISSUE_STATUS.PUBLISHED) return null;
  return issue;
}

// Returns { submission, issue } or null. Null covers "does not exist", "not
// published" and "issue not released" identically and on purpose -- a public
// 404 that distinguished them would confirm that an unpublished manuscript
// with that id exists.
async function publicArticle(articleId) {
  const submission = await getSubmissionById(articleId);
  if (!submission || submission.stage !== STAGES.PUBLISHED) return null;
  const issue = await publicIssue(submission.issueId);
  if (!issue) return null;
  return { submission, issue };
}

// Released issues of one journal, each with a count of the articles actually
// visible inside it.
async function publicIssues(journalCode) {
  const all = await getIssues(journalCode);
  const released = all.filter((i) => i.status === ISSUE_STATUS.PUBLISHED);
  const withCounts = await Promise.all(
    released.map(async (issue) => {
      const articles = await getSubmissionsByIssue(issue.id);
      return Object.assign({}, issue, {
        articleCount: articles.filter((a) => a.stage === STAGES.PUBLISHED).length,
      });
    })
  );
  // An issue released before its articles were published would otherwise show
  // as an empty table of contents. Hiding it is kinder than a dead link.
  return sortIssues(withCounts.filter((i) => i.articleCount > 0));
}

async function publicArticlesInIssue(issue) {
  const articles = await getSubmissionsByIssue(issue.id);
  return sortArticlesInIssue(articles.filter((a) => a.stage === STAGES.PUBLISHED)).map((a) =>
    publicArticleView(a)
  );
}

// ---- Generated full-text cache ----
//
// A generated HTML galley is an immutable object in storage (regenerating
// writes a new key), so it can be cached by key without invalidation. The
// bound exists so a crawler walking a large archive cannot grow the heap
// without limit.

const FULLTEXT_CACHE = new Map();
const FULLTEXT_CACHE_MAX = 50;

async function loadFullText(galley) {
  if (!galley || !galley.file) return '';
  const key = galley.file.storedFileName;
  if (FULLTEXT_CACHE.has(key)) return FULLTEXT_CACHE.get(key);

  const buf = await readStoredFile(key);
  const html = buf ? buf.toString('utf8') : '';
  if (FULLTEXT_CACHE.size >= FULLTEXT_CACHE_MAX) {
    FULLTEXT_CACHE.delete(FULLTEXT_CACHE.keys().next().value);
  }
  FULLTEXT_CACHE.set(key, html);
  return html;
}

// Published pages are safe to cache at the edge for a few minutes. Anything
// wrong with an article gets fixed by an editor and is visible within the
// window; the alternative is every crawler hit reaching Firestore.
function cachePublic(res, seconds) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds}`);
}

// ============================================================================
// Rendered pages
// ============================================================================

router.get('/archive/:journalCode', async (req, res, next) => {
  try {
    const code = String(req.params.journalCode || '').toLowerCase();
    if (!JOURNAL_CODES.includes(code)) {
      return res.status(404).type('html').send(pages.notFoundPage('journal'));
    }
    const issues = await publicIssues(code);
    cachePublic(res, 300);
    res.type('html').send(pages.archivePage({ journalCode: code, issues }));
  } catch (err) {
    next(err);
  }
});

router.get('/issue/:id', async (req, res, next) => {
  try {
    const issue = await publicIssue(req.params.id);
    if (!issue) {
      return res.status(404).type('html').send(pages.notFoundPage('issue'));
    }
    const articles = await publicArticlesInIssue(issue);
    cachePublic(res, 300);
    res.type('html').send(pages.issuePage({ issue, articles }));
  } catch (err) {
    next(err);
  }
});

router.get('/article/:id', async (req, res, next) => {
  try {
    const found = await publicArticle(req.params.id);
    if (!found) {
      return res.status(404).type('html').send(pages.notFoundPage('article'));
    }
    const article = publicArticleView(found.submission);
    const generated = sortGalleys(found.submission.galleys || []).find(
      (g) => g.format === 'html' && g.source === 'generated'
    );
    const fullTextHtml = generated ? await loadFullText(generated) : '';

    cachePublic(res, 300);
    res.type('html').send(
      pages.articlePage({ article, issue: found.issue, fullTextHtml })
    );
  } catch (err) {
    next(err);
  }
});

// ---- Galley files ----
//
// SECURITY: a galley is served as a DOWNLOAD, never rendered on this origin.
//
// PDFs are the one exception and are shown inline, because a browser's PDF
// viewer is itself sandboxed and readers expect it. Uploaded HTML and XML are
// third-party documents; rendering them here would let them run script under
// aaranyascholarly.com and read the localStorage token of any editor who
// happens to click through. The CSP and nosniff headers below are the belt to
// the attachment disposition's braces.
//
// Generated HTML is not served through this route at all -- it is rendered
// into the article page above, where we know we produced every tag in it.
router.get('/article/:id/galley/:galleyId', async (req, res, next) => {
  try {
    const found = await publicArticle(req.params.id);
    if (!found) {
      return res.status(404).json({ error: 'Not found.' });
    }
    const galley = (found.submission.galleys || []).find((g) => g.id === req.params.galleyId);
    if (!galley || !galley.file) {
      return res.status(404).json({ error: 'Not found.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    cachePublic(res, 3600);

    const format = GALLEY_FORMATS[galley.format];
    if (format && format.inline) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${downloadName(found.submission, galley)}"`);
    }
    streamDownload(res, galley.file.storedFileName, downloadName(found.submission, galley), next);
  } catch (err) {
    next(err);
  }
});

// A readable filename built from the article, not the editor's upload name --
// "aaranya-alstm-2-1-112.pdf" beats "final FINAL v3 (2).pdf" in a reader's
// downloads folder.
function downloadName(submission, galley) {
  const ext = (/\.[a-z0-9]+$/i.exec(String(galley.file.fileName || '')) || ['.pdf'])[0];
  const slug = String(submission.title || 'article')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${submission.journalCode}-${slug || 'article'}${ext}`;
}

// ============================================================================
// Read-only JSON, for the journal pages' "latest articles" strips
// ============================================================================

router.get('/api/public/journals', (_req, res) => {
  res.json({ journals: JOURNALS });
});

router.get('/api/public/journals/:code/issues', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toLowerCase();
    if (!JOURNAL_CODES.includes(code)) {
      return res.status(404).json({ error: 'Unknown journal.' });
    }
    const issues = await publicIssues(code);
    cachePublic(res, 300);
    res.json({
      journal: { code, name: JOURNALS[code] },
      issues: issues.map((i) => ({
        id: i.id,
        volume: i.volume,
        number: i.number,
        year: i.year,
        title: i.title || '',
        label: issueLabel(i),
        publishedAt: i.publishedAt || '',
        articleCount: i.articleCount,
        url: `/issue/${i.id}`,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/public/issues/:id', async (req, res, next) => {
  try {
    const issue = await publicIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Not found.' });
    const articles = await publicArticlesInIssue(issue);
    cachePublic(res, 300);
    res.json({
      issue: {
        id: issue.id,
        journalCode: issue.journalCode,
        journalName: JOURNALS[issue.journalCode] || issue.journalCode,
        label: issueLabel(issue),
        volume: issue.volume,
        number: issue.number,
        year: issue.year,
        title: issue.title || '',
        description: issue.description || '',
        publishedAt: issue.publishedAt || '',
      },
      articles: articles.map((a) => Object.assign({}, a, { url: `/article/${a.id}` })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/public/articles/:id', async (req, res, next) => {
  try {
    const found = await publicArticle(req.params.id);
    if (!found) return res.status(404).json({ error: 'Not found.' });
    cachePublic(res, 300);
    res.json({
      article: Object.assign(publicArticleView(found.submission), {
        url: `/article/${found.submission.id}`,
      }),
      issue: {
        id: found.issue.id,
        label: issueLabel(found.issue),
        volume: found.issue.volume,
        number: found.issue.number,
        year: found.issue.year,
        url: `/issue/${found.issue.id}`,
      },
    });
  } catch (err) {
    next(err);
  }
});

// The most recently published articles, for the journal landing pages. Cheap
// enough at journal scale to compute per request; the edge cache absorbs the
// crawler traffic.
router.get('/api/public/latest', async (req, res, next) => {
  try {
    const code = String(req.query.journal || '').toLowerCase();
    if (code && !JOURNAL_CODES.includes(code)) {
      return res.status(404).json({ error: 'Unknown journal.' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

    const published = await getPublishedSubmissions(code || null);
    const released = new Map();
    const out = [];
    for (const s of published) {
      if (!s.issueId) continue;
      if (!released.has(s.issueId)) released.set(s.issueId, await publicIssue(s.issueId));
      const issue = released.get(s.issueId);
      if (!issue) continue;
      out.push({ submission: s, issue });
    }

    out.sort(
      (a, b) =>
        new Date(b.submission.publishedAt || b.issue.publishedAt || 0) -
        new Date(a.submission.publishedAt || a.issue.publishedAt || 0)
    );

    cachePublic(res, 300);
    res.json({
      articles: out.slice(0, limit).map(({ submission, issue }) =>
        Object.assign(publicArticleView(submission), {
          url: `/article/${submission.id}`,
          issueLabel: issueLabel(issue),
        })
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Crawler plumbing
// ============================================================================

// Served from the app rather than public/robots.txt so it can point at a
// sitemap. (The file in public/ only reaches the CDN edge when Firebase
// Hosting serves it directly; this route is what a request to the origin
// actually gets.)
router.get('/robots.txt', (_req, res) => {
  cachePublic(res, 3600);
  res.type('text/plain').send(
    `User-agent: *
Allow: /
Allow: /article/
Allow: /issue/
Allow: /archive/

# Author accounts, the editorial workflow and reviewer areas are behind login
# and contain personal data — keep them out of search results.
Disallow: /dashboard.html
Disallow: /submission.html
Disallow: /submit.html
Disallow: /editor.html
Disallow: /editor-submission.html
Disallow: /editor-issues.html
Disallow: /reviewer.html
Disallow: /review.html
Disallow: /api/

Sitemap: ${SITE_URL}/sitemap.xml
`
  );
});

// Every public URL, so a new article is discovered without waiting for a
// crawler to stumble across a link to it.
router.get('/sitemap.xml', async (_req, res, next) => {
  try {
    const urls = [{ loc: `${SITE_URL}/index.html`, priority: '1.0' }];

    for (const code of JOURNAL_CODES) {
      urls.push({ loc: `${SITE_URL}/journals/${code}.html`, priority: '0.8' });
      const issues = await publicIssues(code);
      if (issues.length) urls.push({ loc: `${SITE_URL}/archive/${code}`, priority: '0.7' });
      for (const issue of issues) {
        urls.push({
          loc: `${SITE_URL}/issue/${issue.id}`,
          lastmod: issue.publishedAt,
          priority: '0.6',
        });
        const articles = await getSubmissionsByIssue(issue.id);
        articles
          .filter((a) => a.stage === STAGES.PUBLISHED)
          .forEach((a) => {
            urls.push({
              loc: `${SITE_URL}/article/${a.id}`,
              lastmod: a.publishedAt || issue.publishedAt,
              priority: '0.9',
            });
          });
      }
    }

    const body = urls
      .map(
        (u) =>
          `  <url><loc>${pages.esc(u.loc)}</loc>${
            u.lastmod ? `<lastmod>${pages.esc(String(u.lastmod).slice(0, 10))}</lastmod>` : ''
          }<priority>${u.priority}</priority></url>`
      )
      .join('\n');

    cachePublic(res, 3600);
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
