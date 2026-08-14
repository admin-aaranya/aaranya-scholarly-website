# Aaranya Scholarly LLP — website + author registration

This folder is a complete, self-hosted website: the public journal pages (static
HTML/CSS) plus a small Node.js backend that powers real author accounts, login,
and manuscript submission.

## What's in here

- `index.html`, `journals/*.html` — the public publisher hub and 7 journal pages.
- `register.html`, `login.html`, `dashboard.html`, `submit.html` — the author
  account flow.
- `editor.html`, `editor-submission.html`, `editor-issues.html` — the
  editorial dashboard, the per-submission workspace (reviewers, decisions,
  copyediting files, galleys, publication details), and issue assembly.
- `reviewer.html`, `review.html` — the reviewer's queue and review form.
- `routes/public.js`, `lib/public-pages.js` — the public archive: server-
  rendered issue and article pages at `/archive/…`, `/issue/…`, `/article/…`,
  plus a sitemap. The only part of the system that serves anyone not logged
  in, and the only place the publication visibility rule lives.
- `lib/galley.js` — builds an indexable HTML full text from an accepted
  `.docx`. `lib/issues.js` — issue validation, labelling and citations.
- `Dockerfile`, `.github/workflows/deploy.yml`, `docs/gcp-deploy-setup.md` —
  container build and the CI/CD pipeline that deploys to Cloud Run.
- `server.js` + `routes/`, `middleware/`, `lib/`, `db.js`, `config.js` — the
  backend API. `lib/workflow.js` holds the editorial state machine and the
  anonymity rules; `test/` covers both. `db.js` and `lib/files.js` each pick
  between a cloud and a local backend at boot.
- `data/` — local development only: JSON datastore, uploaded files, and the
  auto-generated JWT secret. Gitignored; delete it to reset.
- `data/` — local-dev only. Holds the auto-generated JWT signing secret when
  running with `npm start` on your own machine. Gitignored.

In production, accounts and submissions live in **Firestore** and uploaded
files in **Cloud Storage**. Locally, both fall back to plain files under
`data/` so the site runs with nothing installed but Node — see
"Running it locally" below.

## Running it locally

All you need is [Node.js](https://nodejs.org) 18 or newer. No Google Cloud
account, no credentials, no emulator.

```bash
cd website
npm install
npm start
```

Then open **http://localhost:4000** in a browser. (Open it through that URL —
double-clicking `index.html` won't work, because the registration, login, and
submission forms all need the server running.)

To bootstrap yourself as an editor on first run, set `EDITOR_EMAILS` to the
address you're going to register with:

```bash
# macOS / Linux
EDITOR_EMAILS="you@example.com" npm start

# Windows PowerShell
$env:EDITOR_EMAILS="you@example.com"; npm start
```

Register with that address and you'll land with both the author and editor
roles, and the **Editorial Dashboard** button will appear on your dashboard.

To use a different port: `PORT=8080 npm start`.

### What's different locally

The app picks its backends at boot based on what's configured, and logs which
ones it chose:

| | Local (no config) | Production |
|---|---|---|
| Database | JSON files in `data/` | Firestore |
| Uploaded files | `data/uploads/` | Cloud Storage |
| Email | Printed to the console | Sent via SendGrid |

Everything works locally except actually delivering email — instead, each
message is printed to the terminal in full, so you can read exactly what a
reviewer would have received. That's usually more useful than a real send
while developing.

`data/` is gitignored. Delete it to reset to a clean slate.

To run locally against a **real** Firestore project instead, authenticate
first and the app will pick it up automatically:

```bash
gcloud auth application-default login
GOOGLE_CLOUD_PROJECT=your-project-id npm start
```

## Putting this online

This site deploys to **Google Cloud Run**, backed by **Firestore** (accounts,
submissions) and **Cloud Storage** (uploaded files), with **Firebase Hosting**
in front for CDN, SSL, and the custom domain. It's built as a container
(`Dockerfile`) and deployed automatically by GitHub Actions
(`.github/workflows/deploy.yml`) on every push to `main`.

> **Firebase Hosting cannot run this site by itself.** It serves static files
> only, and this is an Express server with accounts and file uploads.
> Hosting proxies every request through to Cloud Run — see
> `docs/firebase-deploy.md`. A bare `firebase deploy` without the Cloud Run
> service behind it produces journal pages with dead login forms.

- One-time GCP setup (Artifact Registry, Firestore, the manuscripts bucket,
  the Secret Manager entries for `JWT_SECRET` and `SENDGRID_API_KEY`, and
  CI/CD's Workload Identity Federation auth): follow
  **`docs/gcp-deploy-setup.md`** top to bottom.
- Then put Firebase Hosting in front: **`docs/firebase-deploy.md`**. That doc
  also covers the custom domain and a **60-second request timeout** that
  affects large manuscript uploads — worth reading before you take real
  submissions.
- After that, deploys are just `git push` — no manual `gcloud` commands, and
  the project's admin/root login is never used by the pipeline.
- `JWT_SECRET` is bound from Secret Manager at deploy time (see the setup
  doc) — it's never checked into git or baked into the image. Locally it
  falls back to an auto-generated `data/jwt_secret.txt` for convenience.

## Manuscript submission

`submit.html` is a five-step wizard (Journal & Type → Manuscript Details →
Authors → Files & Declarations → Review & Submit) that captures:

- Journal + article type (Original Research, Review, Case Report, etc.) + optional subject area
- Title, abstract, keywords
- A structured corresponding author (pre-filled from the account) plus any
  number of co-authors
- The manuscript file (PDF/Word, required) and up to 5 supplementary files
- An optional cover letter and suggested reviewers
- Required declarations (originality, publication-ethics compliance) plus
  optional ethical-approval details and a conflict-of-interest statement

Every submission gets a status timeline (starts at "Submitted");
`submission.html?id=...` shows the full record, the author's own copyediting
and proof files, and lets them re-download everything. The editor and
reviewer sides that move a submission onward are covered under "Editorial
workflow" below.

## How accounts work

- One shared "Aaranya Scholarly" account works across all 7 journals — an
  author registers once and can submit to any journal from their dashboard.
- Passwords are hashed with bcrypt before storage; the raw password is never
  saved.
- Login issues a JSON Web Token (JWT), stored in the browser's `localStorage`
  and sent as `Authorization: Bearer <token>` on API calls. Tokens are valid
  for 30 days.
- There is currently no "forgot password" email flow (that needs an email-
  sending service, which wasn't set up). If an author is locked out, you'll
  need to edit their record directly in the `users` Firestore collection
  (Cloud Console → Firestore → Data).

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create an author account |
| POST | `/api/auth/login` | — | Log in, returns a token |
| GET | `/api/auth/me` | Bearer token | Current author's profile |
| GET | `/api/auth/journals` | — | List of journal codes/names |
| POST | `/api/submissions` | Bearer token | Submit a manuscript (multipart form — see fields below) |
| GET | `/api/submissions` | Bearer token | List the logged-in author's submissions |
| GET | `/api/submissions/:id` | Bearer token | Full detail for one submission |
| GET | `/api/submissions/:id/file` | Bearer token | Download the manuscript file |
| GET | `/api/submissions/:id/supplementary/:index` | Bearer token | Download a supplementary file |
| POST | `/api/submissions/:id/revision` | Bearer token | Upload a revised manuscript (only when revisions were requested) |
| GET | `/api/editorial/submissions` | Editor | Submission queue, optionally `?stage=` filtered |
| GET | `/api/editorial/submissions/:id` | Editor | Full submission + all reviews (identities visible) |
| POST | `/api/editorial/submissions/:id/reviewers` | Editor | Invite a reviewer for the current round |
| POST | `/api/editorial/submissions/:id/decision` | Editor | Record an editorial decision |
| POST | `/api/editorial/assignments/:id/cancel` | Editor | Withdraw a review invitation |
| GET | `/api/editorial/users` | Editor | All accounts and their roles |
| POST | `/api/editorial/users/:id/roles` | Editor | Grant or revoke reviewer/editor |
| GET | `/api/reviews` | Reviewer | My review assignments |
| GET | `/api/reviews/:id` | Reviewer | Anonymized submission + review form state |
| POST | `/api/reviews/:id/respond` | Reviewer | Accept or decline an invitation |
| POST | `/api/reviews/:id/submit` | Reviewer | Submit recommendation + comments |

`POST /api/submissions` expects `multipart/form-data` with: `journalCode`,
`articleType`, `subjectArea`, `title`, `abstract`, `keywords`, `coverLetter`
as plain fields; `correspondingAuthor`, `coAuthorsList`, `suggestedReviewers`,
and `declarations` as JSON-stringified fields; and `manuscript` (one file) /
`supplementary` (up to 5 files) as file fields.

## Editorial workflow (editors and reviewers)

The workflow follows [Open Journal Systems](https://docs.pkp.sfu.ca/learning-ojs/en/editorial-workflow)
(OJS 3.x), the standard open-source journal platform, so the vocabulary is
familiar to anyone who has edited or reviewed for a journal before.

### Stages

A manuscript moves through stages, and only an explicit editor decision moves
it:

| Stage | What happens |
|---|---|
| **Submission** | Editorial screening. Obvious rejections end here. |
| **Peer Review** | Reviewers are invited and report back, across one or more rounds. |
| **Copyediting** | Accepted; being prepared. |
| **Production** | Final formatting before publication. |
| **Published** / **Declined** | Terminal — no further decisions. |

### Editor decisions

Available decisions depend on the current stage — the API rejects any
transition that isn't legal from where the manuscript actually is.

| From | Decisions |
|---|---|
| Submission | Send to Review · Accept and Skip Review · Decline |
| Peer Review | Request Revisions · Resubmit for Review (opens a new round) · Accept · Decline |
| Copyediting | Send to Production · Decline |
| Production | Publish |

If reviews for the current round are still outstanding, the editor gets a
confirmation prompt before an accept/decline/revisions decision goes through
— a speed bump, not a hard block.

**Publish is different.** It is refused outright unless the article has a
galley, an issue and a page range, and there is no way to force it — see
[Copyediting, production and publication](#copyediting-production-and-publication)
below.

### Reviewer recommendations

Accept Submission · Revisions Required · Resubmit for Review · Resubmit
Elsewhere · Decline Submission · See Comments. These are advisory; the
editor's decision is what actually moves the manuscript.

### Anonymity

**Double-anonymous.** Enforced server-side, not just hidden in the UI:

- Reviewers receive a stripped view of the submission — no author names,
  affiliations, emails, cover letter, suggested reviewers, or identifying
  declaration text. Manuscript files are served under neutral names
  (`manuscript-round-2.docx`) because authors habitually name files after
  themselves.
- Authors see each review's recommendation and comments-for-author, never the
  reviewer's identity, and never the confidential comments-to-editor.
- Editors see everything — that's what makes the arrangement work.

These guarantees have tests (`npm test`); one of them caught a real filename
leak during development.

### Roles

Every account is an **author**. The rest are granted from the Editorial
Dashboard's *People & Roles* panel — there is no way to self-register into a
privileged role.

| Role | Scope |
|---|---|
| **Author** | Everyone, automatically |
| **Reviewer** | Specific journals — only offered work for those |
| **Editor** | Specific journals — sees and acts on only those |
| **Managing editor** | All seven journals |

**Journal scoping is enforced server-side, not just hidden in the UI.** A JEC
editor requesting an ALSTM submission gets a 404 — for the detail page, the
manuscript file, and any decision. It's 404 rather than 403 deliberately:
"this exists but isn't yours" leaks that a submission exists, and titles are
confidential before publication.

Consequences worth knowing:

- The reviewer picker only offers reviewers registered for that journal, and
  the API rejects an out-of-journal assignment even if you craft the request
  by hand.
- A section editor can recruit reviewers **for their own journals** but
  cannot create editors, promote anyone to managing editor, or grant a
  reviewer a journal they don't themselves edit. All three are tested.
- Editor notifications are routed by journal, so the ALSTM editor isn't
  emailed about a JEC submission they couldn't open anyway.

**Lockout safety.** Any address in `EDITOR_EMAILS` is treated as a managing
editor regardless of what's stored against it. Without that, a bad migration
or a mistaken role edit could leave the journal with nobody able to reach its
own submissions and no way to fix it through the UI. There's a test asserting
a bootstrap account survives having its roles wiped entirely.

The first editor is bootstrapped from an environment variable:

```bash
EDITOR_EMAILS="chief.editor@aaranyascholarly.com,managing@aaranyascholarly.com"
```

Listed addresses get the editor role on registration, or on their next login
if the account already exists. On Cloud Run, set it with:

```bash
gcloud run services update aaranya-website --region="$REGION" \
  --update-env-vars="EDITOR_EMAILS=chief.editor@aaranyascholarly.com"
```

### Email notifications

Every step of the workflow sends mail, so nobody has to remember to check the
site:

| Event | Who gets emailed |
|---|---|
| Account registered | The new author (welcome) |
| Manuscript submitted | Author (receipt) · editors (new submission awaiting screening) |
| Reviewer invited | Reviewer (invitation, accept/decline link) |
| Reviewer accepts or declines | Editors — a decline prompts them to find a replacement |
| Review submitted | Reviewer (thanks) · editors (recommendation + how many reviews are still outstanding) |
| Invitation withdrawn | Reviewer |
| Editorial decision recorded | Author — with the editor's note, and reviewer comments when the decision is a review outcome · **reviewers who completed a review — the decision only** |
| **Author uploads a revision** | **Author (receipt) · editors (awaiting editorial review)** |
| Major revisions open a new round | Reviewers of the previous round |
| Reviewer or editor role granted | That person |

Two deliberate omissions: the author is never told *who* was invited to
review (that would break anonymity), and the editor who records a decision
isn't emailed about their own action.

### Overdue reminders

A Cloud Scheduler job (`reminder-sweep`) calls `POST /api/cron/reminders`
daily at 08:00 India time — early enough in the working day to actually be
acted on.

| Situation | Reviewer/author chased | Editor told |
|---|---|---|
| Invitation unanswered | day 3, day 7 | day 10 |
| Review past its due date | +1 day, +7 days | +14 days |
| Revisions requested, nothing received | day 14, day 28 | day 35 |

The policy lives in `lib/reminders.js` as pure functions — no database, no
email — which is what makes the anti-spam rules testable. All thresholds are
configurable.

**The design constraint is restraint, not coverage.** Reviewers are unpaid
volunteers; over-chasing is how a journal teaches people to filter its mail,
after which no reminder works at all. So:

- a **48-hour cooldown** means nobody hears from us twice in quick succession,
  whatever the milestones say
- a **cap of 3** means chasing stops rather than continuing forever
- once the cap is reached the **editor** is told, because it has become a
  human decision — chase personally, or replace the reviewer
- anyone who completed, declined, or was withdrawn is **never** chased
- an accepted review with **no due date** is never chased; there's no basis
  to call it late

Escalation thresholds must sit strictly after the last reminder milestone,
or escalation pre-empts the later reminders and they silently never fire.
There's a test asserting exactly that — it caught the bug when the overdue
escalation was set to 7 days with a reminder at 14.

The endpoint is guarded by a shared secret (`CRON_SECRET`, from Secret
Manager) and returns 404 without it. That's necessary rather than
belt-and-braces: this service runs with Cloud Run's invoker IAM check
disabled, so Cloud Run does not reject unauthenticated callers for us.

To see what a sweep *would* do without sending anything, add `?dryRun=true`.

The revision-upload notice matters more than it looks. Without it a requested
revision arrives silently and the submission waits on an editor who has no
idea it is their turn — a stall where nothing appears broken.

**Anonymity extends into the emails.** The reviewer invitation is built from
the same stripped view the reviewer sees in the browser, so it structurally
cannot contain author names. The author's decision email carries reviewer
comments but never reviewer identities or the confidential comments-to-editor.
Both are tested (`test/email.test.js`).

**Mail failures never break the workflow.** Sends happen *after* the HTTP
response, and the mailer swallows and logs its own errors. If SendGrid is
down, an editor can still record a decision and a reviewer can still submit a
review — the email just doesn't go out, and the failure is recorded against
the record so the editor can see it in the review panel rather than mistaking
a silent send failure for an unresponsive reviewer.

**Transport.** Mail goes out through **Google Workspace SMTP relay**
(`smtp-relay.gmail.com`). Because `aaranyascholarly.com` is already a
Workspace domain, Google's SPF and DKIM are already published — so there's no
domain-authentication step and no new DNS records. The relay can send as any
address on the domain, which is what makes the per-journal from-addresses
work. A SendGrid HTTPS path is also implemented; whichever is configured
wins, SMTP first.

**Local development.** With no mail credentials set, emails are printed to
the console instead of sent. Nothing crashes, and you can read exactly what
would have gone out.

Setup is in **`docs/email-setup.md`** — Admin console relay config, App
Password, and a troubleshooting table.

### Copyediting, production and publication

Everything after acceptance: the file rounds between editor and author, the
galleys a reader opens, issue assembly, and the public archive.

Full detail is in **`docs/production-and-issues.md`**. The parts worth knowing
before you touch any of it:

- **File visibility is a property of the file kind, not a checkbox.**
  "Internal working file" is the only way to store something the author
  cannot see, so no single mis-click can show an author an internal draft.
- **An article cannot be published without a galley, an issue and a page
  range**, and that gate cannot be forced. Every blocker on the list would
  produce a public page that is broken rather than merely early.
- **Publishing an article and releasing an issue are separate acts.** An
  article stays invisible until its issue is released, which is what lets an
  issue be assembled over weeks and go live in one click.
- **Generated and uploaded galleys are treated differently on purpose.** We
  built the generated HTML from escaped plain text, so it is rendered inside
  our own article page. An uploaded `.html` is a third party's script and is
  only ever served as a sandboxed download.
- **The public view is a whitelist** (`workflow.publicArticleView`), like the
  reviewer view. A field added to a submission cannot leak publicly unless
  somebody publishes it deliberately.

### The public archive

Server-rendered, because Google Scholar does not run JavaScript and a
client-rendered article page is a blank document to it.

| URL | What it is |
|---|---|
| `/archive/:journalCode` | Every released issue of one journal |
| `/issue/:id` | An issue's table of contents |
| `/article/:id` | Abstract, metadata, citation, and the HTML full text |
| `/article/:id/galley/:galleyId` | A galley file |
| `/sitemap.xml` · `/robots.txt` | Crawler plumbing |

An article is public when — and only when — the editor has published it *and*
its issue has been released. One rule, one function, in `routes/public.js`.

### Pages

| Page | Who |
|---|---|
| `editor.html` | Editors — submission queue by stage, plus role management |
| `editor-submission.html` | Editors — reviewers, decisions, copyediting files, galleys, publication details |
| `editor-issues.html` | Editors — create, fill and release issues |
| `reviewer.html` | Reviewers — assigned reviews and due dates |
| `review.html` | Reviewers — accept/decline an invitation, submit a review |
| `submission.html` | Authors — status, reviews, revisions, and copyediting files |
| `dashboard.html` | Everyone — links to the above appear only if you hold the role |

## Tests

```bash
npm test
```

Seven suites, 214 assertions:

- `test/workflow.test.js` (29) — stage-transition rules and the anonymity
  guarantees in the API.
- `test/email.test.js` (52) — that no reviewer-facing email carries author
  identity, no author-facing email carries reviewer identity or the
  confidential comments-to-editor, and every template renders with escaped
  output.
- `test/gmail.test.js` (14) — MIME construction, header-injection defence,
  and that a send failure never propagates into the workflow.
- `test/reminders.test.js` (30) — mostly assertions that we stay *quiet*.
  The failure that matters is chasing an unpaid volunteer six times.
- `test/scoping.test.js` (22) — journal-scoped roles, and the lockout safety
  that keeps a bootstrap editor from being locked out of their own journal.
- `test/docx-text.test.js` (13) — the dependency-free Word reader: real
  deflated `.docx` round-trips, entity decoding, and that text the author
  deleted under tracked changes never comes out. `lib/galley.js` builds the
  published HTML full text from this, so a silent failure here reaches the
  version of record.
- `test/production.test.js` (54) — copyediting file visibility, the publish
  gate, issue validation and collision, and that a manuscript containing
  `<script>` comes out of the galley generator escaped. That last one is
  load-bearing: if it fails, a submitted Word file has become stored XSS on
  the journal's own domain.

None need GCP credentials or network — they exercise the library modules as
pure functions. The deploy scripts run them before building the image, and
will not deploy on a failure.

### End-to-end

```bash
npm run test:e2e
```

Boots the app on a spare port with a **throwaway data directory**, then walks
a manuscript from submission all the way to a live public article page: 68
assertions across multipart uploads, file storage, route wiring and the
served HTML.

It asserts both directions — that the article renders with its full text and
Scholar meta tags, *and* that the cover letter, suggested reviewers, internal
copyediting notes, original filename and a hostile `<script>` tag do not
appear on the public page.

Not part of `npm test`, because it needs a running server. It never touches
your own `data/`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | production | Session signing key; bind from Secret Manager |
| `GCS_BUCKET` | production | Bucket holding uploaded manuscripts |
| `SITE_URL` | for email | Absolute base URL used in emails, canonical links, Scholar meta tags and the sitemap |
| `DATA_DIR` | no | Local-dev storage root (default `./data`). Used by `npm run test:e2e` to avoid touching your own data. Ignored in production |
| `SMTP_USER` | for email | Workspace account the relay authenticates as |
| `SMTP_PASSWORD` | for email | App Password; bind from Secret Manager |
| `SMTP_HOST` / `SMTP_PORT` | no | Default `smtp-relay.gmail.com` / `587` |
| `SENDGRID_API_KEY` | no | Alternative transport; used only if SMTP is unset |
| `MAIL_DOMAIN` | no | Defaults to `aaranyascholarly.com` |
| `EDITOR_EMAILS` | first run | Bootstrap editors, comma-separated |
| `EDITORIAL_NOTIFY_EMAILS` | no | Where editorial notices go; falls back to `EDITOR_EMAILS` |
| `PORT` | no | Defaults to 4000 locally; Cloud Run sets this itself |

## What's outstanding

The standing list of pending work lives in **`TODO.md`** — ISSNs, the licence
decision, the first real publication, and the known defects. It is kept in
the repo deliberately, so "what is still pending" has an answer that does not
depend on anyone remembering.

## Extending this later

Still missing, in rough priority order:

- **DOI registration.** A DOI can be recorded against an article, but nothing
  registers it with Crossref. Today that means someone mints the DOI
  elsewhere and pastes it in. Real support means a Crossref member account
  and depositing the metadata XML on publication.
- **Figures, tables and equations in the HTML full text.** The generator
  works from plain text, so a generated galley is prose and references only.
  The PDF carries everything else, and the article page says so. Fixing it
  properly means a real `.docx` → HTML converter (Pandoc, or the OJS/JATS
  route), which is a much larger dependency than the rest of this system
  has.
- **Online-first publication.** An article cannot appear ahead of its issue.
  The honest fix is a standing "Articles in Press" issue per journal rather
  than a second visibility rule — see `docs/production-and-issues.md`.
- **Full-text search across the archive.** Readers can browse issues and
  follow links, but there is no search box over published articles.
- **Usage statistics** — downloads and views per article, which authors ask
  for and which nothing currently counts.

Done since this list was first written, and documented above: reviewer
reminders (Cloud Scheduler + `lib/reminders.js`), section editors
(journal-scoped roles in `lib/workflow.js`), and the copyediting, production,
galley, issue-assembly and public-archive work in
`docs/production-and-issues.md`.
