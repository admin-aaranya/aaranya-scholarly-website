# Copyediting, production, issues and the public archive

What happens to a manuscript after it is accepted, and how it reaches a
reader. This covers the two stages the editorial workflow used to pass
through without doing anything — Copyediting and Production — plus the issue
assembly and public article pages they feed.

Peer review is documented in the main [README](../README.md); nothing here
changes it.

---

## The shape of it

```
  Accepted
     │
     ▼
  COPYEDITING ──── file rounds ────►  editor sends a copyedited draft
     │                                author answers it
     │                                editor marks a version final
     ▼
  PRODUCTION  ──── galleys ────────►  upload the typeset PDF
     │                                (optionally) generate HTML full text
     │            publication  ─────►  assign to an issue, record pages/DOI
     ▼
  PUBLISHED   ──── gated ──────────►  needs a galley + an issue + pages
     │
     ▼
  Issue RELEASED ──────────────────►  the article becomes publicly readable
```

Two gates, deliberately separate:

- **Publishing an article** is an editorial act. It says the article is
  finished.
- **Releasing an issue** is a publishing act. It says the world may read it.

An article can sit published-but-invisible for weeks while the rest of its
issue is assembled. That is how journals actually work, and it means the
"go live" moment is one click on one object rather than a scramble across
twelve articles.

---

## Copyediting: file rounds

After acceptance the exchange with the author stops being "upload a revision"
and becomes a conversation conducted in files. Each file has a **kind**, and
the kind decides three things — all enforced server-side, in
`lib/workflow.js`:

| Kind | Stage | Uploaded by | Author can see it |
|---|---|---|---|
| Copyedited draft | Copyediting | Editor | **Yes** |
| Internal working file | Copyediting | Editor | **No** |
| Author response | Copyediting | Author | Yes |
| Final copyedited manuscript | Copyediting | Editor | **Yes** |
| Production-ready file | Production | Editor | **No** |
| Proof for the author | Production | Editor | **Yes** |
| Author corrections to proof | Production | Author | Yes |

**Visibility is a property of the kind, not a checkbox.** An editor needs
somewhere to put a working file the author should not read yet, and the
failure mode of a per-upload toggle is one mis-click showing an author an
internal draft. Choosing "Internal working file" is the only way to get an
invisible file, and it says so on the upload form.

The author's view is built by `authorVisibleFiles()`, which filters by kind
and then rebuilds each record from a whitelist — no storage keys, no editor
names, no ids.

### "Ask the author to respond"

Ticking this on an author-visible file does two things: emails the author, and
flags the file on their submission page. Files shared *without* it appear
silently on the author's page and send nothing.

That distinction matters. An author emailed about every internal file
movement stops reading the mail, and the one message that actually needed
them goes unread with it.

The flag clears automatically when the author uploads a response at the same
stage. (A regression here — the flag never clearing — is exactly what the
end-to-end test caught during development; `answeredAt` has to travel with
`needsAuthorAction` into the author's view or the dashboard says "response
needed" forever.)

### Copyediting kinds stay available in Production

Work that should have been filed during copyediting still has to go
somewhere once the manuscript has moved on. The alternative is an editor
pushing the stage backwards just to attach a file, which corrupts the stage
history for no benefit. The reverse is not allowed: no production files
before production.

---

## Galleys

A galley is the reader-facing rendition — the thing someone opens. **An
article cannot be published without at least one.**

Two ways to get one:

### 1. Upload (the normal case)

PDF, HTML or XML. The format is taken from the file extension; a `.pdf`
labelled "HTML" is refused rather than stored with a lie attached, because
the format decides how the file is served.

### 2. Generate an HTML full text

`lib/galley.js` builds a structured HTML reading copy from any `.docx`
already in the workflow — the final copyedited file, an author revision, or
the original manuscript. It detects section headings (known section names,
numbered headings, short all-caps lines), turns the reference section into an
ordered list, and escapes everything else into paragraphs.

**What it is for:** search engines. Google Scholar and Google index the text
they are served. An article whose only rendition is a PDF behind a download
link is far harder to find, and being found is the entire distribution
channel for a journal.

**What it is not:** a typesetting engine. It works from plain text (via
`lib/docx-text.js`), so it does not reproduce figures, equations or table
layout. The UI says so, and the article page labels the PDF as the version of
record. Regenerating replaces the previous HTML rather than stacking a second
"full text" link next to the first.

### Why generated and uploaded galleys are treated differently

This is a security boundary, not bookkeeping.

- A **generated** galley was built by us, from escaped plain text. Every tag
  in it is one we emitted. It is safe to render inside our own page, so the
  article page injects it directly — which is what makes the full text
  crawlable and styled like the rest of the site.
- An **uploaded** galley is a third party's file. Rendering an uploaded
  `.html` on `aaranyascholarly.com` would let it run script on our origin and
  read the `localStorage` session token of any editor who clicked through. So
  uploaded galleys are **only ever served as downloads**, with
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`.

PDFs are the one inline exception, because a browser's PDF viewer is itself
sandboxed and readers expect to click a PDF and see it.

There is a test asserting that a manuscript containing `<script>alert(1)</script>`
comes out of the generator escaped. If that test ever fails, a submitted
Word file has become stored XSS on the journal's own domain.

---

## Issues

An issue is `journal + volume + number + year`, optionally with a special-issue
title and a description.

- Two issues with the same **journal, volume and number** collide, whatever
  year is attached — a repeated volume/number makes every citation to the
  first one ambiguous.
- The same volume and number in a *different* journal is fine.
- An issue starts **planned** (invisible) and is later **released**.
- A released issue cannot be deleted, and an issue with articles assigned
  cannot be deleted.
- An issue with no published articles cannot be released — that would put an
  empty table of contents on the public site.

Managed at **`editor-issues.html`**, linked from the editorial dashboard.

### Withdrawing an issue

Setting a released issue back to *planned* takes every article in it offline
immediately. Links already shared will 404. The UI says this before it lets
you do it. It exists because the alternative — no way back — means a serious
error stays public while someone works out what to do.

---

## Publication metadata and the gate

Each article carries `issueId`, `pages`, `doi`, `license` and `articleOrder`,
set from the **Publication Details** panel on the editor's submission page.

DOIs are stored bare (`10.1234/alstm.2026.001`). A pasted `https://doi.org/…`
URL is normalised rather than rejected, so half the records don't end up
carrying a prefix the other half don't.

The **Publish** decision is refused unless:

1. the article has at least one galley,
2. it is assigned to an issue that still exists, and
3. it has a page range.

Unlike the "reviews still outstanding" warning, **this cannot be forced.**
Every blocker on that list would produce a public page that is broken rather
than merely early — a "read the article" link with nothing behind it, or a
citation with no volume. Forcing past it puts the damage where the editor
cannot see it and the reader can. All blockers are reported at once, and the
Publish button is disabled with the reason shown next to it rather than
hidden.

`publishedAt` is stamped once, on the first Publish. Re-publishing after a
correction does not re-date the article, because a changed publication date
breaks every citation already made to it.

---

## The public archive

Three page types, all **server-rendered** (`lib/public-pages.js`,
`routes/public.js`):

| URL | What it is |
|---|---|
| `/archive/:journalCode` | Every released issue of one journal |
| `/issue/:id` | An issue's table of contents |
| `/article/:id` | The article: abstract, metadata, citation, full text |
| `/article/:id/galley/:galleyId` | A galley file |

Plus read-only JSON under `/api/public/…` (used by the journal pages' "latest
articles" strip via `assets/archive.js`), a `/sitemap.xml` covering every
public URL, and `/robots.txt`.

### Why server-rendered, when the rest of the site is not

The rest of this site is static HTML calling an API from the browser. These
three are not, and the reason is narrow: **Google Scholar does not execute
JavaScript.** It reads the HTML it is served, looks for `citation_*` meta
tags, and indexes the full text it can see. A client-rendered article page is,
to Scholar, a blank document.

So the article page emits `citation_title`, one `citation_author` per author,
`citation_publication_date`, `citation_journal_title`, `citation_volume`,
`citation_issue`, `citation_firstpage`/`citation_lastpage`, `citation_doi`,
`citation_pdf_url` and `citation_keywords`, plus Open Graph tags so a shared
link looks like an article. These pages carry no application JavaScript at
all.

### One visibility rule

An article is public when, and only when:

- the editor has recorded the Publish decision (`stage === 'published'`), **and**
- the issue it sits in has been released (`issue.status === 'published'`)

Every public route reaches its data through `publicArticle()` or
`publicIssues()` in `routes/public.js`. There is no second path to widen by
accident — which matters here more than anywhere else in the codebase,
because everything upstream of publication lives on the same records: cover
letters, reviewer identities, confidential comments to the editor,
unpublished manuscripts.

Missing, not-published and issue-not-released all return the **same** 404. A
public 404 that distinguished them would confirm that an unpublished
manuscript with that id exists.

### What is published, and what is not

The public object is built by `workflow.publicArticleView()` — a **whitelist**,
built from nothing, for the same reason `reviewerView()` is. A submission
record accumulates fields for years, and a blacklist starts leaking the moment
someone adds a field and forgets this function exists. There is a test that
adds an invented `internalRiskNote` field and asserts it does not appear.

Published: title, abstract, keywords, article type, subject area, author names
and affiliations, the corresponding author's email, DOI, pages, licence,
publication date, and the galley list.

**Not** published: the submitting account, cover letter, suggested reviewers,
editorial decisions and their notes, status history, notifications, the
manuscript and supplementary files, revisions, stage files, and every storage
key.

Two of those are worth a deliberate decision rather than a default:

- **Ethics-approval and conflict-of-interest free text.** Many journals
  publish these. This system does not, because the author wrote them for
  editorial eyes. If you want them public, say so in the author guidelines
  first, then add them to `publicArticleView()`.
- **The corresponding author's email.** Published by default, because it is
  how readers request data — but it is also an invitation to scrapers.
  `publicArticleView(submission, { includeAuthorEmail: false })` turns it off.

Co-author emails are never published under any setting.

---

## No "online first"

An accepted article cannot appear ahead of its issue. This is a real
limitation, not an oversight.

If online-first is wanted, the honest implementation is a standing "Articles
in Press" issue per journal — a second *object*, not a second visibility
rule. A second rule is how confidential material eventually escapes.

---

## Testing

```bash
npm test        # unit tests, no server, no GCP
npm run test:e2e  # boots the app on a throwaway data directory and walks it
```

`test/production.test.js` covers the rules: file visibility, upload
permissions, the publish gate, the public whitelist, issue validation and
collision, and galley HTML escaping.

`test/e2e.js` walks a manuscript from submission to a live public article page
against a real server — the seams unit tests cannot reach: multipart uploads,
file storage, route wiring, and what actually appears in the served HTML. It
asserts both directions: that the article renders, *and* that the cover
letter, suggested reviewers, internal notes, original filename and a hostile
`<script>` tag do not.

It runs against a temporary directory, so it never touches your own `data/`.

---

## Where things live

| File | What it holds |
|---|---|
| `lib/workflow.js` | File kinds and visibility, galley formats, publish gate, `publicArticleView` |
| `lib/issues.js` | Issue validation, collision, labelling, sorting, citations |
| `lib/galley.js` | Word → structured HTML, with the escaping that makes it safe |
| `lib/public-pages.js` | Server-rendered archive, issue and article HTML |
| `lib/editor-scope.js` | The editor guard shared by both editorial routers |
| `routes/production.js` | Stage files, galleys, publication metadata, issues |
| `routes/public.js` | The one visibility rule, and everything public |
| `editor-issues.html` | Issue management |
| `assets/archive.js` | The live "latest articles" strip on each journal page |
