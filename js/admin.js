/* ============================================================
   PANEL ADMIN · Norte Inversiones
   Criterio de diseño: cargar y publicar la rotación de los 3 portafolios en
   menos de 10 minutos. Ningún cálculo de rendimiento vive acá: todo pasa por
   engine.js (vía recompute.js).
   ============================================================ */
(function () {
  'use strict';
  var N = window.NORTE, E = N.engine, db = N.db;

  var S = {
    user: null, instruments: [], insMap: {}, portfolios: [], pmap: {},
    slug: 'conservador', versions: {}, monthly: {}, live: null, lastEod: [], book: null,
    accounts: [], education: [], health: null, draft: null, editIns: null, editCard: null
  };

  // ---------- utilidades ----------
  function $(id) { return document.getElementById(id); }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { var n = Number(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  function toast(msg, bad) {
    var t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, bad ? 5000 : 2600);
  }
  function fmtTs(t) {
    if (!t) return '—';
    var d = t.toDate ? t.toDate() : new Date(t);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function pctClass(v) { return v == null ? '' : v >= 0 ? 'pos' : 'neg'; }
  function tipo(t) { return N.TIPOS[t] || t || '—'; }
  function activeInstruments() { return S.instruments.filter(function (i) { return i.isActive !== false; }); }
  function published(slug) { return (S.versions[slug] || []).filter(function (v) { return v.status === 'published'; }); }
  function currentVersion(slug) { var p = published(slug); return p.length ? p[p.length - 1] : null; }
  function currentDraft(slug) {
    var d = (S.versions[slug] || []).filter(function (v) { return v.status === 'draft'; });
    return d.length ? d[d.length - 1] : null;
  }
  function busy(on) { document.body.style.cursor = on ? 'progress' : ''; }

  // ---------- auth ----------
  var auth = db.init();
  auth.onAuthStateChanged(async function (user) {
    $('loading').classList.add('hidden');
    if (!user) { $('login').classList.remove('hidden'); $('app').classList.add('hidden'); $('userBox').innerHTML = ''; return; }
    var mail = (user.email || '').toLowerCase();
    if (N.adminEmails.indexOf(mail) < 0) {
      $('loginMsg').textContent = 'La cuenta ' + mail + ' no está autorizada.';
      await auth.signOut(); return;
    }
    S.user = user;
    $('userBox').innerHTML = '<span class="mail">' + h(mail) + '</span><button class="btn sm sec" id="btnLogout">Salir</button>';
    $('btnLogout').onclick = function () { auth.signOut(); };
    $('login').classList.add('hidden');
    $('loading').classList.remove('hidden');
    try { await loadAll(); } catch (e) { console.error(e); toast('Error al cargar: ' + e.message, true); }
    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');
    render();
  });
  $('btnLogin').onclick = async function () {
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try { await auth.signInWithPopup(provider); }
    catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') await auth.signInWithRedirect(provider);
      else $('loginMsg').textContent = 'No se pudo iniciar sesión: ' + (e.message || e.code);
    }
  };

  // ---------- carga ----------
  async function loadAll() {
    S.instruments = await db.getInstruments();
    S.insMap = {}; S.instruments.forEach(function (i) { S.insMap[i.ticker] = i; });
    S.portfolios = await db.getPortfolios();
    if (!S.portfolios.length) { await db.seedPortfolios(); S.portfolios = await db.getPortfolios(); }
    S.pmap = {}; S.portfolios.forEach(function (p) { S.pmap[p.slug] = p; });
    await Promise.all(S.portfolios.map(async function (p) { S.versions[p.slug] = await db.getVersions(p.slug, true); }));
    await reloadQuotes();
    S.health = await db.getJobHealth();
  }
  async function reloadQuotes() {
    S.live = await db.getLiveQuote();
    S.lastEod = await db.getLastQuotes(8);
    S.book = E.quoteBook(S.lastEod, S.live);
  }
  async function reloadPortfolio(slug) {
    S.versions[slug] = await db.getVersions(slug, true);
    var ps = await db.getPortfolios(); S.portfolios = ps; S.pmap = {}; ps.forEach(function (p) { S.pmap[p.slug] = p; });
    delete S.monthly[slug];
  }

  // ---------- navegación ----------
  var TAB = 'rotacion';
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    TAB = b.dataset.tab;
    Array.prototype.forEach.call($('tabs').children, function (x) { x.classList.toggle('on', x === b); });
    ['rotacion', 'historico', 'catalogo', 'comitentes', 'fichas', 'ingesta'].forEach(function (t) { $('tab-' + t).classList.toggle('hidden', t !== TAB); });
    render();
  });
  function render() {
    if (TAB === 'rotacion') renderRotacion();
    else if (TAB === 'historico') renderHistorico();
    else if (TAB === 'catalogo') renderCatalogo();
    else if (TAB === 'comitentes') renderComitentes();
    else if (TAB === 'fichas') renderFichas();
    else if (TAB === 'ingesta') renderIngesta();
  }
  function pillsHtml() {
    return '<div class="pills mb" data-role="slug">' + S.portfolios.map(function (p) {
      return '<button data-slug="' + p.slug + '" class="' + (p.slug === S.slug ? 'on' : '') + '">' + h(p.name) + '</button>';
    }).join('') + '</div>';
  }
  function bindPills(section) {
    var pills = section.querySelector('[data-role=slug]'); if (!pills) return;
    pills.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.slug = b.dataset.slug; S.draft = null; render();
    });
  }
  function tickerOptions(sel) {
    var groups = {};
    activeInstruments().forEach(function (i) { (groups[i.type] = groups[i.type] || []).push(i); });
    return '<option value="">— ticker —</option>' + Object.keys(groups).map(function (t) {
      return '<optgroup label="' + h(tipo(t)) + '">' + groups[t].map(function (i) {
        return '<option value="' + i.ticker + '"' + (i.ticker === sel ? ' selected' : '') + '>' + i.ticker + ' · ' + h(i.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  // ============================================================
  // ROTACIÓN
  // ============================================================
  function renderRotacion() {
    var sec = $('tab-rotacion');
    var slug = S.slug, p = S.pmap[slug], cur = currentVersion(slug), draft = currentDraft(slug);
    if (!S.draft && draft) S.draft = JSON.parse(JSON.stringify(draft));
    var html = pillsHtml();

    // --- vigente ---
    html += '<div class="card"><div class="row between"><div><h2>' + h(p.name) + ' · versión vigente</h2>';
    if (cur) {
      var st = p.stats || {};
      html += '<div class="sub">Rotación del ' + E.fmtDate(cur.effectiveFrom) + ' · CCL de compra ' + E.fmtArs(cur.cclAtBuy) + (cur.publishedAt ? ' · publicada ' + fmtTs(cur.publishedAt) : '') + '</div></div>';
      html += '<div class="row"><button class="btn sec sm" data-act="recalc">Recalcular</button></div></div>';
      html += '<div class="kpis mb">' +
        kpi('Mes en curso ARS', st.current ? E.fmtPct(st.current.ars) : '—', st.current && st.current.ars) +
        kpi('Mes en curso USD', st.current ? E.fmtPct(st.current.usd) : '—', st.current && st.current.usd) +
        kpi('Acumulado ARS', st.accArs != null ? E.fmtPct(st.accArs) : '—', st.accArs) +
        kpi('Acumulado USD', st.accUsd != null ? E.fmtPct(st.accUsd) : '—', st.accUsd) +
        kpi('Beta', E.fmtNum(E.betaPortfolio(cur.holdings), 3)) + '</div>';
      if (st.current && st.current.basisIsPartial) html += '<div class="alert warn">El mes en curso se mide desde el ' + E.fmtDate(st.current.basisDate) + ' (primer cierre disponible), no desde el inicio del mes.</div>';
      if (st.current && st.current.missing && st.current.missing.length) html += '<div class="alert bad">Sin precio: ' + st.current.missing.join(', ') + '. Revisá el catálogo o la ingesta.</div>';
      html += holdingsTable(cur.holdings, false);
      if (cur.rationale) html += '<p class="mt"><b>Rationale:</b> ' + h(cur.rationale).replace(/\n/g, '<br>') + '</p>';
    } else {
      html += '<div class="sub">Todavía no hay ninguna versión publicada.</div></div></div>';
    }
    html += '</div>';

    // --- borrador / editor ---
    html += '<div class="card" id="draftCard">';
    if (S.draft) {
      html += renderEditor(S.draft, cur);
    } else {
      html += '<h2>' + h(p.name) + ' · nueva rotación</h2><div class="sub">Se crea un borrador. No cambia nada para los clientes hasta que publiques.</div><div class="row">';
      if (cur) html += '<button class="btn" data-act="newdraft">Duplicar la versión vigente</button>';
      if (N.SEED.versions[slug]) html += '<button class="btn sec" data-act="seeddraft">Cargar tenencias del documento (' + E.fmtDate(N.SEED.versions[slug].effectiveFrom) + ')</button>';
      html += '<button class="btn sec" data-act="emptydraft">Empezar en blanco</button></div>';
    }
    html += '</div>';

    // --- versiones anteriores ---
    var prev = published(slug).slice(0, -1).reverse();
    if (prev.length) {
      html += '<div class="card flat"><h3>Rotaciones anteriores</h3><ul class="verlist">' + prev.map(function (v) {
        return '<li>' + E.fmtDate(v.effectiveFrom) + ' → ' + (v.effectiveTo ? E.fmtDate(v.effectiveTo) : 'vigente') + ' · ' + v.holdings.length + ' activos · beta ' + E.fmtNum(E.betaPortfolio(v.holdings), 3) + '</li>';
      }).join('') + '</ul></div>';
    }

    sec.innerHTML = html;
    bindPills(sec);
    bindRotacion(sec, slug, cur);
  }
  function kpi(l, v, n) { return '<div class="kpi"><div class="l">' + h(l) + '</div><div class="v ' + pctClass(n) + '">' + v + '</div></div>'; }

  function holdingsTable(holdings, live) {
    var rows = holdings.map(function (hd) {
      var ins = S.insMap[hd.ticker] || {};
      var now = S.book ? S.book.priceLatest(hd.ticker) : null;
      return '<tr><td><b>' + h(hd.ticker) + '</b><br><small>' + h(ins.name || '') + '</small></td><td>' + h(tipo(ins.type)) + '</td>' +
        '<td class="num">' + E.fmtNum(hd.weightPct, 2) + '%</td><td class="num">' + E.fmtArs(hd.buyPriceArs) + '</td>' +
        '<td class="num">' + (now ? E.fmtArs(now.price) + '<br><small class="' + pctClass(now.price / hd.buyPriceArs - 1) + '">' + E.fmtPct((now.price / hd.buyPriceArs - 1) * 100) + '</small>' : '—') + '</td>' +
        '<td class="num">' + E.fmtNum(hd.beta, 2) + '</td></tr>';
    }).join('');
    return '<div class="tablewrap"><table><thead><tr><th>Activo</th><th>Tipo</th><th class="num">%</th><th class="num">Compra ARS</th><th class="num">Último</th><th class="num">Beta</th></tr></thead><tbody>' + rows +
      '<tr class="total"><td colspan="2">Total</td><td class="num">' + E.fmtNum(E.weightTotal(holdings), 2) + '%</td><td></td><td></td><td class="num">' + E.fmtNum(E.betaPortfolio(holdings), 3) + '</td></tr></tbody></table></div>';
  }

  function renderEditor(d, cur) {
    var total = E.weightTotal(d.holdings), ok = Math.abs(total - 100) < 1e-6;
    var latest = S.book && S.book.latestDate ? (S.book.liveOk ? 'intradía ' + E.fmtDate(S.book.latestDate) : 'cierre ' + E.fmtDate(S.book.latestDate)) : 'sin precios';
    var html = '<div class="row between"><h2>' + h(S.pmap[S.slug].name) + ' · borrador de rotación <span class="tag draft">borrador</span></h2>' +
      '<button class="btn danger sm" data-act="discard">Descartar borrador</button></div>' +
      '<div class="sub">Los precios de compra son los del día de la rotación. "Tomar precios actuales" usa la última cotización (' + latest + ').</div>' +
      '<div class="row">' +
      '<label class="f"><span>Fecha de rotación</span><input type="date" data-f="effectiveFrom" value="' + h(d.effectiveFrom || '') + '"></label>' +
      '<label class="f"><span>CCL del día</span><input type="number" step="0.01" data-f="cclAtBuy" value="' + h(d.cclAtBuy || '') + '"></label>' +
      '<label class="f"><span>MEP del día</span><input type="number" step="0.01" data-f="mepAtBuy" value="' + h(d.mepAtBuy || '') + '"></label>' +
      '<button class="btn sec sm" data-act="takefx">Tomar CCL/MEP actual</button></div>';

    html += '<div class="tablewrap"><table class="holdings"><thead><tr><th>Activo</th><th class="num">%</th><th class="num">Compra ARS</th><th class="num">Último</th><th class="num">Beta</th><th>Nota</th><th></th></tr></thead><tbody>';
    d.holdings.forEach(function (hd, i) {
      var now = S.book ? S.book.priceLatest(hd.ticker) : null;
      html += '<tr data-i="' + i + '"><td><select class="w-t" data-h="ticker">' + tickerOptions(hd.ticker) + '</select></td>' +
        '<td class="num"><input class="w-s" type="number" step="0.01" data-h="weightPct" value="' + h(hd.weightPct) + '"></td>' +
        '<td class="num"><input class="w-m" type="number" step="0.01" data-h="buyPriceArs" value="' + h(hd.buyPriceArs) + '"></td>' +
        '<td class="num">' + (now ? E.fmtNum(now.price, 2) : '<span class="tag bad">sin precio</span>') + '</td>' +
        '<td class="num"><input class="w-s" type="number" step="0.01" data-h="beta" value="' + h(hd.beta) + '"></td>' +
        '<td><input type="text" data-h="note" value="' + h(hd.note || '') + '" placeholder="opcional"></td>' +
        '<td><button class="iconbtn" data-act="delrow" title="Quitar">✕</button></td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="sumbar"><button class="btn sec sm" data-act="addrow">+ Agregar activo</button>' +
      '<button class="btn sec sm" data-act="takepx">Tomar precios actuales</button>' +
      '<span class="grow"></span>' +
      '<span>Suma <span class="big ' + (ok ? 'pos' : 'neg') + '">' + E.fmtNum(total, 2) + '%</span></span>' +
      '<span>Beta <span class="big">' + E.fmtNum(E.betaPortfolio(d.holdings), 3) + '</span></span></div>';
    var comp = E.compositionByType(d.holdings, S.insMap);
    html += '<p class="muted">' + comp.map(function (c) { return h(tipo(c.type)) + ' ' + E.fmtNum(c.weightPct, 0) + '%'; }).join(' · ') + '</p>';
    html += '<label class="f"><span>Rationale (por qué esta rotación; lo ven los clientes)</span><textarea data-f="rationale">' + h(d.rationale || '') + '</textarea></label>';
    html += '<div id="draftErrors"></div>';
    html += '<div class="row"><button class="btn sec" data-act="savedraft">Guardar borrador</button><button class="btn amarillo" data-act="publish">Publicar rotación</button></div>';
    return html;
  }

  function bindRotacion(sec, slug, cur) {
    sec.addEventListener('input', function (e) {
      var t = e.target, d = S.draft; if (!d) return;
      if (t.dataset.f) { d[t.dataset.f] = t.type === 'number' ? num(t.value) : t.value; return; }
      if (t.dataset.h) {
        var tr = t.closest('tr'); var i = Number(tr.dataset.i); var f = t.dataset.h;
        d.holdings[i][f] = (t.type === 'number') ? num(t.value) : t.value;
        if (f === 'ticker') { var now = S.book ? S.book.priceLatest(t.value) : null; if (now && !(d.holdings[i].buyPriceArs > 0)) { d.holdings[i].buyPriceArs = now.price; } refreshEditor(); }
        else if (f === 'weightPct' || f === 'beta') refreshSums();
      }
    });
    sec.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var act = b.dataset.act;
      try {
        if (act === 'newdraft') { S.draft = newDraftFrom(cur); refreshEditor(true); }
        else if (act === 'seeddraft') { S.draft = newDraftFrom(N.SEED.versions[slug], true); refreshEditor(true); }
        else if (act === 'emptydraft') { S.draft = { status: 'draft', effectiveFrom: E.todayART(), cclAtBuy: null, mepAtBuy: null, rationale: '', holdings: [] }; refreshEditor(true); }
        else if (act === 'discard') {
          if (!confirm('¿Descartar el borrador?')) return;
          if (S.draft.id) await db.deleteVersion(slug, S.draft.id);
          S.draft = null; await reloadPortfolio(slug); renderRotacion(); toast('Borrador descartado');
        }
        else if (act === 'addrow') { S.draft.holdings.push({ ticker: '', weightPct: null, buyPriceArs: null, beta: null, note: '' }); refreshEditor(); }
        else if (act === 'delrow') { var i = Number(b.closest('tr').dataset.i); S.draft.holdings.splice(i, 1); refreshEditor(); }
        else if (act === 'takefx') {
          var fx = S.book && S.book.liveOk ? S.live.fx : (S.lastEod[0] && S.lastEod[0].fx);
          if (!fx) return toast('No hay CCL/MEP disponible', true);
          S.draft.cclAtBuy = fx.ccl; S.draft.mepAtBuy = fx.mep; refreshEditor(); toast('CCL ' + E.fmtArs(fx.ccl) + ' · MEP ' + E.fmtArs(fx.mep));
        }
        else if (act === 'takepx') {
          var n = 0;
          S.draft.holdings.forEach(function (hd) { var now = S.book ? S.book.priceLatest(hd.ticker) : null; if (now) { hd.buyPriceArs = now.price; n++; } });
          var fx2 = S.book && S.book.liveOk ? S.live.fx : (S.lastEod[0] && S.lastEod[0].fx);
          if (fx2) { S.draft.cclAtBuy = fx2.ccl; S.draft.mepAtBuy = fx2.mep; }
          refreshEditor(); toast(n + ' precios tomados de ' + (S.book.liveOk ? 'intradía' : 'cierre') + ' ' + E.fmtDate(S.book.latestDate));
        }
        else if (act === 'savedraft') { await saveDraft(slug); toast('Borrador guardado'); }
        else if (act === 'publish') { await publish(slug, cur); }
        else if (act === 'recalc') { busy(true); await N.recompute(slug, { force: false }); await reloadPortfolio(slug); busy(false); renderRotacion(); toast('Rendimientos recalculados'); }
      } catch (err) { busy(false); console.error(err); toast('Error: ' + (err.message || err), true); }
    });
  }
  // keepMeta=true conserva fecha, CCL/MEP y rationale del origen (tenencias del documento).
  function newDraftFrom(v, keepMeta) {
    return { status: 'draft', effectiveFrom: keepMeta ? v.effectiveFrom : E.todayART(),
      cclAtBuy: keepMeta ? v.cclAtBuy : null, mepAtBuy: keepMeta ? v.mepAtBuy : null, rationale: keepMeta ? (v.rationale || '') : '',
      holdings: (v.holdings || []).map(function (hd) { return { ticker: hd.ticker, weightPct: hd.weightPct, buyPriceArs: hd.buyPriceArs, beta: hd.beta, note: hd.note || '' }; }) };
  }
  function refreshEditor(scroll) {
    var card = $('draftCard'); card.innerHTML = renderEditor(S.draft, currentVersion(S.slug));
    if (scroll) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function refreshSums() {
    var d = S.draft, total = E.weightTotal(d.holdings), ok = Math.abs(total - 100) < 1e-6;
    var bar = document.querySelector('#draftCard .sumbar'); if (!bar) return;
    var bigs = bar.querySelectorAll('.big');
    bigs[0].textContent = E.fmtNum(total, 2) + '%'; bigs[0].className = 'big ' + (ok ? 'pos' : 'neg');
    bigs[1].textContent = E.fmtNum(E.betaPortfolio(d.holdings), 3);
  }
  function draftPayload() {
    var d = S.draft;
    return { status: 'draft', effectiveFrom: d.effectiveFrom, cclAtBuy: num(d.cclAtBuy), mepAtBuy: num(d.mepAtBuy), rationale: d.rationale || '',
      holdings: d.holdings.map(function (hd) { return { ticker: hd.ticker, weightPct: num(hd.weightPct), buyPriceArs: num(hd.buyPriceArs), beta: num(hd.beta) || 0, note: hd.note || '' }; }) };
  }
  async function saveDraft(slug) {
    var id = await db.saveVersion(slug, S.draft.id || null, draftPayload());
    S.draft.id = id; await reloadPortfolio(slug); return id;
  }
  async function publish(slug, cur) {
    var payload = draftPayload();
    var errs = E.validateVersion(payload, S.instruments.map(function (i) { return i.ticker; }), cur);
    var box = $('draftErrors');
    if (errs.length) { box.innerHTML = '<div class="alert bad"><b>No se puede publicar:</b><ul>' + errs.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul></div>'; return; }
    box.innerHTML = '';
    var msg = 'Publicar la rotación del ' + E.fmtDate(payload.effectiveFrom) + ' para ' + S.pmap[slug].name + ' con ' + payload.holdings.length + ' activos.' +
      (cur ? '\nLa versión vigente (' + E.fmtDate(cur.effectiveFrom) + ') queda cerrada en esa fecha.' : '') + '\n\nUna versión publicada no se edita. ¿Confirmás?';
    if (!confirm(msg)) return;
    busy(true);
    try {
      var id = await saveDraft(slug);
      await db.publishVersion(slug, Object.assign({ id: id }, payload), S.user.email);
      await N.recompute(slug, { force: false });
      S.draft = null; await reloadPortfolio(slug);
      busy(false); renderRotacion(); toast('Rotación publicada');
    } catch (e) { busy(false); throw e; }
  }

  // ============================================================
  // HISTÓRICO (serie legacy + meses calculados)
  // ============================================================
  async function renderHistorico() {
    var sec = $('tab-historico'), slug = S.slug;
    sec.innerHTML = pillsHtml() + '<p class="muted">Cargando…</p>'; bindPills(sec);
    if (!S.monthly[slug]) S.monthly[slug] = await db.getMonthlyReturns(slug);
    var list = S.monthly[slug], st = S.pmap[slug].stats || {};
    var legacy = list.filter(function (m) { return m.isLegacy; });
    var hist = E.buildHistory(legacy, list.filter(function (m) { return !m.isLegacy; }));

    var html = pillsHtml() + '<div class="card"><div class="row between"><h2>' + h(S.pmap[slug].name) + ' · histórico mensual</h2>' +
      '<div class="row"><button class="btn sec sm" data-act="recalc">Recalcular</button>' +
      (legacy.length ? '' : '<button class="btn sm" data-act="seedlegacy">Importar serie legacy del documento (' + N.SEED.legacy[slug].length + ' meses)</button>') + '</div></div>' +
      '<div class="sub">Legacy = medido en la planilla, rotación a rotación; se importa tal cual y no se recalcula. App = mes calendario, calculado por el motor. Acumulado compuesto.</div>' +
      '<div class="kpis mb">' + kpi('Acumulado ARS', E.fmtPct(hist.accumulated.ars), hist.accumulated.ars) + kpi('Acumulado USD', E.fmtPct(hist.accumulated.usd), hist.accumulated.usd) +
      hist.yearTotals.map(function (y) { return kpi(y.year + ' ARS / USD', E.fmtPct(y.ars) + ' / ' + E.fmtPct(y.usd)); }).join('') + '</div>';
    html += '<div class="tablewrap"><table><thead><tr><th>Mes</th><th class="num">ARS</th><th class="num">USD</th><th class="num">Acum. ARS</th><th class="num">Acum. USD</th><th>Origen</th><th></th></tr></thead><tbody>';
    hist.months.forEach(function (m) {
      var edit = m.isLegacy;
      html += '<tr data-ym="' + m.ym + '"><td>' + E.fmtMonthLong(m.ym) + '</td>' +
        '<td class="num">' + (edit ? '<input class="w-s" type="number" step="0.01" data-l="ars" value="' + m.ars + '">' : '<span class="' + pctClass(m.ars) + '">' + E.fmtPct(m.ars) + '</span>') + '</td>' +
        '<td class="num">' + (edit ? '<input class="w-s" type="number" step="0.01" data-l="usd" value="' + m.usd + '">' : '<span class="' + pctClass(m.usd) + '">' + E.fmtPct(m.usd) + '</span>') + '</td>' +
        '<td class="num ' + pctClass(m.accArs) + '">' + E.fmtPct(m.accArs) + '</td><td class="num ' + pctClass(m.accUsd) + '">' + E.fmtPct(m.accUsd) + '</td>' +
        '<td>' + (m.isLegacy ? '<span class="tag">legacy</span>' : m.isClosed ? '<span class="tag ok">app · cerrado</span>' : '<span class="tag warn">app · en curso' + (m.basisIsPartial ? ' desde ' + E.fmtDate(m.basisDate) : '') + '</span>') + '</td>' +
        '<td>' + (edit ? '<button class="iconbtn" data-act="dellegacy" title="Borrar">✕</button>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="row mt"><label class="f inline"><span>Agregar mes legacy</span><input type="month" id="newYm"></label>' +
      '<label class="f inline"><span>ARS %</span><input type="number" step="0.01" id="newArs" class="w-s"></label>' +
      '<label class="f inline"><span>USD %</span><input type="number" step="0.01" id="newUsd" class="w-s"></label>' +
      '<button class="btn sec sm" data-act="addlegacy">Agregar</button><span class="grow"></span>' +
      '<button class="btn" data-act="savelegacy">Guardar cambios legacy</button></div></div>';
    sec.innerHTML = html; bindPills(sec);

    sec.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      try {
        if (b.dataset.act === 'seedlegacy') {
          busy(true);
          await db.saveMonthlyReturns(slug, N.SEED.legacy[slug].map(function (r) { return { ym: r[0], ars: r[1], usd: r[2], isLegacy: true, isClosed: true }; }));
          await N.recompute(slug); await reloadPortfolio(slug); busy(false); renderHistorico(); toast('Serie legacy importada');
        } else if (b.dataset.act === 'savelegacy') {
          var rows = Array.prototype.map.call(sec.querySelectorAll('tr[data-ym] input[data-l=ars]'), function (inp) {
            var tr = inp.closest('tr'); return { ym: tr.dataset.ym, ars: num(inp.value), usd: num(tr.querySelector('input[data-l=usd]').value), isLegacy: true, isClosed: true };
          });
          busy(true); await db.saveMonthlyReturns(slug, rows); await N.recompute(slug); await reloadPortfolio(slug); busy(false); renderHistorico(); toast('Serie legacy guardada');
        } else if (b.dataset.act === 'dellegacy') {
          var ym = b.closest('tr').dataset.ym; if (!confirm('¿Borrar ' + E.fmtMonthLong(ym) + '?')) return;
          await db.deleteMonthlyReturn(slug, ym); await N.recompute(slug); await reloadPortfolio(slug); renderHistorico();
        } else if (b.dataset.act === 'addlegacy') {
          var y = $('newYm').value, a = num($('newArs').value), u = num($('newUsd').value);
          if (!/^\d{4}-\d{2}$/.test(y) || a == null || u == null) return toast('Completá mes, ARS y USD', true);
          await db.saveMonthlyReturns(slug, [{ ym: y, ars: a, usd: u, isLegacy: true, isClosed: true }]); await N.recompute(slug); await reloadPortfolio(slug); renderHistorico();
        } else if (b.dataset.act === 'recalc') {
          busy(true); await N.recompute(slug); await reloadPortfolio(slug); busy(false); renderHistorico(); toast('Recalculado');
        }
      } catch (err) { busy(false); console.error(err); toast('Error: ' + (err.message || err), true); }
    });
  }

  // ============================================================
  // CATÁLOGO
  // ============================================================
  function renderCatalogo() {
    var sec = $('tab-catalogo');
    var ins = S.editIns || { ticker: '', name: '', type: 'CEDEAR', priceSymbol: '', underlying: '', cedearRatio: '', usdBasis: 'underlying', isActive: true, order: S.instruments.length };
    var html = '<div class="grid2"><div class="card"><h2>Catálogo de instrumentos</h2><div class="sub">' + S.instruments.length + ' instrumentos. Click en una fila para editar. El ratio de CEDEAR es dato del catálogo, no se infiere.</div>' +
      '<div class="tablewrap"><table><thead><tr><th>Ticker</th><th>Nombre</th><th>Tipo</th><th>Símbolo API</th><th class="num">Ratio</th><th>Último</th><th></th></tr></thead><tbody>';
    S.instruments.forEach(function (i) {
      var now = S.book ? S.book.priceLatest(i.ticker) : null;
      html += '<tr data-tk="' + h(i.ticker) + '" style="cursor:pointer"><td><b>' + h(i.ticker) + '</b></td><td>' + h(i.name) + '</td><td>' + h(tipo(i.type)) + '</td><td>' + h(i.priceSymbol || i.ticker) + '</td>' +
        '<td class="num">' + (i.cedearRatio ? i.cedearRatio : '—') + '</td><td>' + (now ? E.fmtNum(now.price, 2) : '<span class="tag bad">sin precio</span>') + '</td>' +
        '<td>' + (i.isActive === false ? '<span class="tag">inactivo</span>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    html += '<div class="card"><h2>' + (S.editIns ? 'Editar ' + h(ins.ticker) : 'Nuevo instrumento') + '</h2>' +
      '<label class="f"><span>Ticker (BYMA)</span><input type="text" data-i="ticker" value="' + h(ins.ticker) + '"' + (S.editIns ? ' readonly' : '') + ' placeholder="Ej: GD30"></label>' +
      '<label class="f"><span>Nombre</span><input type="text" data-i="name" value="' + h(ins.name) + '"></label>' +
      '<label class="f"><span>Tipo</span><select data-i="type">' + Object.keys(N.TIPOS).map(function (t) { return '<option value="' + t + '"' + (t === ins.type ? ' selected' : '') + '>' + h(N.TIPOS[t]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Símbolo en la API de precios (si difiere del ticker; ej. YPF → YPFD)</span><input type="text" data-i="priceSymbol" value="' + h(ins.priceSymbol || '') + '"></label>' +
      '<div class="row"><label class="f grow"><span>Subyacente (CEDEAR)</span><input type="text" data-i="underlying" value="' + h(ins.underlying || '') + '"></label>' +
      '<label class="f grow"><span>Ratio CEDEAR</span><input type="number" step="0.001" data-i="cedearRatio" value="' + h(ins.cedearRatio || '') + '"></label></div>' +
      '<label class="f"><span>Cómo mostrar el valor en USD</span><select data-i="usdBasis">' +
      ['underlying|Precio del subyacente (CEDEAR/ETF)', 'parity|Paridad (bonos, ONs)', 'ccl_conversion|Conversión por CCL'].map(function (o) { var p = o.split('|'); return '<option value="' + p[0] + '"' + (p[0] === ins.usdBasis ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="check"><input type="checkbox" data-i="isActive"' + (ins.isActive !== false ? ' checked' : '') + '> Activo (se captura precio y se puede usar en rotaciones)</label>' +
      '<div class="row mt"><button class="btn" data-act="saveins">Guardar</button>' + (S.editIns ? '<button class="btn sec" data-act="newins">Nuevo</button>' : '') + '</div></div></div>';
    sec.innerHTML = html;
    sec.querySelectorAll('tr[data-tk]').forEach(function (tr) { tr.onclick = function () { S.editIns = Object.assign({}, S.insMap[tr.dataset.tk]); renderCatalogo(); }; });
    sec.querySelector('[data-act=saveins]').onclick = async function () {
      var o = {}; sec.querySelectorAll('[data-i]').forEach(function (inp) { o[inp.dataset.i] = inp.type === 'checkbox' ? inp.checked : inp.value.trim(); });
      if (!o.ticker) return toast('Falta el ticker', true);
      o.ticker = o.ticker.toUpperCase(); o.priceSymbol = (o.priceSymbol || o.ticker).toUpperCase(); o.cedearRatio = num(o.cedearRatio); o.underlying = o.underlying || null;
      if (S.editIns) o.order = S.editIns.order; else o.order = S.instruments.length;
      if (!o.name) o.name = o.ticker;
      try { await db.saveInstrument(o); S.instruments = await db.getInstruments(); S.insMap = {}; S.instruments.forEach(function (i) { S.insMap[i.ticker] = i; }); S.editIns = null; renderCatalogo(); toast('Instrumento guardado. La ingesta lo captura desde la próxima corrida.'); }
      catch (e) { toast('Error: ' + e.message, true); }
    };
    var nb = sec.querySelector('[data-act=newins]'); if (nb) nb.onclick = function () { S.editIns = null; renderCatalogo(); };
  }

  // ============================================================
  // COMITENTES
  // ============================================================
  async function renderComitentes() {
    var sec = $('tab-comitentes');
    if (!S.accounts.length) { sec.innerHTML = '<p class="muted">Cargando…</p>'; S.accounts = await db.listAccounts(); }
    var q = (S.accQ || '').toLowerCase();
    var list = S.accounts.filter(function (a) { return !q || (a.clientName || '').toLowerCase().indexOf(q) >= 0 || String(a.comitente).indexOf(q) >= 0; });
    var html = '<div class="grid2"><div class="card"><div class="row between"><h2>Comitentes autorizados</h2><span class="tag ok">' + S.accounts.length + ' cuentas</span></div>' +
      '<div class="sub">Con estas cuentas entran los clientes: ALyC + número de comitente. Un cliente con cuenta en dos ALyCs tiene dos filas.</div>' +
      '<input type="search" id="accQ" placeholder="Buscar por nombre o comitente" value="' + h(S.accQ || '') + '">' +
      '<div class="tablewrap mt"><table><thead><tr><th>ALyC</th><th>Comitente</th><th>Cliente</th><th></th></tr></thead><tbody>' +
      list.slice(0, 300).map(function (a) {
        return '<tr><td>' + h(a.alyc) + '</td><td class="tnum">' + h(a.comitente) + '</td><td>' + h(a.clientName) + (a.isActive === false ? ' <span class="tag">inactivo</span>' : '') + '</td><td><button class="iconbtn" data-del="' + h(a.id) + '" title="Borrar">✕</button></td></tr>';
      }).join('') + '</tbody></table>' + (list.length > 300 ? '<p class="muted">Se muestran 300 de ' + list.length + '. Usá el buscador.</p>' : '') + '</div></div>';
    html += '<div><div class="card"><h2>Agregar cuenta</h2><div class="row">' +
      '<label class="f"><span>ALyC</span><select id="accAlyc">' + N.ALYCS.map(function (a) { return '<option>' + a + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Comitente</span><input type="text" id="accNum" inputmode="numeric" placeholder="Ej: 123456"></label>' +
      '<label class="f grow"><span>Nombre del cliente</span><input type="text" id="accName"></label></div>' +
      '<button class="btn" id="accAdd">Agregar</button></div>';
    html += '<div class="card"><h2>Importar desde CSV</h2><div class="sub">Una cuenta por línea: <code>ALYC,COMITENTE,NOMBRE</code> (también sirve con punto y coma o tabulación, como al copiar desde Excel). Las cuentas existentes se actualizan, no se duplican.</div>' +
      '<textarea id="csvBox" class="csvbox" placeholder="IOL,123456,Juan Pérez&#10;COCOS,98765,María Gómez"></textarea>' +
      '<div class="row mt"><input type="file" id="csvFile" accept=".csv,.txt"><span class="grow"></span><button class="btn" id="csvImport">Importar</button></div><div id="csvMsg" class="mt"></div></div></div></div>';
    sec.innerHTML = html;

    $('accQ').oninput = function () { S.accQ = this.value; renderComitentes(); };
    $('accAdd').onclick = async function () {
      var a = { alyc: $('accAlyc').value, comitente: $('accNum').value, clientName: $('accName').value };
      if (!a.comitente.replace(/\D/g, '')) return toast('Falta el número de comitente', true);
      try { await db.saveAccount(a); S.accounts = await db.listAccounts(); renderComitentes(); toast('Cuenta agregada'); } catch (e) { toast('Error: ' + e.message, true); }
    };
    sec.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () { if (!confirm('¿Borrar la cuenta ' + b.dataset.del + '?')) return; await db.deleteAccount(b.dataset.del); S.accounts = await db.listAccounts(); renderComitentes(); };
    });
    $('csvFile').onchange = function () {
      var f = this.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { $('csvBox').value = r.result; }; r.readAsText(f, 'utf-8');
    };
    $('csvImport').onclick = async function () {
      var rows = parseCsv($('csvBox').value);
      if (!rows.ok.length) { $('csvMsg').innerHTML = '<div class="alert bad">No encontré filas válidas.' + (rows.bad.length ? ' Filas con problema: ' + rows.bad.length : '') + '</div>'; return; }
      if (!confirm('Importar ' + rows.ok.length + ' cuentas' + (rows.bad.length ? ' (se saltean ' + rows.bad.length + ' filas inválidas)' : '') + '. ¿Confirmás?')) return;
      busy(true);
      try { await db.importAccounts(rows.ok); S.accounts = await db.listAccounts(); busy(false); renderComitentes(); toast(rows.ok.length + ' cuentas importadas'); }
      catch (e) { busy(false); toast('Error: ' + e.message, true); }
    };
  }
  function parseCsv(text) {
    var ok = [], bad = [];
    text.split(/\r?\n/).forEach(function (line, idx) {
      var l = line.trim(); if (!l) return;
      var parts = l.split(/[;\t,]/).map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
      if (idx === 0 && /alyc|broker/i.test(parts[0]) && /comit/i.test(parts[1] || '')) return; // encabezado
      var alyc = (parts[0] || '').toUpperCase(), com = (parts[1] || '').replace(/\D/g, ''), name = parts.slice(2).join(' ').trim();
      if (N.ALYCS.indexOf(alyc) < 0 || !com) { bad.push(line); return; }
      ok.push({ alyc: alyc, comitente: com, clientName: name });
    });
    return { ok: ok, bad: bad };
  }

  // ============================================================
  // FICHAS EDUCATIVAS
  // ============================================================
  async function renderFichas() {
    var sec = $('tab-fichas');
    sec.innerHTML = '<p class="muted">Cargando…</p>';
    S.education = await db.getEducation(true);
    var c = S.editCard || { slug: '', title: '', body: '', order: S.education.length + 1, isPublished: true };
    var html = '<div class="grid2"><div class="card"><div class="row between"><h2>Fichas educativas</h2>' +
      (S.education.length ? '' : '<button class="btn sm" data-act="seededu">Cargar las ' + N.SEED.education.length + ' fichas del documento</button>') + '</div>' +
      '<div class="sub">Una por tipo de instrumento. El slug tiene que coincidir con el del catálogo (cedear, accion, bono-soberano, bono-cer, on, lecap, boncap, etf, fci).</div><ul class="verlist">' +
      S.education.map(function (x) { return '<li><a href="#" data-edit="' + h(x.slug) + '">' + h(x.title) + '</a> <small>' + h(x.slug) + (x.isPublished ? '' : ' · <span class="tag">oculta</span>') + '</small></li>'; }).join('') + '</ul></div>';
    html += '<div class="card"><h2>' + (S.editCard ? 'Editar ficha' : 'Nueva ficha') + '</h2>' +
      '<label class="f"><span>Slug</span><input type="text" data-c="slug" value="' + h(c.slug) + '"' + (S.editCard ? ' readonly' : '') + '></label>' +
      '<label class="f"><span>Título</span><input type="text" data-c="title" value="' + h(c.title) + '"></label>' +
      '<label class="f"><span>Texto (párrafos separados por línea en blanco)</span><textarea data-c="body" style="min-height:220px">' + h(c.body) + '</textarea></label>' +
      '<div class="row"><label class="f"><span>Orden</span><input type="number" data-c="order" value="' + h(c.order) + '" class="w-s"></label>' +
      '<label class="check"><input type="checkbox" data-c="isPublished"' + (c.isPublished ? ' checked' : '') + '> Publicada</label></div>' +
      '<div class="row mt"><button class="btn" data-act="savecard">Guardar</button>' + (S.editCard ? '<button class="btn sec" data-act="newcard">Nueva</button>' : '') + '</div></div></div>';
    sec.innerHTML = html;
    sec.querySelectorAll('[data-edit]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); S.editCard = S.education.filter(function (x) { return x.slug === a.dataset.edit; })[0]; renderFichas(); }; });
    sec.onclick = async function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      try {
        if (b.dataset.act === 'seededu') { busy(true); for (var i = 0; i < N.SEED.education.length; i++) await db.saveEducation(N.SEED.education[i]); busy(false); renderFichas(); toast('Fichas cargadas'); }
        else if (b.dataset.act === 'newcard') { S.editCard = null; renderFichas(); }
        else if (b.dataset.act === 'savecard') {
          var o = {}; sec.querySelectorAll('[data-c]').forEach(function (inp) { o[inp.dataset.c] = inp.type === 'checkbox' ? inp.checked : inp.value; });
          o.slug = o.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'); o.order = num(o.order) || 0;
          if (!o.slug || !o.title.trim()) return toast('Falta slug o título', true);
          await db.saveEducation(o); S.editCard = null; renderFichas(); toast('Ficha guardada');
        }
      } catch (err) { busy(false); toast('Error: ' + err.message, true); }
    };
  }

  // ============================================================
  // INGESTA (salud + cierre manual)
  // ============================================================
  async function renderIngesta() {
    var sec = $('tab-ingesta');
    sec.innerHTML = '<p class="muted">Cargando…</p>';
    await reloadQuotes(); S.health = await db.getJobHealth();
    var hz = S.health || {}, eod = hz.eod || {}, live = hz.live || {};
    var act = activeInstruments();
    var html = '<div class="grid2"><div class="card"><h2>Salud de la ingesta</h2><div class="sub">Corre en GitHub Actions: intradía cada 10 min en rueda, cierre a las 19:15 y 20:45.</div>' +
      '<table class="health"><tbody>' +
      '<tr><td>Último cierre</td><td>' + (eod.at ? fmtTs(eod.at) + ' · ' + (eod.ok ? '<span class="tag ok">ok</span>' : '<span class="tag bad">error</span>') : '—') + (eod.result && eod.result.date ? '<br><small>' + E.fmtDate(eod.result.date) + ' · ' + (eod.result.n || 0) + ' precios · ' + (eod.result.stale || 0) + ' arrastrados' + (eod.result.skipped ? ' · ' + eod.result.skipped : '') + '</small>' : '') + (eod.error ? '<br><small class="neg">' + h(eod.error) + '</small>' : '') + '</td></tr>' +
      '<tr><td>Último intradía</td><td>' + (live.at ? fmtTs(live.at) + ' · ' + (live.ok ? '<span class="tag ok">ok</span>' : '<span class="tag bad">error</span>') : '—') + (live.error ? '<br><small class="neg">' + h(live.error) + '</small>' : '') + '</td></tr>' +
      '<tr><td>Cotización intradía</td><td>' + (S.live ? E.fmtDate(S.live.date) + ' · ' + fmtTs(S.live.asOf) + ' · ' + (S.live.n || 0) + ' precios · CCL ' + E.fmtArs(S.live.fx && S.live.fx.ccl) : 'todavía no hay') + '</td></tr>' +
      '<tr><td>Sin precio hoy</td><td>' + ((S.live && S.live.missing && S.live.missing.length) ? '<span class="neg">' + S.live.missing.join(', ') + '</span>' : (S.lastEod[0] && S.lastEod[0].missing && S.lastEod[0].missing.length ? '<span class="neg">' + S.lastEod[0].missing.join(', ') + '</span>' : 'ninguno')) + '</td></tr>' +
      '</tbody></table>' +
      '<h3 class="mt">Últimos cierres</h3><div class="tablewrap"><table><thead><tr><th>Fecha</th><th class="num">Precios</th><th class="num">CCL</th><th class="num">MEP</th><th>Estado</th></tr></thead><tbody>' +
      S.lastEod.map(function (q) {
        return '<tr><td>' + E.fmtDate(q.date) + '</td><td class="num">' + (q.n || 0) + '</td><td class="num">' + (q.fx ? E.fmtNum(q.fx.ccl, 2) : '—') + '</td><td class="num">' + (q.fx ? E.fmtNum(q.fx.mep, 2) : '—') + '</td>' +
          '<td>' + (q.noTrading ? '<span class="tag">sin rueda</span>' : q.source === 'manual' ? '<span class="tag warn">manual</span>' : '<span class="tag ok">ok</span>') + (q.stale && Object.keys(q.stale).length ? ' <small>' + Object.keys(q.stale).length + ' arrastrados</small>' : '') + (q.missing && q.missing.length ? ' <small class="neg">falta ' + q.missing.join(', ') + '</small>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="muted mt">Historial de corridas: <a href="https://github.com/Norteinversiones/NorteInversiones-Portafolios/actions" target="_blank" rel="noopener">GitHub → Actions</a>.</p></div>';

    html += '<div class="card"><h2>Cargar un cierre a mano</h2><div class="sub">Para la apertura del primer mes (cierres del último día hábil del mes anterior) o para corregir un día. Se guarda como cierre oficial de esa fecha. Dejá vacío lo que no tengas.</div>' +
      '<div class="row"><label class="f"><span>Fecha</span><input type="date" id="mqDate"></label><label class="f"><span>CCL</span><input type="number" step="0.01" id="mqCcl"></label><label class="f"><span>MEP</span><input type="number" step="0.01" id="mqMep"></label></div>' +
      '<div class="tablewrap"><table><thead><tr><th>Activo</th><th class="num">Cierre ARS</th></tr></thead><tbody>' +
      act.map(function (i) { return '<tr><td><b>' + i.ticker + '</b> <small>' + h(i.name) + '</small></td><td class="num"><input class="w-m" type="number" step="0.0001" data-mq="' + i.ticker + '"></td></tr>'; }).join('') +
      '</tbody></table></div><div class="row mt"><button class="btn" id="mqSave">Guardar cierre</button></div></div></div>';
    sec.innerHTML = html;
    $('mqSave').onclick = async function () {
      var date = $('mqDate').value, ccl = num($('mqCcl').value), mep = num($('mqMep').value);
      if (!E.isValidDate(date)) return toast('Falta la fecha', true);
      if (!(ccl > 0)) return toast('Falta el CCL (se necesita para el rendimiento en dólares)', true);
      var prices = {}; sec.querySelectorAll('[data-mq]').forEach(function (inp) { var v = num(inp.value); if (v > 0) prices[inp.dataset.mq] = v; });
      if (!Object.keys(prices).length) return toast('Cargá al menos un precio', true);
      var ex = await db.getQuote(date);
      if (ex && !confirm('Ya existe un cierre para el ' + E.fmtDate(date) + (ex.source === 'manual' ? ' (manual)' : ' (automático)') + '. ¿Reemplazarlo?')) return;
      try {
        await db.saveManualQuote(date, prices, { ccl: ccl, mep: mep || null, cclVenta: ccl, mepVenta: mep || null }, S.user.email);
        busy(true); for (var i = 0; i < S.portfolios.length; i++) await N.recompute(S.portfolios[i].slug); busy(false);
        toast('Cierre del ' + E.fmtDate(date) + ' guardado (' + Object.keys(prices).length + ' precios) y rendimientos recalculados'); renderIngesta();
      } catch (e) { busy(false); toast('Error: ' + e.message, true); }
    };
  }
})();
