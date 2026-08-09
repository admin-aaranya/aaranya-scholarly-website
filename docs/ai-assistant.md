# The manuscript assistant

An optional, author-facing check that runs on a manuscript before it is
submitted. It reports on presentation and on completeness of reporting:
structure, spelling and grammar, formatting consistency, and gaps in the
methods and results — a missing sample size, an unnamed statistical test, an
aim in the introduction with no matching result.

Setup is one button: **`0-RUN-SETUP-AI.bat`**. Everything below explains why it
is built the way it is, and what to check if it stops working.

---

## The decisions that matter

### 1. Vertex AI, never the free Gemini API

There are two ways to reach Gemini and their terms are not the same:

| | Vertex AI (used here) | AI Studio free tier |
|---|---|---|
| Trains on your content | **No** — contractual commitment | **Yes**, including model training |
| Human review of content | No | Yes, reviewers may annotate |
| Confidential data | Permitted | Terms explicitly warn against it |
| Auth | Service account, keyless | API key |

Manuscripts here are unpublished, confidential, third-party research. That is
exactly the data AI Studio's terms tell you not to submit. So this integration
uses Vertex AI and a service account, with no API key anywhere in the codebase.

If a future change "simplifies" this by dropping in a
`generativelanguage.googleapis.com` key, that is a confidentiality regression,
not a refactor. The comment at the top of `lib/gemini.js` says so, in case the
person making that change is not the person reading this.

### 2. Authors only

There is no editor route and no reviewer route into `routes/assistant.js`, and
that is deliberate.

Peer review at this publisher is a human judgement. If an editor could run a
manuscript through a model and read the output, that output would start
shaping decisions regardless of how carefully it was labelled advisory. COPE
and most major publishers take the same line, and several go further and
forbid reviewers uploading manuscripts to AI tools at all — because doing so
is a confidentiality breach against the author.

Keeping the feature on the author's side of the wall is the only version of it
that is safe to ship. If this is ever revisited, it needs a published AI
policy on the journal pages first, not a code change first.

### 3. It cannot block a submission

The check is optional, its output is never stored against the submission, and
every failure path — model down, file unreadable, quota exhausted, Vertex
returning nonsense — ends in a message and nothing else. It disables no form
control and touches no submission state.

The test suite asserts this rather than trusting it.

### 4. Consent is asked every time

The consent box is not remembered between checks. An author is sending
unpublished work to a third party, sometimes work with co-authors, funders or
an institution who have views about that. Every run should be a deliberate
choice, not a preference set once at registration.

---

## What it will and will not say

Bounded in two places, because a prompt alone is not a control.

**In the prompt** (`lib/manuscript-check.js`) the model is told it may comment
on structure, language, formatting, methods completeness and results
completeness — and explicitly forbidden from judging novelty or significance,
recommending acceptance or rejection, assessing whether the conclusions are
correct, rewriting the manuscript, or asserting something is absent when it may
just be unreadable in the converted file.

**In the response schema** there is nowhere for a verdict to go. No score, no
rating, no recommendation field. A test asserts none of those words appear in
the schema, so a future edit that adds one fails the build.

Findings come back in three bands, worded as journal expectations rather than
manuscript quality:

- `likely_required` — most journals would ask for this before review
- `worth_addressing` — would strengthen the manuscript
- `suggestion` — optional polish

### Reporting guidelines

The right checklist is selected from the article type the author picked, so a
case report author is not told about CONSORT randomisation items:

| Article type | Guideline |
|---|---|
| Original Research | CONSORT / STROBE / ARRIVE, chosen by study design |
| Systematic Review / Meta-Analysis | PRISMA 2020 |
| Case Report | CARE |
| Technical Note / Protocol | SPIRIT |
| Review, Data Paper, Short Communication | General structural completeness |

---

## How it reads the file

**PDF** goes to Gemini as bytes. Vertex accepts `application/pdf` natively and
the model reads the document itself — tables, figure captions, layout. Better
than any text extraction we could do, and it is why there is no PDF dependency
in this project.

**Word** has no native input type, so `lib/docx-text.js` extracts the text. It
is a small dependency-free zip reader plus a WordprocessingML text walker, and
it deliberately excludes `<w:delText>` — text the author has already deleted
under tracked changes, which it would be absurd to critique.

**Old `.doc`** cannot be read. The author gets "save it as .docx or PDF" rather
than a stack trace.

---

## Cost control

| Guard | Value | Set by |
|---|---|---|
| Checks per author per rolling 24h | 5 | `AI_CHECKS_PER_DAY` |
| Max file the assistant will read | 8 MB | `MAX_CHECK_BYTES` in the route |
| Max extracted text sent | 250,000 chars | `MAX_TEXT_CHARS` in `lib/gemini.js` |
| Request timeout | 90s | `REQUEST_TIMEOUT_MS` |

The quota lives on the user record in Firestore, not in memory — Cloud Run
runs several instances, and an in-memory counter would hand each author the
full quota *per instance*.

The attempt is counted before the call is made. Slightly unfair to an author
whose check fails, but the alternative lets a client trigger unlimited billed
calls by aborting each one.

The 8 MB assistant cap is deliberately below the 25 MB submission cap. A file
between the two can still be submitted; it just cannot be checked, and the
error says so.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_ENABLED` | `false` | Off means the panel never renders |
| `VERTEX_LOCATION` | `asia-south1` | Keeps manuscripts in Mumbai, as the consent notice promises |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Confirm with the probe; Google retires IDs |
| `AI_CHECKS_PER_DAY` | `5` | Per author, rolling 24h |
| `GCP_PROJECT_ID` | from metadata | Only needed off Cloud Run |

The runtime service account needs `roles/aiplatform.user` and nothing more.
No key file, no secret to rotate — the token comes from the metadata server.

---

## When Google retires a model

They will. Symptom: every check fails and the logs show
`Model "..." not found in asia-south1`.

Re-run **`0-RUN-SETUP-AI.bat`**. It re-probes and redeploys with whatever
currently answers.

Note what the probe does: it authenticates **as the runtime service account**,
not as you. An owner account can call Vertex successfully while the service
account gets 403, and testing as yourself would hide that — a mistake this
project has already made once, with Cloud Build. If impersonation fails the
script falls back to your login and warns you in `_ai-setup.txt` that the
result proves less.

To probe by hand:

```bash
gcloud auth print-access-token --impersonate-service-account=aaranya-website-runtime@aaranya-scholarly.iam.gserviceaccount.com
# then, with that in GOOGLE_ACCESS_TOKEN:
npm run probe-gemini
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Panel never appears | `GEMINI_ENABLED` is not `true`, or `/api/assistant/status` returned an error — check the browser console |
| `403` in logs | `roles/aiplatform.user` missing, or the Vertex AI API not enabled |
| `404 Model not found` | Model ID retired — re-run the setup script |
| "took too long to respond" | Manuscript near the size cap; the 90s timeout was hit |
| Every author sees the panel but checks 429 immediately | `AI_CHECKS_PER_DAY` set to 0 or a non-number |

`/api/assistant/status` is the quickest diagnostic — it reports availability
and remaining quota for the signed-in user.

---

## What is deliberately not built

- **No editor or reviewer access.** See above. This is a policy position, not
  a backlog item.
- **No storage of findings on the submission.** Nothing an editor later reads
  should be coloured by what a model guessed about the paper.
- **No automatic rejection or auto-screening.** A desk-reject triggered by a
  model would be indefensible, and authors would be right to appeal it.
- **No plagiarism or AI-detection check.** Both are different problems with
  different tools and much worse false-positive costs. Do not bolt them onto
  this.
