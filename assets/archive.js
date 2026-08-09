/* ============================================================
   AARANYA SCHOLARLY — live archive strip for the journal pages.

   Each journals/*.html ships a hand-written "Volume 1, Issue 1 is
   in preparation" placeholder inside #archive. That is the right
   thing to show a visitor until something is actually published,
   so this script leaves it alone and only replaces it once the
   public API reports released issues.

   Failing quietly is deliberate: if the API is unreachable, the
   visitor still sees the placeholder rather than a broken panel.

   The journal code comes from the filename, so this file is
   identical on all seven pages and there is nothing per-journal
   to keep in sync.
   ============================================================ */
(function () {
  function journalCode() {
    var m = /([a-z]+)\.html$/i.exec(window.location.pathname);
    return m ? m[1].toLowerCase() : '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(d) {
    if (!d) return '';
    var parsed = new Date(d);
    if (isNaN(parsed)) return '';
    return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  }

  function authorLine(authors) {
    return (authors || [])
      .map(function (a) { return esc(a.name); })
      .join(', ');
  }

  function render(section, code, issues, latest) {
    var head = section.querySelector('.tabs-head');
    var empty = section.querySelector('.empty-state');

    var html =
      '<div class="panel">' +
        '<div class="panel-head">' +
          '<div><h3>Latest articles</h3>' +
          '<p class="panel-sub">Most recently published across all issues.</p></div>' +
          '<a class="btn btn-outline btn-sm" href="/archive/' + esc(code) + '">Browse the full archive</a>' +
        '</div>' +
        latest.map(function (a) {
          return '<div style="padding:14px 0;border-bottom:1px solid var(--line);">' +
            '<div style="font-size:15.5px;line-height:1.4;margin-bottom:4px;">' +
              '<a href="' + esc(a.url) + '" style="color:var(--ink);text-decoration:none;font-weight:600;">' + esc(a.title) + '</a>' +
            '</div>' +
            '<div style="font-size:12.5px;color:var(--muted);">' + authorLine(a.authors) + '</div>' +
            '<div style="font-size:12px;color:var(--muted);margin-top:3px;">' +
              esc(a.issueLabel || '') + (a.pages ? ' · pp. ' + esc(a.pages) : '') +
              (a.doi ? ' · <a href="https://doi.org/' + esc(a.doi) + '" style="color:var(--teal);">doi:' + esc(a.doi) + '</a>' : '') +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';

    if (issues.length) {
      html +=
        '<div class="panel">' +
          '<div class="panel-head"><div><h3>Issues</h3>' +
          '<p class="panel-sub">Every released issue, most recent first.</p></div></div>' +
          issues.slice(0, 6).map(function (i) {
            return '<div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--line);">' +
              '<a href="' + esc(i.url) + '" style="color:var(--ink);text-decoration:none;font-weight:600;font-size:14.5px;">' + esc(i.label) + '</a>' +
              '<span style="font-size:12px;color:var(--muted);">' + i.articleCount + ' article' + (i.articleCount === 1 ? '' : 's') +
              (i.publishedAt ? ' · ' + esc(fmtDate(i.publishedAt)) : '') + '</span>' +
            '</div>';
          }).join('') +
          (issues.length > 6
            ? '<div style="margin-top:12px;"><a class="btn btn-ghost btn-sm" href="/archive/' + esc(code) + '">See all ' + issues.length + ' issues</a></div>'
            : '') +
        '</div>';
    }

    if (empty) empty.outerHTML = html;
    else section.querySelector('.wrap').insertAdjacentHTML('beforeend', html);

    // The placeholder tab strip described content that does not exist yet
    // ("Most Read", "Articles In-Press"). Once there are real articles it
    // would be three buttons that do nothing.
    if (head) head.remove();

    // Point the nav's Archive dropdown at the real thing.
    Array.prototype.forEach.call(document.querySelectorAll('a[href="#archive"]'), function (a) {
      if (a.closest('.dropdown')) a.setAttribute('href', '/archive/' + code);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var section = document.getElementById('archive');
    var code = journalCode();
    if (!section || !code) return;

    Promise.all([
      fetch('/api/public/journals/' + encodeURIComponent(code) + '/issues').then(function (r) { return r.ok ? r.json() : { issues: [] }; }),
      fetch('/api/public/latest?journal=' + encodeURIComponent(code) + '&limit=5').then(function (r) { return r.ok ? r.json() : { articles: [] }; })
    ])
      .then(function (res) {
        var issues = (res[0] && res[0].issues) || [];
        var latest = (res[1] && res[1].articles) || [];
        if (!latest.length) return; // nothing published yet — keep the placeholder
        render(section, code, issues, latest);
      })
      .catch(function () { /* keep the placeholder */ });
  });
})();
