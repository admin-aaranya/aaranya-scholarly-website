/* ============================================================
   AARANYA SCHOLARLY — journal landing page article rail.

   Fills #jcContent on journals/*.html with what the journal has
   actually published: a lead article, a featured grid, and the
   current issue's contents.

   THE PRE-LAUNCH STATE IS THE DEFAULT, AND IT IS SERVER-RENDERED.
   The call for papers is written into the page HTML, not produced
   here. So a visitor with JavaScript disabled, a slow connection,
   or a failed API call still sees a complete page that asks for
   submissions — never a spinner and never a blank shelf. This
   script only ever REPLACES that state, and only once it has real
   articles in hand.

   Every failure path therefore ends in "leave the page alone".

   The journal code comes from the filename, so this file is
   identical on all seven pages with nothing per-journal to keep
   in sync.
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
    return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // "Sharma R., Patel A." — trimmed, because a card cannot carry
  // fourteen names and stay readable.
  function authorLine(authors, max) {
    var list = (authors || []).map(function (a) { return esc(a.name); });
    if (!list.length) return '';
    if (list.length > max) return list.slice(0, max).join(', ') + ' <i>et al.</i>';
    return list.join(', ');
  }

  function typeAndDate(a) {
    var bits = [];
    if (a.articleType) bits.push(esc(a.articleType));
    var d = fmtDate(a.publishedAt);
    if (d) bits.push(d);
    return bits.join(' &middot; ');
  }

  function leadHtml(a, code) {
    return '<div class="jc-lead">' +
      '<div>' +
        '<div class="jc-kicker">Latest</div>' +
        '<h3><a href="' + esc(a.url) + '">' + esc(a.title) + '</a></h3>' +
        '<div class="jc-authors">' + authorLine(a.authors, 6) + '</div>' +
        '<div class="jc-meta">' + typeAndDate(a) +
          (a.pages ? ' &middot; pp. ' + esc(a.pages) : '') + '</div>' +
      '</div>' +
      '<div class="jc-figure"><div>' +
        '<div class="jc-figmark">' + esc(code.toUpperCase()) + '</div>' +
        '<div class="jc-figsub">' + esc(a.issueLabel || '') + '</div>' +
      '</div></div>' +
    '</div>';
  }

  function cardHtml(a, code) {
    return '<div class="jc-card">' +
      '<div class="jc-thumb">' + esc(code.toUpperCase()) + '</div>' +
      '<h4><a href="' + esc(a.url) + '">' + esc(a.title) + '</a></h4>' +
      '<div class="jc-authors">' + authorLine(a.authors, 3) + '</div>' +
      '<div class="jc-meta">' + typeAndDate(a) + '</div>' +
    '</div>';
  }

  function issueHtml(issue, articles, code) {
    var items = articles.map(function (a) {
      return '<li><a href="' + esc(a.url) + '">' + esc(a.title) + '</a>' +
        '<div class="jc-authors">' + authorLine(a.authors, 4) +
        (a.pages ? ' &middot; pp. ' + esc(a.pages) : '') + '</div></li>';
    }).join('');

    return '<div class="jc-head" style="margin-top:34px;">' +
        '<h2>Current issue</h2>' +
        '<a href="' + esc(issue.url) + '">Full contents &rarr;</a>' +
      '</div>' +
      '<div class="jc-issue">' +
        '<ul class="jc-toc">' + items + '</ul>' +
        '<div class="jc-cover">' +
          '<div class="cv-vol">' + esc(issue.label) + '</div>' +
          '<div class="cv-code">' + esc(code.toUpperCase()) + '</div>' +
          '<div class="cv-name">' + (issue.publishedAt ? 'Published ' + esc(fmtDate(issue.publishedAt)) : '') + '</div>' +
          '<a class="btn btn-gold btn-sm" href="' + esc(issue.url) + '">Read this issue</a>' +
        '</div>' +
      '</div>';
  }

  function render(code, latest, issues, issueArticles) {
    var target = document.getElementById('jcContent');
    if (!target) return;

    var html = leadHtml(latest[0], code);

    var rest = latest.slice(1, 5);
    if (rest.length) {
      html += '<div class="jc-grid">' +
        rest.map(function (a) { return cardHtml(a, code); }).join('') +
        '</div>';
    }

    if (issues.length && issueArticles && issueArticles.length) {
      html += issueHtml(issues[0], issueArticles, code);
    }

    target.innerHTML = html;

    // The nav's Archive dropdown pointed at an in-page anchor that no longer
    // holds a list. Send it to the real archive instead.
    Array.prototype.forEach.call(document.querySelectorAll('a[href="#archive"]'), function (a) {
      a.setAttribute('href', '/archive/' + code);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var code = journalCode();
    if (!code || !document.getElementById('jcContent')) return;

    var api = function (path) {
      return fetch(path).then(function (r) { return r.ok ? r.json() : null; });
    };

    Promise.all([
      api('/api/public/latest?journal=' + encodeURIComponent(code) + '&limit=5'),
      api('/api/public/journals/' + encodeURIComponent(code) + '/issues')
    ])
      .then(function (res) {
        var latest = (res[0] && res[0].articles) || [];
        var issues = (res[1] && res[1].issues) || [];

        // Nothing published: leave the call for papers exactly as served.
        if (!latest.length) return null;

        if (!issues.length) return render(code, latest, [], []);

        // One more call for the current issue's table of contents.
        return api('/api/public/issues/' + encodeURIComponent(issues[0].id))
          .then(function (d) {
            render(code, latest, issues, (d && d.articles) || []);
          });
      })
      .catch(function () { /* leave the pre-launch state in place */ });
  });
})();
