// Datastore facade.
//
// Two interchangeable backends behind one API:
//
//   Firestore     -- used in production (and locally if you've authenticated
//                    with gcloud). Managed, survives Cloud Run redeploys.
//   Local JSON    -- used when no GCP credentials are present, so the app is
//                    runnable on a laptop with nothing but Node installed.
//
// Selection happens once at boot and is logged, because "which database am I
// actually talking to" is the first question worth answering when something
// looks wrong.
//
// The local backend is a development convenience only -- see the warning in
// lib/local-store.js.

const { IS_CLOUD_RUN } = require('./config');

// Firestore's client library resolves credentials from, in order: an explicit
// key file, gcloud application-default credentials, or the metadata server
// (which exists on Cloud Run). If none of those can possibly be present,
// calls don't fail fast -- they hang retrying the metadata server, which is a
// miserable way to discover your local setup is incomplete. So we check up
// front instead.
function firestoreIsAvailable() {
  if (IS_CLOUD_RUN) return true; // metadata server is always there
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  if (process.env.FIRESTORE_EMULATOR_HOST) return true;
  if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT) return true;
  return false;
}

const USE_FIRESTORE = firestoreIsAvailable();

let backend;

if (USE_FIRESTORE) {
  backend = require('./lib/firestore-store');
  console.log('[db] using Firestore');
} else {
  backend = require('./lib/local-store');
  console.log(
    '[db] using the local JSON store in data/ — no GCP credentials found.\n' +
      '[db] This is fine for development. For production, see docs/gcp-deploy-setup.md.'
  );
}

module.exports = backend;
