# Deploying the archive release

Four steps, about 10 minutes, most of it waiting on the container build.

This is a **two-part deploy**, which is worth understanding before you start:

| What changed | Where it lives | Which script ships it |
|---|---|---|
| All the new code — copyediting, galleys, issues, the public archive | Cloud Run | `0-RUN-DEPLOY.bat` |
| `public/robots.txt` | Firebase Hosting (CDN edge) | `deploy-hosting.bat` |

Firebase Hosting serves matching static files *before* it applies the rewrite
to Cloud Run, which is why `robots.txt` is the one file that needs the second
script. Everything else on the site comes from Cloud Run.

---

## 0. Unstick git first

Git in this folder is currently jammed. Three lock files were left behind and
could not be deleted from the sandbox — until they're gone, every `git`
command in this folder will fail with *"Another git process seems to be
running"*.

In File Explorer, turn on **View → Show → Hidden items**, go to
`D:\Aaranya Scholarly\website\.git\` and delete:

```
.git\HEAD.lock
.git\index.lock
.git\objects\maintenance.lock
```

Then, in a terminal in `D:\Aaranya Scholarly\website`:

```powershell
git status          # should show only public/robots.txt and routes/public.js
git add -A
git commit -m "robots.txt: keep the served static copy in step with the app route"
git gc              # clears ~138 stray tmp_obj_* files, same cause
```

Commit `fd01154` (everything else) is already in. Nothing is lost either way
— this is housekeeping, not a blocker for the deploy. But do it before you
make any further changes, or the next thing you write has no rollback point.

---

## 1. Refresh your Google credentials

This is the step that stopped the last attempted deploy
(`Reauthentication failed`). It will stop this one too.

```powershell
gcloud auth login
```

A browser opens; sign in as the account that owns the `aaranya-scholarly`
project. Then confirm it took:

```powershell
gcloud auth list
gcloud config set project aaranya-scholarly
```

---

## 2. Deploy the code to Cloud Run

Double-click **`0-RUN-DEPLOY.bat`**, or run it from a terminal.

It does four things in order, and stops at the first failure:

1. `npm install` — keeps `package-lock.json` in step with `package.json`
2. `npm test` — **253 assertions; it will not deploy if any fail**
3. `gcloud run deploy` from source (4–8 minutes)
4. Curls the live site and records the HTTP status

Everything it does is logged to `_deploy.txt` in this folder. If it fails,
that file has the reason — send it to me rather than the console output,
which the window closes over.

Expected ending:

```
 ============================================
  Deployed. https://aaranya-scholarly.web.app
 ============================================
```

---

## 3. Deploy the hosting config

Only needed because `public/robots.txt` changed.

```powershell
firebase login      # if you haven't recently
```

Then double-click **`deploy-hosting.bat`**.

If you skip this step, everything still works — search engines just won't be
told where the sitemap is.

---

## 4. Check SITE_URL — this one matters more than it looks

Every canonical link, every Google Scholar `citation_*` URL, every entry in
`/sitemap.xml` and every link in a publication email is built from the
`SITE_URL` environment variable on the Cloud Run service.

If it is unset or stale, the archive ships with canonical URLs pointing at
the wrong host — and Google will index *that*. Wrong canonical URLs are worse
than no archive at all, because they are slow and awkward to undo once
crawled.

Run **`0-RUN-SET-DOMAIN.bat`** and give it the public domain, or set it
directly:

```powershell
gcloud run services update aaranya-website ^
  --region=asia-south1 ^
  --project=aaranya-scholarly ^
  --update-env-vars="SITE_URL=https://aaranyascholarly.com"
```

Use whichever domain readers actually visit — `https://aaranyascholarly.com`
if the custom domain is live, otherwise `https://aaranya-scholarly.web.app`.

---

## 4b. Clear the leftover AI settings (housekeeping)

The manuscript assistant has been removed from the code. Any Vertex settings
still attached to the Cloud Run service are now inert, but leaving them there
means the next person reads them as evidence the feature exists.

```powershell
gcloud run services update aaranya-website ^
  --region=asia-south1 ^
  --project=aaranya-scholarly ^
  --remove-env-vars="GEMINI_ENABLED,VERTEX_LOCATION,GEMINI_MODEL,AI_CHECKS_PER_DAY"
```

Two things this does *not* undo, both of which cost nothing to leave and are
yours to decide on:

- The **Vertex AI API** is still enabled on the project. Harmless while
  nothing calls it — no requests, no charges.
- The runtime service account may still hold **`roles/aiplatform.user`**. If
  you want it gone, remove that binding in IAM. Worth doing on the general
  principle that an account shouldn't carry a permission nothing uses.

## 5. Tell me it's done

I'll then fetch the live site and check:

- the app is serving the new build at all
- `/archive/alstm`, `/issue/…` and `/article/…` respond (rather than 404ing
  through to the static site)
- `/sitemap.xml` is served **and emits the right hostname** — this is the
  fastest way to prove `SITE_URL` is correct
- `/robots.txt` carries the `Sitemap:` line
- an unpublished submission is still invisible to an anonymous request
- nothing in the editorial workflow regressed

---

## If it goes wrong

| Symptom | Cause |
|---|---|
| `Reauthentication failed` | Step 1 not done, or done as the wrong account |
| Tests fail, no deploy | Read `_deploy.txt`; the deploy correctly refused to ship |
| 404 on every page | `serviceId`/`region` in `firebase.json` no longer match the service |
| Archive pages 404, rest of site fine | The new build didn't actually go out — check the revision name in `_deploy.txt` |
| Sitemap says `localhost` | Step 4 |
| Login hangs after deploy | Firestore permissions on the runtime service account |

Rolling back is a Cloud Run traffic switch, not a rebuild:

```powershell
gcloud run revisions list --service=aaranya-website --region=asia-south1
gcloud run services update-traffic aaranya-website ^
  --region=asia-south1 --to-revisions=PREVIOUS_REVISION_NAME=100
```

The new code only *adds* Firestore fields and one new `issues` collection, so
a rollback is safe — nothing already in the database is rewritten or removed.
