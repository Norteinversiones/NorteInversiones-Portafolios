/* ============================================================
   TICKER · cinta de cotizaciones (S&P 500, Nasdaq, Merval, Oro, WTI, MEP, riesgo país).
   Lee market/ticker (lo escribe el robot cada 30 min en horario de mercado) y lo
   refresca cada 15 minutos mientras la app esté abierta. Animación en CSS; se pausa
   al pasar el mouse o tocar. Verde/rojo sólo en la variación %.
   ============================================================ */
(function () {
  'use strict';
  var N = window.NORTE, E = N.engine;
  var REFRESH_MS = 15 * 60 * 1000;
  var timer = null;

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function fmtValor(it) {
    if (it.value == null || isNaN(it.value)) return '—';
    var dec = it.decimals == null ? 2 : it.decimals;
    if (it.unit === '$') return '$' + E.fmtNum(it.value, dec);
    if (it.unit && it.unit.indexOf('US$') === 0) return 'US$' + E.fmtNum(it.value, dec);
    if (it.unit === 'pb') return E.fmtNum(it.value, 0) + ' pb';
    return E.fmtNum(it.value, dec);
  }
  function fmtVar(it) {
    if (it.changePct == null || isNaN(it.changePct)) return '<span class="var">—</span>';
    var v = Number(it.changePct);
    return '<span class="var ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '') + '">' + E.fmtPct(v) + '</span>';
  }
  function itemHtml(it) {
    return '<span class="tk-item' + (it.stale ? ' stale' : '') + '" title="' + h(it.label) + (it.asOf ? ' · ' + h(String(it.asOf).slice(0, 16).replace('T', ' ')) : '') + '">' +
      '<span class="lbl">' + h(it.label) + '</span><span class="val">' + fmtValor(it) + '</span>' + fmtVar(it) + '</span>';
  }

  function render(doc) {
    var el = document.getElementById('ticker');
    if (!el) return;
    var items = doc && Array.isArray(doc.items) ? doc.items : [];
    if (!items.length) { el.classList.add('hidden'); return; }
    var html = items.map(itemHtml).join('<span class="tk-sep">·</span>');
    // El contenido se duplica para que el loop sea continuo (la animación corre -50%).
    el.innerHTML = '<div class="tk-track"><div class="tk-group">' + html + '<span class="tk-sep">·</span></div><div class="tk-group" aria-hidden="true">' + html + '<span class="tk-sep">·</span></div></div>';
    el.classList.remove('hidden');
    // Duración proporcional al ancho para que la velocidad sea siempre parecida.
    var track = el.querySelector('.tk-track');
    var w = track.scrollWidth / 2 || 800;
    track.style.animationDuration = Math.max(20, Math.round(w / 45)) + 's';
    // Pausa al tocar en mobile (en desktop la pausa es por :hover en CSS).
    el.ontouchstart = function () { el.classList.toggle('paused'); };
  }

  async function load() {
    try { render(await N.db.getMarketTicker()); }
    catch (e) { console.warn('ticker:', e.message); }
  }

  N.ticker = {
    init: function () {
      load();
      if (timer) clearInterval(timer);
      timer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
    }
  };
})();
