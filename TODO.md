# Outstanding work

The standing list. Kept in the repo rather than in anyone's head, and
updated as things land — if you are wondering "what is still pending", this
file is the answer, not a memory.

Last reviewed: 14 August 2026

---

## Blocking a real launch

### 1. Assign ISSNs to all seven journals

Every journal page currently reads **"ISSN — to be assigned"** in its
navigation block, and the public article pages carry no ISSN at all.

This matters more than it looks:

- **Indexers require it.** DOAJ, Scopus, Crossref and most national library
  systems will not process an application without one. It is usually the
  first field on the form.
- **It is per journal, not per publisher.** Seven journals means seven
  applications, and a separate ISSN for the online and print versions of the
  same title if you ever produce print.
- **It is free and slow.** In India this goes through the National Science
  Library, CSIR-NISCPR, New Delhi, which issues ISSNs on behalf of the
  international centre. Expect weeks, not days — which is why it is worth
  starting before you need it.
- **They want to see a live site.** Applications ask for the journal URL and
  evidence the journal exists. The pages are live, which is the prerequisite
  that used to be missing.

When they arrive, they go in three places: the journal navigation block on
each `journals/*.html` page, the article landing pages
(`lib/public-pages.js`), and the Scholar citation metadata. Tell me the
numbers and I will wire all three.

### 2. Confirm the default licence, and put it in the author guidelines

The licence field is now a real choice rather than free text, and defaults to
**CC BY 4.0** — the conventional licence for a genuinely open-access journal,
and the one Plan S and most funders expect. Article pages state it and link to
the deed with `rel="license"`.

Two things still outstanding:

- **Confirm CC BY 4.0 is what you actually want.** If you would rather use
  CC BY-NC, know that it fails some funder mandates and is not counted as
  fully open by every indexer. Change `DEFAULT_LICENCE` in
  `lib/publication.js`.
- **Say so in the author guidelines.** A licence chosen per article by an
  editor is not a policy. Authors need to know what they are agreeing to
  before they submit, and DOAJ asks where the licensing terms are published.

### 3. Publish one article end to end

The archive works but is empty. The whole path — submit, accept, copyedit,
generate the galley, assemble an issue, publish, release — has run against a
local server but never fully against production Firestore, Cloud Storage and
Workspace mail.

See `docs/first-publication-walkthrough.md`. `sample-manuscript.docx` is
ready in the parent folder.

---

## Known defects

### 4. Bare-domain paths return 404

`aaranyascholarly.com` redirects to `journals.aaranyascholarly.com`, but only
at the root. `aaranyascholarly.com/article/<id>` returns 404 rather than
following through.

That is the obvious shortening of a citation, and the one people type from
memory. Fix is in GoDaddy: Domain → Forwarding → enable path forwarding.
Keep masking **off**. Verify with `0-RUN-DNS-CHECK.bat`.

---

## Worth doing before promoting the journals

### 5. Confirm which mail path is actually sending

There is an SMTP password in Secret Manager *and* `GMAIL_ENABLED=true` with
Workspace impersonation. One of the two is winning and one is vestigial;
nobody has established which. Mail failures are swallowed by design, so a
misconfiguration is silent — you would simply never hear about submissions.

Step 1 of the publication walkthrough answers this.

### 6. Redirect the web.app address at the Hosting layer

Currently handled in the app (`lib/canonical-host.js`), which works. Doing it
in Firebase Hosting as well would stop the request reaching Cloud Run at all.
Minor.

---

## Feature gaps

None of these block anything. Roughly in the order they would matter.

- **Crossref DOI registration.** DOIs are now minted automatically —
  `prefix/journal.year.volume.number.order`, deterministic so one article can
  never acquire two — but **only once `DOI_PREFIX` is set on the Cloud Run
  service**, and it is deliberately unset. Until you hold a Crossref prefix
  the field stays blank, because a well-formed DOI that resolves nowhere is
  worse than none: authors put it on CVs, and DOAJ and Scopus assessors check
  that a sample of DOIs resolve.

  Note the remaining half even after the prefix arrives: minting the string is
  not registering it. Depositing metadata XML with Crossref on publication
  still does not exist, so a minted DOI stays unresolvable until it does.
- **Figures, tables and equations in the HTML full text.** The generator
  works from plain text, so a generated galley is prose and references only.
  The PDF carries everything else and the article page says so. Fixing it
  properly means a real `.docx` → HTML converter — a much larger dependency
  than anything else here.
- **Full-text search across the archive.** Readers can browse issues and
  follow links; there is no search over published articles.
- **Usage statistics.** Downloads and views per article. Authors ask for
  these, and nothing counts them. This is also what the removed "Most Read"
  tab would need.
- **Online-first publication.** An article cannot appear ahead of its issue.
  The honest fix is a standing "Articles in Press" issue per journal rather
  than a second visibility rule — see `docs/production-and-issues.md`.

---

## Done

Kept short, but worth recording so the same ground is not re-covered.

- Copyediting and production file rounds, galleys, issue assembly, and the
  public archive with Google Scholar metadata
- The AI manuscript assistant, removed entirely — code and cloud resources
- Custom domain live, canonical, with every other host redirecting to it
- Source on GitHub, private, and CI/CD deploying on push with no stored key
- Reviewer reminders confirmed running (Cloud Scheduler, daily 08:00 IST)
- Journal landing pages rebuilt to lead with content
