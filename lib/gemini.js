// Vertex AI Gemini client.
//
// WHY VERTEX AI AND NOT THE FREE AI STUDIO TIER
// ---------------------------------------------
// This is the single most important decision in this file, so it is written
// down rather than assumed.
//
// Manuscripts sent here are unpublished, confidential, third-party research.
// Google's terms differ sharply between the two ways of reaching Gemini:
//
//   Vertex AI (this file)  Google contractually does NOT use customer prompts
//                          or responses to train its models. Data stays inside
//                          the customer's Cloud project boundary, encrypted in
//                          transit and at rest.
//
//   AI Studio free tier    Google DOES use submitted content to improve its
//                          products, including model training, and human
//                          reviewers may read it. Its terms explicitly warn
//                          against submitting confidential data.
//
// An unpublished manuscript is exactly the confidential data that second set
// of terms warns against. So: Vertex AI only. If someone later "simplifies"
// this by swapping in a generativelanguage.googleapis.com API key, that is a
// confidentiality regression, not a refactor.
//
// AUTHENTICATION IS KEYLESS
// -------------------------
// Cloud Run's runtime service account already holds a cloud-platform-scoped
// access token, served by the metadata server. Vertex AI accepts it directly,
// so unlike lib/gmail.js there is no JWT signing and no impersonation -- we
// are calling a Google API as ourselves, not on a user's behalf. The service
// account needs roles/aiplatform.user on the project and nothing more.
//
// Off Cloud Run (local dev, tests) there is no metadata server, so the client
// reports itself unavailable and callers degrade gracefully. Set
// GOOGLE_ACCESS_TOKEN (e.g. from `gcloud auth print-access-token`) to exercise
// it locally.

const {
  GCP_PROJECT_ID,
  VERTEX_LOCATION,
  GEMINI_MODEL,
  GEMINI_ENABLED,
  IS_CLOUD_RUN,
} = require('../config');

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_PROJECT_URL =
  'http://metadata.google.internal/computeMetadata/v1/project/project-id';

// Generous compared with the mailer's 10s: a full manuscript is a large
// prompt and the model genuinely takes tens of seconds to read it. Still
// bounded, because a hung request holding a Cloud Run instance open costs
// money and blocks the author's browser.
const REQUEST_TIMEOUT_MS = 90000;

// Hard ceiling on what we will ship to the model in one call. Vertex accepts
// far more, but this is a cost guard: a runaway 200 MB "manuscript" would be
// billed by the token. 8 MB of PDF is roughly a 60-page paper.
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

// Roughly 4 characters per token, so ~250k characters is well inside the
// context window while keeping a single check's cost predictable.
const MAX_TEXT_CHARS = 250000;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function metadataFetch(url) {
  const t = withTimeout(5000);
  try {
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: t.signal });
    if (!res.ok) throw new Error(`metadata server responded ${res.status}`);
    return res;
  } finally {
    t.done();
  }
}

// Access tokens last an hour. Cache and refresh a minute early so a long
// manuscript check never races the expiry mid-flight.
let tokenCache = null;
async function accessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;

  const res = await metadataFetch(METADATA_TOKEN_URL);
  const body = await res.json();
  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

let cachedProject = null;
async function projectId() {
  if (GCP_PROJECT_ID) return GCP_PROJECT_ID;
  if (cachedProject) return cachedProject;
  const res = await metadataFetch(METADATA_PROJECT_URL);
  cachedProject = (await res.text()).trim();
  return cachedProject;
}

// Whether a call has any chance of succeeding. Callers check this so the
// submission page can hide the feature entirely rather than offering a button
// that always errors.
function isAvailable() {
  if (!GEMINI_ENABLED) return false;
  return Boolean(IS_CLOUD_RUN || process.env.GOOGLE_ACCESS_TOKEN);
}

function endpoint(project, location, model) {
  // Vertex is regional. asia-south1 (Mumbai) keeps manuscript content in the
  // same region as the rest of this deployment, which matters for the data
  // residency promise made to authors.
  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return (
    `https://${host}/v1/projects/${encodeURIComponent(project)}` +
    `/locations/${encodeURIComponent(location)}` +
    `/publishers/google/models/${encodeURIComponent(model)}:generateContent`
  );
}

// Pulls the text out of a generateContent response, tolerating the shapes
// Vertex returns when a response is blocked or truncated rather than throwing
// a TypeError on an undefined path.
function extractText(body) {
  const candidate = body && body.candidates && body.candidates[0];
  if (!candidate) {
    const blocked = body && body.promptFeedback && body.promptFeedback.blockReason;
    if (blocked) throw new Error(`request blocked by safety filters (${blocked})`);
    throw new Error('model returned no candidates');
  }
  // MAX_TOKENS means we got a partial answer -- for JSON output that is
  // unparseable, so fail loudly rather than surfacing half a result.
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new Error(`model stopped early (${candidate.finishReason})`);
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('model returned an empty response');
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('model response was cut short (MAX_TOKENS)');
  }
  return text;
}

// Calls Gemini and returns parsed JSON.
//
// `parts` is the Vertex content-parts array -- a mix of {text} and
// {inlineData:{mimeType,data}}. `schema` is an OpenAPI-subset schema; passing
// it puts the model in constrained-decoding mode, so we get valid JSON back
// instead of prose wrapped in a markdown fence that then needs unwrapping.
async function generateJson({ parts, systemInstruction, schema, temperature = 0.2 }) {
  if (!isAvailable()) {
    throw new Error('Gemini is not configured for this environment.');
  }

  const project = await projectId();
  const token = await accessToken();
  const url = endpoint(project, VERTEX_LOCATION, GEMINI_MODEL);

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
      maxOutputTokens: 8192,
    },
  };
  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const t = withTimeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The assistant took too long to respond. Please try again.');
    }
    throw err;
  } finally {
    t.done();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 403 here almost always means roles/aiplatform.user is missing or the
    // Vertex AI API is not enabled -- say so, because the raw message doesn't.
    if (res.status === 403) {
      throw new Error(
        `Vertex AI refused the call (403). Check the Vertex AI API is enabled and the ` +
          `runtime service account has roles/aiplatform.user. ${detail.slice(0, 200)}`
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Model "${GEMINI_MODEL}" not found in ${VERTEX_LOCATION}. ` +
          `Run scripts/probe-gemini.js to list models this project can actually call.`
      );
    }
    throw new Error(`Vertex AI ${res.status}: ${detail.slice(0, 300)}`);
  }

  const body = await res.json();
  const text = extractText(body);
  try {
    return {
      data: JSON.parse(text),
      usage: body.usageMetadata || null,
    };
  } catch (err) {
    throw new Error('The assistant returned a malformed response.');
  }
}

module.exports = {
  isAvailable,
  generateJson,
  endpoint,
  extractText,
  MAX_INLINE_BYTES,
  MAX_TEXT_CHARS,
  REQUEST_TIMEOUT_MS,
};
