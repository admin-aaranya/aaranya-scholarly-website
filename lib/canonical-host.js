// One address for the journal.
//
// Firebase Hosting's default `*.web.app` domain cannot be deleted -- it is
// permanent for the site. So "keep only journals.aaranyascholarly.com" is
// implemented by redirecting every other public address to it rather than by
// switching one off.
//
// This matters beyond tidiness. The same article reachable at two hostnames
// is duplicate content: search engines split their signals across both, and
// citations end up pointing at whichever one the author happened to copy.
// Canonical tags help, a 301 settles it.
//
// THREE EXEMPTIONS, EACH LOAD-BEARING
//
// 1. Only GET and HEAD are redirected. A 301 on a POST is not reliably
//    re-issued as a POST by every client, and one of the POSTs arriving here
//    is Cloud Scheduler's reminder sweep. Silently breaking that would stop
//    every reviewer reminder while leaving nothing visibly wrong -- the exact
//    failure this codebase keeps trying to design out.
//
// 2. The raw *.run.app URL passes through. It is how Cloud Run health checks,
//    `gcloud run services proxy` and direct debugging reach the service. A
//    redirect there would send diagnostics through Firebase Hosting and hide
//    the thing being diagnosed.
//
// 3. localhost passes through, or development would bounce to production.

function hostOf(urlish) {
  const match = /^https?:\/\/([^/:]+)/i.exec(String(urlish || ''));
  return match ? match[1].toLowerCase() : '';
}

function isExemptHost(host) {
  if (!host) return true; // no host to judge; do nothing
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.run.app')) return true;
  return false;
}

// Pure decision: returns the absolute URL to redirect to, or null to continue.
//
// Kept separate from the middleware so the rules can be tested without
// standing up an HTTP server -- these are exactly the rules that are painful
// to verify in production, because getting them wrong means an infinite
// redirect loop on the live site.
function redirectTarget({ method, host, originalUrl, siteUrl }) {
  const canonical = hostOf(siteUrl);
  if (!canonical) return null; // SITE_URL unset or malformed: never redirect

  const upper = String(method || '').toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return null;

  const requestHost = String(host || '').toLowerCase();
  if (isExemptHost(requestHost)) return null;
  if (requestHost === canonical) return null; // already there

  const base = String(siteUrl).replace(/\/+$/, '');
  const path = originalUrl || '/';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

// Express middleware. Mount before everything else, so a redirected request
// never touches a route, a datastore or the static handler.
function canonicalHost(siteUrl) {
  return function canonicalHostMiddleware(req, res, next) {
    // Behind Firebase Hosting the visitor's hostname arrives in
    // X-Forwarded-Host; Host is the internal one. Prefer the forwarded value
    // and fall back for direct requests.
    const forwarded = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const host = forwarded || req.hostname || '';

    const target = redirectTarget({
      method: req.method,
      host,
      originalUrl: req.originalUrl,
      siteUrl,
    });

    if (!target) return next();

    // 301, not 302: this is permanent, and only a permanent redirect
    // consolidates search ranking onto the canonical host.
    res.set('Cache-Control', 'public, max-age=3600');
    return res.redirect(301, target);
  };
}

module.exports = { canonicalHost, redirectTarget, hostOf, isExemptHost };
