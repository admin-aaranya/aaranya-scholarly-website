# Deploying to Firebase Hosting + Cloud Run

## What this actually is

Firebase Hosting **cannot run this site on its own.** It serves static files
only, and this app is an Express server with accounts, an editorial workflow,
and file uploads. Deploying to Hosting alone would give you seven journal
pages with dead login and submission forms.

What works is Firebase Hosting **in front of** Cloud Run:

```
   author's browser
          |
          v
   Firebase Hosting          <- CDN, free SSL, custom domain
          |  (rewrite: ** -> run)
          v
   Cloud Run service         <- the Express app in a container
          |
          +-- Firestore      <- accounts, submissions, reviews
          +-- Cloud Storage   <- uploaded manuscripts
          +-- SendGrid        <- editorial email
```

Firebase App Hosting (the newer product) is the same machinery underneath —
it builds with Cloud Build and runs on Cloud Run. The setup below keeps the
least-privilege service accounts and keyless CI/CD from
`gcp-deploy-setup.md`, which App Hosting would replace with its own defaults.

## Before you start — what only you can do

Three steps need **you**, not an assistant, and nothing can proceed without
them:

1. **Create the Google Cloud / Firebase project** and **enable billing.**
   Billing needs your payment method. Cloud Run, Firestore, and Storage all
   have free tiers a launching journal will sit inside comfortably, but the
   account still has to have billing attached.
2. **Sign in:** `gcloud auth login` and `firebase login` both open a browser
   for Google sign-in and consent. Use `Admin@aaranyascholarly.com`.
3. **DNS records** for the custom domain and for SendGrid's domain
   authentication, at whoever hosts `aaranyascholarly.com`.

## 0. Install the tooling

```bash
# Google Cloud CLI: https://cloud.google.com/sdk/docs/install
# Then the Firebase CLI:
npm install -g firebase-tools
```

## 1. Create the project and enable billing

Do this in the console rather than the CLI — billing can't be attached from
the command line.

1. Go to <https://console.firebase.google.com> and **Add project**.
2. Name it (e.g. `aaranya-scholarly`). Note the **project ID** it generates —
   that's what every command below wants, and it is not always the same as
   the display name.
3. On the **Blaze (pay-as-you-go)** plan prompt, upgrade. Cloud Run and
   outbound network calls require Blaze; the Spark free plan cannot run
   containers. Set a **budget alert** while you're there — Billing → Budgets
   & alerts → create one at, say, ₹2,000/month so nothing surprises you.

```bash
gcloud auth login          # opens a browser — sign in as Admin@aaranyascholarly.com
firebase login             # same, for the Firebase CLI

export PROJECT_ID="your-actual-project-id"
gcloud config set project "$PROJECT_ID"
```

## 2. Run the Cloud Run setup

Everything in **`docs/gcp-deploy-setup.md`** — APIs, Artifact Registry,
Firestore, the manuscripts bucket, both service accounts, Secret Manager, and
the first deploy. Work through it start to finish, then come back here.

That runbook is the substantial part of this. Firebase Hosting is a thin,
fast layer on top of it.

At the end you'll have a Cloud Run service URL like
`https://aaranya-website-xxxxx-el.a.run.app`. Check it loads before going on
— if the site is broken there, Firebase Hosting will faithfully serve you the
same broken site.

## 3. Point Firebase Hosting at the Cloud Run service

`firebase.json` is already written and committed. Confirm the two values in
it match what you actually deployed:

```json
"run": { "serviceId": "aaranya-website", "region": "asia-south1" }
```

If you used a different service name or region in step 2, edit them here —
a mismatch produces a 404 on every page, with nothing in the Cloud Run logs
to explain it, because the request never reaches Cloud Run.

Then link the local folder to your project and deploy:

```bash
cd website
firebase login              # opens a browser
firebase projects:addfirebase aaranya-scholarly
firebase deploy --only hosting --project aaranya-scholarly
```

The site is now live at `https://PROJECT_ID.web.app`.

### Things that went wrong doing this for real

**`addfirebase` fails with 403 or 404.** Almost always API propagation, not
permissions. Confirm `cloudresourcemanager.googleapis.com` and
`firebasehosting.googleapis.com` are enabled, wait a couple of minutes, and
**retry**. It failed three times and then worked unchanged.

**Don't "Add project" in the Firebase console to fix it.** Typing your
project's name there creates a *brand-new empty project* with a random suffix
(e.g. `aaranya-scholarly-d9e57`) on the free Spark plan — no Cloud Run
service, no Firestore, no billing. Both then show the same display name in
the console, which is a genuinely confusing thing to live with. If you do use
the console, you must pick the existing project from the **dropdown** that
appears when you click the name field, not type a new name.

**`hosting:sites:create` hangs asking for a different site ID.** That means
the site already exists — `addfirebase` creates a default site named after
the project automatically. Skip straight to `firebase deploy`.

**`firebase projects:list` may still show nothing** right after
`addfirebase` succeeds. The listing is eventually consistent; deploying with
an explicit `--project` works regardless.

## 4. Point SITE_URL at the real domain

Emails build every link from `SITE_URL`. Until this is set, reviewers get
invitations pointing at `localhost`.

```bash
gcloud run services update aaranya-website \
  --region="$REGION" \
  --update-env-vars="SITE_URL=https://PROJECT_ID.web.app"
```

Change it again later if you connect a custom domain.

## 5. Custom domain (optional)

Firebase Console → Hosting → **Add custom domain** →
`journals.aaranyascholarly.com`. Firebase gives you A/TXT records to add at
your DNS provider and provisions an SSL certificate automatically — usually
within an hour, occasionally up to 24. Then update `SITE_URL` again.

## Known constraint: the 60-second timeout

**Firebase Hosting terminates any request that takes longer than 60 seconds
with a 504.** Cloud Run itself allows up to 60 minutes, but requests arriving
via Hosting are capped.

For this site, that only affects manuscript uploads. Concretely, at a typical
Indian broadband upload speed of ~5 Mbps:

| Upload | Approx. time | Through Hosting |
|---|---|---|
| 5 MB manuscript | ~8 s | fine |
| 25 MB manuscript (our per-file cap) | ~40 s | fine, but close |
| 25 MB + several supplementary files | 2–4 min | **fails with 504** |

So a normal submission is fine and a heavy one with large supplementary
files is not. Nothing is silently corrupted — the author sees an error and
the submission simply isn't created.

**I have deliberately not pre-built a fix for this**, because the correct fix
depends on whether it actually bites you. The options, in ascending order of
effort:

1. **Lower the limits.** Reduce `MAX_SUPPLEMENTARY` or the per-file cap in
   `lib/files.js` so a submission can't exceed what fits in 60 seconds. Ten
   minutes of work.
2. **Send uploads straight to Cloud Run**, bypassing Hosting for that one
   route. Needs CORS configuration and a configurable API origin in
   `assets/auth.js` (which is the single chokepoint all API calls pass
   through, so this is contained).
3. **Upload directly to Cloud Storage using signed URLs.** The browser sends
   the file to GCS without it ever passing through our server. This is the
   architecturally correct answer — it also removes the memory cost of
   buffering 25 MB per request in the container — but it's a real change to
   both the upload route and the submission form.

If you start taking submissions and authors report failures on large files,
option 3 is the one to do properly.

## Deploying changes later

Two independent things now:

- **App code** (routes, workflow, templates) → lives in Cloud Run. Push to
  `main` and the GitHub Actions pipeline builds and deploys it.
- **Hosting config** (`firebase.json`, `public/`) → `firebase deploy --only
  hosting`. Only needed when you change the rewrite rules, headers, or
  `robots.txt`.

You do **not** need to run `firebase deploy` after an ordinary code change.

## If something breaks

| Symptom | Likely cause |
|---|---|
| 404 on every page | `serviceId`/`region` in `firebase.json` don't match the deployed service |
| Homepage works, login hangs | Firestore not created, or the runtime service account lacks `roles/datastore.user` |
| 504 on submission | The 60-second timeout above |
| Emails link to `localhost` | `SITE_URL` not set on the Cloud Run service |
| Emails not arriving at all | SendGrid domain authentication incomplete — see `gcp-deploy-setup.md` step 5b |
| Placeholder page instead of the site | Something got added to `public/` that shadows a real route |

Cloud Run logs are the place to look:

```bash
gcloud run services logs read aaranya-website --region="$REGION" --limit=50
```
