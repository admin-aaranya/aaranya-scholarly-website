# One-time GCP setup for CI/CD deploys

## Prerequisite: get this code onto GitHub

This folder isn't a git repo yet, and it can't be turned into one from this
session — the mounted project folder blocks the file delete/rename
operations git needs internally (you'll see a stray, non-functional `.git/`
folder here as a result; ignore or reuse it, it's harmless). Do this step on
your own machine instead:

```bash
cd path/to/website        # this folder, opened from your own computer
git init
git add -A
git commit -m "Initial commit"
```

Then create an empty repo on GitHub (no README/license — you already have
one) and push:

```bash
git remote add origin https://github.com/<your-org>/<your-repo>.git
git branch -M main
git push -u origin main
```

Once the code is on GitHub, come back here for the GCP side.


Run this once (or after these values change) to wire up Cloud Run + Firestore +
Cloud Storage + a CI/CD pipeline that deploys on every push to `main`. After
this is done, the GitHub Actions workflow (`.github/workflows/deploy.yml`)
handles every deploy going forward — nobody needs to touch `gcloud` by hand
again, and the project's root/admin login is never used by automation.

Run these from a machine with the [gcloud CLI](https://cloud.google.com/sdk/docs/install)
installed, signed in as a human with Owner or Editor on the project
(`gcloud auth login`). Replace the placeholder values in step 0 first.

## 0. Set variables

```bash
export PROJECT_ID="aaranya-scholarly"        # your real GCP project ID
export REGION="asia-south1"                  # pick the region closest to your readers
export AR_REPO="aaranya-website"
export SERVICE="aaranya-website"
export RUNTIME_SA="aaranya-website-runtime"
export DEPLOY_SA="aaranya-website-deployer"
export BUCKET="${PROJECT_ID}-manuscripts"    # bucket names are globally unique
export GITHUB_REPO="your-org/your-repo"      # e.g. aaranya-scholarly/website

gcloud config set project "$PROJECT_ID"
```

## 1. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  cloudbuild.googleapis.com \
  firebase.googleapis.com \
  firebasehosting.googleapis.com \
  cloudresourcemanager.googleapis.com
```

> **Don't trim this list.** The last four were learned the hard way during the
> real deployment. Without `cloudresourcemanager`, the Firebase CLI gets a 403
> merely checking its own permissions and then reports a misleading
> "caller does not have permission" from `projects:addfirebase`.
>
> **Then wait a minute or two before continuing.** API enablement is not
> instant. `addfirebase` failed three times in a row and then succeeded on a
> later retry with no other change — the only difference was elapsed time.
> If a Firebase command fails with 403 or 404 right after enabling APIs,
> retry before you start debugging permissions.

## 2. Artifact Registry (holds built container images)

```bash
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Aaranya Scholarly website images"
```

## 3. Firestore (Native mode)

```bash
gcloud firestore databases create --location="$REGION"
```

If a Firestore database already exists in this project, skip this step —
a project can only have one.

## 4. Cloud Storage bucket for uploaded manuscripts

```bash
gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
```

This bucket should stay **private** (no public access) — files are served
through the app's authenticated download routes, not directly from GCS.

## 5. JWT signing secret in Secret Manager

```bash
openssl rand -hex 48 | gcloud secrets create jwt-secret --data-file=-
```

This generates the secret and stores it in Secret Manager in one step — the
raw value never touches your shell history or a file on disk.

## 5b. SendGrid (transactional email)

The journal emails authors and reviewers at each step of the editorial
workflow. This goes through SendGrid's **HTTPS API**, not SMTP — Google Cloud
blocks outbound port 25 on every VM and Cloud Run instance with no exception,
so an SMTP mailer would simply hang in production. HTTPS is unaffected.

**a. Create the account and API key.** Sign up at sendgrid.com, then create an
API key under Settings → API Keys. Use **Restricted Access** with only the
*Mail Send* scope — a key that can only send mail is far less dangerous if it
leaks than one with full account access. Enable 2FA on the account while
you're there.

**b. Authenticate the domain.** Settings → Sender Authentication → Authenticate
Your Domain, for `aaranyascholarly.com`. SendGrid gives you CNAME records to
add at your DNS provider; they set up SPF and DKIM. This is not optional —
without it, mail lands in spam or is rejected outright with a 403, and
per-journal addresses won't work at all.

Domain authentication covers **every** address at that domain at once. You do
not need to verify `alstm@`, `jec@`, etc. individually.

**c. Store the key in Secret Manager** (never in git, never in the image):

```bash
gcloud secrets create sendgrid-api-key --data-file=-
# paste the key, then press Ctrl-D

gcloud secrets add-iam-policy-binding sendgrid-api-key \
  --member="serviceAccount:${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

**d. Sender addresses.** Each journal sends from its own address
(`alstm@aaranyascholarly.com` and so on) so replies reach the right editorial
team. These are defined in `config.js` and derived from `MAIL_DOMAIN`. Make
sure those mailboxes actually **receive** mail — a reviewer replying to an
invitation with a question should reach a human, not a black hole.

## 6. Runtime service account (what Cloud Run runs as)

This is the identity the *app itself* uses at runtime — separate from the
identity CI/CD uses to deploy. Least privilege: it can read/write Firestore
and the manuscripts bucket, and read the JWT secret. Nothing else.

```bash
gcloud iam service-accounts create "$RUNTIME_SA" \
  --display-name="Aaranya website runtime"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

gcloud secrets add-iam-policy-binding jwt-secret \
  --member="serviceAccount:${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 7. Deploy service account (what GitHub Actions uses)

This identity can push images and deploy new Cloud Run revisions. It does
**not** have Firestore/Storage/Secret access itself — it just needs to be
allowed to *set* the runtime service account on the Cloud Run service.

```bash
gcloud iam service-accounts create "$DEPLOY_SA" \
  --display-name="Aaranya website CI/CD deployer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
  --location="$REGION" \
  --member="serviceAccount:${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Lets the deployer attach the runtime SA to the Cloud Run service.
gcloud iam service-accounts add-iam-policy-binding \
  "${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --member="serviceAccount:${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

## 8. Workload Identity Federation (GitHub Actions auth, no JSON key)

This lets the specific GitHub repo's Actions workflow impersonate the
deploy service account — no long-lived key file to leak or rotate.

```bash
gcloud iam workload-identity-pools create "github-pool" \
  --location="global" \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="attribute.repository=='${GITHUB_REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

gcloud iam service-accounts add-iam-policy-binding \
  "${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_REPO}"
```

Get the provider resource name for the GitHub secret in the next step:

```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
  --location=global --workload-identity-pool="github-pool" \
  --format="value(name)"
```

## 9. First manual deploy (sets env vars + secret binding)

After this first deploy, later deploys from CI/CD only need to change the
image — Cloud Run carries forward env vars and secret bindings automatically.

First give the **deploy** service account permission to run builds. New GCP
projects no longer grant the default Compute Engine service account access to
Cloud Build's own source bucket, so `--source` deploys fail with a confusing
403 about `storage.objects.get` on a `run-sources-*` bucket. Google's
suggested remedy is to grant that shared default account a broad builder
role; granting it to our own deploy account instead keeps the blast radius
small:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder" --condition=None

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/logging.logWriter" --condition=None
```

Then deploy, telling Cloud Build to use that account:

```bash
gcloud run deploy "$SERVICE" \
  --region="$REGION" \
  --service-account="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --build-service-account="projects/${PROJECT_ID}/serviceAccounts/${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --source=. \
  --allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --set-env-vars="GCS_BUCKET=${BUCKET},SITE_URL=https://${PROJECT_ID}.web.app,MAIL_DOMAIN=aaranyascholarly.com,EDITOR_EMAILS=chief.editor@aaranyascholarly.com,EDITORIAL_NOTIFY_EMAILS=editorial@aaranyascholarly.com" \
  --set-secrets="JWT_SECRET=jwt-secret:latest"
```

Add `--set-secrets="SENDGRID_API_KEY=sendgrid-api-key:latest"` once that
secret exists (step 5b). Without it the app runs fine and logs emails instead
of sending them.

### If the deploy warns "Setting IAM policy failed"

`--allow-unauthenticated` needs to grant the `allUsers` principal. If your
Google Workspace organization enforces **Domain Restricted Sharing**
(`constraints/iam.allowedPolicyMemberDomains`, on by default for Workspace
orgs), that grant is refused and the service returns 403 to every visitor
even though it deployed successfully.

Check whether the policy is in force:

```bash
gcloud resource-manager org-policies describe \
  iam.allowedPolicyMemberDomains --project="$PROJECT_ID" --effective
```

The wrong fix is to relax that org-wide policy. The right one is to disable
the invoker IAM check on this single service — public in effect, but scoped
to one service, with the organization's policy untouched:

```bash
gcloud run services update "$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" --no-invoker-iam-check
```

`SITE_URL` matters more than it looks: emails are read outside the browser
session, so every link in them is built from this value. Get it wrong and
reviewers receive invitations pointing at `localhost`. Set it to your custom
domain if you have one, otherwise the Cloud Run service URL (visible in the
deploy output).

(`--source=.` builds via Cloud Build for this one-off deploy so you don't
need Docker installed locally; CI/CD builds with the repo's Dockerfile.)

## 10. GitHub repo configuration

In the repo's **Settings → Secrets and variables → Actions**:

**Variables** (`Variables` tab):
| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | `$PROJECT_ID` |
| `GCP_REGION` | `$REGION` |
| `AR_REPO` | `$AR_REPO` |
| `CLOUD_RUN_SERVICE` | `$SERVICE` |

**Secrets** (`Secrets` tab):
| Name | Value |
|---|---|
| `WIF_PROVIDER` | output of the `providers describe` command in step 8 |
| `WIF_SERVICE_ACCOUNT` | `${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com` |

Push to `main` and check the **Actions** tab — that's the whole pipeline
from here on.

## What this deliberately does NOT do

- It never uses the `Admin@aaranyascholarly.com` account credentials for
  anything automated. That login is for the human doing this one-time setup
  in the Cloud Console/gcloud, not for CI/CD.
- It never stores a service-account JSON key in GitHub. Workload Identity
  Federation issues short-lived tokens per workflow run instead.
- The deploy identity and the runtime identity are different service
  accounts with different, narrow permissions — a compromised GitHub Actions
  run can redeploy the service, but can't directly read Firestore data or
  the manuscripts bucket.
