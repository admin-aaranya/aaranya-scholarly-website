// Reports which Gemini model IDs this project can actually call, and in which
// region.
//
// Google renames and retires model IDs on its own schedule, and documentation
// lags. Rather than hard-coding a guess and finding out in production, run
// this against the real project and set GEMINI_MODEL to something it confirms.
//
//   gcloud auth login
//   gcloud config set project aaranya-scholarly
//   set GOOGLE_ACCESS_TOKEN=...        (Windows: for /f in the .bat wrapper)
//   node scripts/probe-gemini.js
//
// It sends a one-word prompt to each candidate, so it costs a fraction of a
// rupee in total.

const CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3-flash',
];

const LOCATIONS = (process.env.PROBE_LOCATIONS || 'asia-south1,global').split(',');

const project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const token = process.env.GOOGLE_ACCESS_TOKEN;

if (!project || !token) {
  console.error(
    'Set GCP_PROJECT_ID and GOOGLE_ACCESS_TOKEN first.\n' +
      '  GOOGLE_ACCESS_TOKEN comes from: gcloud auth print-access-token'
  );
  process.exit(1);
}

function url(location, model) {
  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return (
    `https://${host}/v1/projects/${project}/locations/${location}` +
    `/publishers/google/models/${model}:generateContent`
  );
}

async function probe(location, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url(location, model), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0 },
      }),
    });
    if (res.ok) {
      const body = await res.json();
      const c = body.candidates && body.candidates[0];
      const text = ((c && c.content && c.content.parts) || [])
        .map((p) => p.text || '')
        .join('')
        .trim();
      return { ok: true, note: text.slice(0, 40) || `(finish: ${c && c.finishReason})` };
    }
    const detail = await res.text().catch(() => '');
    let msg = detail;
    try {
      msg = JSON.parse(detail).error.message;
    } catch (e) {
      /* keep raw */
    }
    return { ok: false, note: `${res.status} ${String(msg).slice(0, 110)}` };
  } catch (err) {
    return { ok: false, note: err.name === 'AbortError' ? 'timeout' : err.message.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log(`Project: ${project}\n`);
  const working = [];
  for (const location of LOCATIONS.map((l) => l.trim()).filter(Boolean)) {
    console.log(`--- ${location} ---`);
    for (const model of CANDIDATES) {
      const r = await probe(location, model);
      console.log(`  ${r.ok ? 'WORKS  ' : 'no     '} ${model.padEnd(24)} ${r.note}`);
      if (r.ok) working.push({ location, model });
    }
    console.log('');
  }

  if (!working.length) {
    console.log(
      'Nothing worked. Most likely causes, in order:\n' +
        '  1. The Vertex AI API is not enabled:\n' +
        '     gcloud services enable aiplatform.googleapis.com\n' +
        '  2. Your account lacks roles/aiplatform.user on the project.\n' +
        '  3. The access token has expired (they last one hour).'
    );
    process.exit(1);
  }

  // Prefer an in-region flash model: in-region keeps manuscripts inside
  // asia-south1, and flash is roughly an order of magnitude cheaper than pro
  // for what is essentially a careful proofread.
  const preferred =
    working.find((w) => w.location === 'asia-south1' && /flash/.test(w.model) && !/lite/.test(w.model)) ||
    working.find((w) => w.location === 'asia-south1') ||
    working[0];

  console.log('Set these on the Cloud Run service:');
  console.log(`  GEMINI_ENABLED=true`);
  console.log(`  VERTEX_LOCATION=${preferred.location}`);
  console.log(`  GEMINI_MODEL=${preferred.model}`);

  if (preferred.location !== 'asia-south1') {
    console.log(
      '\nNOTE: no model answered in asia-south1, so this falls back to ' +
        `${preferred.location}. Manuscripts would then be processed outside the Mumbai ` +
        'region. Check that against what the submission page promises authors before ' +
        'accepting it.'
    );
  }

  // Written for the .bat wrapper to read, so the deploy uses a model that was
  // actually confirmed to work rather than one typed in by hand.
  require('fs').writeFileSync(
    require('path').join(__dirname, '..', '_gemini-model.txt'),
    `${preferred.location}\n${preferred.model}\n`,
    'utf8'
  );
})();
