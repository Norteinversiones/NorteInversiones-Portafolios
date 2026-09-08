/* ============================================================
   APP CLIENTE · Norte Inversiones · Portafolios sugeridos
   Mobile-first. Ningún rendimiento se calcula acá: todo viene de engine.js
   (los resúmenes ya calculados en Firestore, o el motor en vivo para
   tenencias, rotaciones y simulador).
   ============================================================ */
(function () {
  'use strict';
  var N = window.NORTE, E = N.engine, db = N.db, C = N.charts;
  var SESSION_KEY = 'norte_sesion_v1', MONEDA_KEY = 'norte_moneda', SESSION_DAYS = 30;

  var S = {
    session: null, moneda: 'ARS', portfolios: [], pmap: {}, live: null, lastEod: [], book: null,
    instruments: [], insMap: {}, education: [], versions: {}, monthly: {}, quotes: null, quotesFrom: null,
    sim: {}, installEvt: null, loaded: false
  };

  // ---------- utilidades ----------
  function $(id) { return document.getElementById(id); }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pc(v) { return v == null ? '' : v >= 0 ? 'pos' : 'neg'; }
  function tipo(t) { return N.TIPOS[t] || t || ''; }
  function riesgo(p) { return p.riskLevel === 1 ? 'Riesgo bajo' : p.riskLevel === 3 ? 'Riesgo alto' : 'Riesgo medio'; }
  function val(obj, key) { return obj ? (S.moneda === 'USD' ? obj[key + 'Usd'] != null ? obj[key + 'Usd'] : obj.usd : obj[key + 'Ars'] != null ? obj[key + 'Ars'] : obj.ars) : null; }
  function mv(m) { return m ? (S.moneda === 'USD' ? m.usd : m.ars) : null; }
  function fmtTs(t) {
    if (!t) return null;
    var d = t.toDate ? t.toDate() : new Date(t);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function lastUpdate() {
    if (S.live && S.live.asOf) return fmtTs(S.live.asOf) + ' (intradía)';
    if (S.lastEod[0]) return 'cierre ' + E.fmtDate(S.lastEod[0].date);
    return '—';
  }
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  function setView(html, cls) { var v = $('view'); v.innerHTML = html; v.className = cls || ''; window.scrollTo(0, 0); }
  function moneySwitch() {
    return '<div class="moneda" id="monedaSw"><button class="' + (S.moneda === 'ARS' ? 'on' : '') + '" data-m="ARS">$ ARS</button><button class="' + (S.moneda === 'USD' ? 'on' : '') + '" data-m="USD">US$</button></div>';
  }
  function legalFoot() {
    return '<div class="foot"><p>Los portafolios son sugeridos y no constituyen una recomendación personalizada de inversión. Los rendimientos pasados no garantizan rendimientos futuros.</p>' +
      '<p>Las cotizaciones pueden no coincidir exactamente con las del mercado por un leve delay. Última actualización: ' + h(lastUpdate()) + '.</p>' +
      '<p>Norte Inversiones · Agente Asesor Global de Inversión registrado en CNV.</p></div>';
  }
  function delayNote() { return '<p class="legal mt">Las cotizaciones pueden no coincidir exactamente con las del mercado por un leve delay. Actualizado: ' + h(lastUpdate()) + '.</p>'; }

  // ---------- directorio de clientes (interfaz; hoy implementación local) ----------
  N.clientDirectory = {
    lookup: async function (alyc, comitente) {
      var a = await db.getAccount(alyc, comitente);
      if (!a || a.isActive === false) return null;
      return { clientId: a.id, displayName: a.clientName || '' };
    }
  };

  // ---------- sesión ----------
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (s && s.at && Date.now() - s.at < SESSION_DAYS * 86400e3) return s;
    } catch (e) { }
    return null;
  }
  function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { } }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { } }

  // ---------- datos ----------
  async function loadBase() {
    var r = await Promise.all([db.getPortfolios(), db.getLiveQuote(), db.getLastQuotes(3), db.getInstruments(), db.getEducation(false)]);
    S.portfolios = r[0].filter(function (p) { return p.name; }); S.pmap = {}; S.portfolios.forEach(function (p) { S.pmap[p.slug] = p; });
    S.live = r[1]; S.lastEod = r[2]; S.book = E.quoteBook(S.lastEod, S.live);
    S.instruments = r[3]; S.insMap = {}; S.instruments.forEach(function (i) { S.insMap[i.ticker] = i; });
    S.education = r[4]; S.loaded = true;
  }
  async function ensureVersions(slug) { if (!S.versions[slug]) S.versions[slug] = await db.getVersions(slug, false); return S.versions[slug]; }
  async function ensureMonthly(slug) { if (!S.monthly[slug]) S.monthly[slug] = await db.getMonthlyReturns(slug); return S.monthly[slug]; }
  async function ensureQuotesFrom(date) {
    if (S.quotes && S.quotesFrom <= date) return S.quotes;
    S.quotes = await db.getQuotes(date); S.quotesFrom = date; return S.quotes;
  }
  function currentVersion(slug) { var vs = S.versions[slug] || []; return vs.length ? vs[vs.length - 1] : null; }
  function historyOf(slug) {
    var list = S.monthly[slug] || [];
    return E.buildHistory(list.filter(function (m) { return m.isLegacy; }), list.filter(function (m) { return !m.isLegacy; }));
  }

  // ---------- header ----------
  function renderHeader() {
    var fx = S.live && S.live.fx ? S.live.fx : (S.lastEod[0] && S.lastEod[0].fx);
    $('hdrRight').innerHTML = (S.session ? moneySwitch() : '') +
      (fx ? '<div class="fx">CCL <b>' + E.fmtArs(fx.ccl, 0) + '</b><br>MEP <b>' + E.fmtArs(fx.mep, 0) + '</b></div>' : '');
    var sw = $('monedaSw');
    if (sw) sw.onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.moneda = b.dataset.m; try { localStorage.setItem(MONEDA_KEY, S.moneda); } catch (x) { } renderHeader(); route(); };
    $('bottomnav').classList.toggle('hidden', !S.session);
  }

  // ============================================================
  // LOGIN
  // ============================================================
  function renderLogin(msg) {
    var alyc = S.loginAlyc || N.ALYCS[0];
    setView('<div class="login card"><img class="logo-login" src="assets/logo-original.png" alt="Norte Inversiones">' +
      '<h1>Portafolios sugeridos</h1><p class="muted">Ingresá con tu cuenta comitente.</p>' +
      '<div class="alyc">' + N.ALYCS.map(function (a) { return '<button data-alyc="' + a + '" class="' + (a === alyc ? 'on' : '') + '">' + (a === 'COCOS' ? 'Cocos' : a === 'BALANZ' ? 'Balanz' : a) + '</button>'; }).join('') + '</div>' +
      '<label class="f"><span>Número de comitente</span><input type="text" id="comitente" inputmode="numeric" autocomplete="off" placeholder="Ej. 123456"></label>' +
      '<button class="btn amarillo lg" id="btnEntrar">Entrar</button>' +
      '<p class="legal mt" id="loginMsg">' + h(msg || '') + '</p>' +
      '<p class="legal">Tu número de comitente es el de tu cuenta en el bróker. Si no podés entrar, escribinos por WhatsApp.</p></div>');
    document.querySelector('.alyc').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.loginAlyc = b.dataset.alyc; document.querySelectorAll('.alyc button').forEach(function (x) { x.classList.toggle('on', x === b); }); };
    var inp = $('comitente');
    inp.onkeydown = function (e) { if (e.key === 'Enter') $('btnEntrar').click(); };
    $('btnEntrar').onclick = async function () {
      var num = inp.value.replace(/\D/g, ''), alycSel = S.loginAlyc || N.ALYCS[0];
      if (!num) { $('loginMsg').textContent = 'Escribí tu número de comitente.'; return; }
      this.disabled = true; $('loginMsg').textContent = 'Verificando…';
      try {
        var r = await N.clientDirectory.lookup(alycSel, num);
        if (!r) { $('loginMsg').textContent = 'No encontramos esa cuenta en ' + alycSel + '. Revisá el número o escribinos.'; this.disabled = false; return; }
        S.session = { alyc: alycSel, comitente: num, name: r.displayName, clientId: r.clientId, at: Date.now() };
        saveSession(S.session);
        if (!S.loaded) await loadBase();
        renderHeader(); location.hash = '#/'; route();
      } catch (e) { console.error(e); $('loginMsg').textContent = 'No se pudo verificar. Probá de nuevo en un momento.'; this.disabled = false; }
    };
    setTimeout(function () { inp.focus(); }, 50);
  }

  // ============================================================
  // HOME
  // ============================================================
  function renderHome() {
    var cards = S.portfolios.map(function (p) {
      var st = p.stats || {}, cur = st.current;
      var mes = cur ? (S.moneda === 'USD' ? cur.usd : cur.ars) : null;
      var acc = st.accArs != null ? (S.moneda === 'USD' ? st.accUsd : st.accArs) : null;
      var desde = st.firstAppMonth && st.monthsCount ? null : null;
      var firstYm = null;
      return '<a class="pcard r' + (p.riskLevel || 2) + '" href="#/p/' + p.slug + '"><div class="head"><h2>' + h(p.name) + '</h2><span class="risk">' + riesgo(p) + '</span></div>' +
        '<div class="desc">' + h(p.description || '') + '</div>' +
        '<div class="nums"><div class="n"><div class="l">' + (cur ? E.fmtMonthLong(cur.ym) : 'Mes en curso') + '</div><div class="v ' + pc(mes) + '">' + E.fmtPct(mes) + '</div><div class="s">' + (cur && cur.basisIsPartial ? 'desde el ' + E.fmtDate(cur.basisDate) : cur && cur.isLive ? 'en vivo' : cur ? 'al ' + E.fmtDate(cur.endDate) : 'sin datos') + '</div></div>' +
        '<div class="n"><div class="l">Acumulado</div><div class="v ' + pc(acc) + '">' + E.fmtPct(acc) + '</div><div class="s">' + (p.inceptionDate ? 'desde ' + E.fmtMonth(p.inceptionDate.slice(0, 7)) : '') + (st.monthsCount ? ' · ' + st.monthsCount + ' meses' : '') + '</div></div></div>' +
        '<span class="more">Ver portafolio ›</span></a>';
    }).join('');
    var install = S.installEvt ? '<div class="installtip"><b>Instalá la app en tu teléfono</b> para tenerla a mano. <button class="btn sm amarillo" id="btnInstall">Instalar</button></div>'
      : isIos() && !isStandalone() ? '<div class="installtip"><b>Para instalarla en tu iPhone:</b> tocá el botón Compartir de Safari y elegí "Agregar a inicio".</div>' : '';
    setView('<h1>Hola' + (S.session && S.session.name ? ', ' + h(S.session.name.split(' ')[0]) : '') + '</h1><p class="muted">Tres portafolios sugeridos, actualizados todos los meses. Valores en ' + (S.moneda === 'USD' ? 'dólares (CCL)' : 'pesos') + '.</p>' +
      '<div class="pcards">' + cards + '</div>' +
      '<p><a class="btn sec" href="#/comparar">Comparar los tres</a> <a class="btn sec" href="#/aprender">Entender los instrumentos</a></p>' + install + legalFoot());
    var bi = $('btnInstall'); if (bi) bi.onclick = async function () { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; renderHome(); };
  }
  function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }

  // ============================================================
  // DETALLE
  // ============================================================
  async function renderDetail(slug, tab) {
    var p = S.pmap[slug]; if (!p) { location.hash = '#/'; return; }
    tab = tab || 'tenencias';
    setView('<p class="muted center">Cargando ' + h(p.name) + '…</p>');
    await Promise.all([ensureVersions(slug), ensureMonthly(slug)]);
    var cur = currentVersion(slug), st = p.stats || {}, curM = st.current;
    var mes = curM ? mv(curM) : null, acc = st.accArs != null ? (S.moneda === 'USD' ? st.accUsd : st.accArs) : null;
    var hero = '<div class="hero"><div class="row between"><div><h1>' + h(p.name) + '</h1><div class="sub">' + riesgo(p) + (cur ? ' · rotación del ' + E.fmtDate(cur.effectiveFrom) : '') + '</div></div>' +
      (cur ? '<div class="right"><div class="sub">Beta</div><b class="yellow">' + E.fmtNum(E.betaPortfolio(cur.holdings), 2) + '</b></div>' : '') + '</div>' +
      '<div class="big ' + pc(mes) + '">' + E.fmtPct(mes) + ' <small>' + (curM ? E.fmtMonthLong(curM.ym) + (curM.basisIsPartial ? ', desde el ' + E.fmtDate(curM.basisDate) : '') : 'mes en curso') + '</small></div>' +
      '<div class="row2"><span>Acumulado <b class="' + pc(acc) + '">' + E.fmtPct(acc) + '</b></span>' + (p.inceptionDate ? '<span class="muted">desde ' + E.fmtMonth(p.inceptionDate.slice(0, 7)) + '</span>' : '') + '</div></div>';
    var tabs = ['tenencias|Tenencias', 'historico|Histórico', 'rotaciones|Rotaciones', 'simulador|Simulador'].map(function (t) { var x = t.split('|'); return '<a href="#/p/' + slug + '/' + x[0] + '" class="' + (tab === x[0] ? 'on' : '') + '">' + x[1] + '</a>'; }).join('');
    var body = '';
    if (tab === 'tenencias') body = tenenciasHtml(slug, cur);
    else if (tab === 'historico') body = historicoHtml(slug);
    else if (tab === 'rotaciones') body = await rotacionesHtml(slug);
    else if (tab === 'simulador') body = simuladorHtml(slug);
    setView('<a href="#/" class="legal">‹ Inicio</a>' + hero + '<div class="subtabs">' + tabs + '</div>' + body + legalFoot());
    bindDetail(slug, tab);
    if (tab === 'simulador' && S.sim[slug]) applySim(slug);
  }

  function tenenciasHtml(slug, cur) {
    if (!cur) return '<div class="card"><p>Este portafolio todavía no tiene una composición publicada.</p></div>';
    var hs = E.holdingsLive(cur, S.book);
    var rows = hs.map(function (x) {
      var ins = S.insMap[x.ticker] || {};
      var buy = S.moneda === 'USD' ? E.fmtUsd(x.buyUsd) : E.fmtArs(x.buyArs), now = S.moneda === 'USD' ? E.fmtUsd(x.nowUsd) : E.fmtArs(x.nowArs);
      var v = S.moneda === 'USD' ? x.varUsd : x.varArs;
      return '<div class="holding"><div class="hl"><div class="tk">' + h(x.ticker) + (ins.type ? '<span class="tipo" data-ficha="' + h(ins.educationSlug || ins.type.toLowerCase().replace('_', '-')) + '">' + h(tipo(ins.type)) + '</span>' : '') + '</div><div class="nm">' + h(ins.name || '') + '</div>' +
        '<div class="px"><span class="l">Precio de compra</span><b>' + buy + '</b></div>' +
        '<div class="px"><span class="l">Precio actual</span><b>' + now + '</b>' + (x.stale ? ' <span class="stale">al ' + E.fmtDate(x.asOf) + '</span>' : '') + '</div></div>' +
        '<div class="hc"><div class="l">Tenencia</div><div class="v">' + E.fmtNum(x.weightPct, 0) + '%</div></div>' +
        '<div class="hc"><div class="l">Resultado</div><div class="v ' + pc(v) + '">' + E.fmtPct(v) + '</div></div></div>';
    }).join('');
    var comp = E.compositionByType(cur.holdings, S.insMap).map(function (c) { return { label: tipo(c.type), value: c.weightPct }; });
    return '<div class="card"><h3>Composición</h3>' + C.donut({ slices: comp }) + '</div>' +
      '<div class="card"><h3>Activos</h3><p class="legal">Variación de cada activo desde su precio de compra, en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + '. Tocá el tipo de instrumento para saber qué es.</p>' + rows + delayNote() + '</div>' +
      (cur.rationale ? '<div class="card"><h3>Por qué esta composición</h3><p>' + h(cur.rationale).replace(/\n/g, '<br>') + '</p></div>' : '');
  }

  function historicoHtml(slug) {
    var hist = historyOf(slug);
    if (!hist.months.length) return '<div class="card"><p>Todavía no hay meses cerrados.</p></div>';
    var items = hist.months.map(function (m) { return { label: E.fmtMonth(m.ym), title: E.fmtMonthLong(m.ym), value: mv(m), legacy: m.isLegacy, current: !m.isClosed }; });
    var acc = hist.months.map(function (m) { return S.moneda === 'USD' ? m.accUsd : m.accArs; });
    var split = -1; hist.months.forEach(function (m, i) { if (split < 0 && !m.isLegacy && i > 0) split = i; });
    var years = {}; hist.months.forEach(function (m) { (years[m.ym.slice(0, 4)] = years[m.ym.slice(0, 4)] || {})[Number(m.ym.slice(5, 7))] = m; });
    var yt = {}; hist.yearTotals.forEach(function (y) { yt[y.year] = y; });
    var MES = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    var table = '<div class="tablewrap"><table class="ymtable"><thead><tr><th>Año</th>' + MES.map(function (m) { return '<th class="num">' + m + '</th>'; }).join('') + '<th class="num">Año</th></tr></thead><tbody>' +
      Object.keys(years).sort().map(function (y) {
        return '<tr><td><b>' + y + '</b></td>' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (mi) {
          var m = years[y][mi]; if (!m) return '<td class="num muted">·</td>';
          var v = mv(m); return '<td class="num ' + pc(v) + (m.isLegacy ? ' leg' : '') + '" title="' + E.fmtMonthLong(m.ym) + '">' + E.fmtNum(v, 1).replace('−', '-') + '</td>';
        }).join('') + '<td class="num"><b class="' + pc(mv(yt[y])) + '">' + E.fmtPct(mv(yt[y]), 1) + '</b></td></tr>';
      }).join('') + '</tbody></table></div>';
    return '<div class="card"><h3>Rendimiento mensual</h3><p class="legal">' + (hist.firstAppMonth ? 'Las barras atenuadas son el histórico previo a la app (medido rotación a rotación en nuestra planilla). Desde ' + E.fmtMonthLong(hist.firstAppMonth) + ' la app mide por mes calendario.' : 'Histórico previo a la app, medido rotación a rotación.') + '</p>' + C.bars({ items: items }) + '</div>' +
      '<div class="card"><h3>Acumulado compuesto</h3><div class="kpis mb"><div class="kpi"><div class="l">Total</div><div class="v ' + pc(mv(hist.accumulated)) + '">' + E.fmtPct(mv(hist.accumulated)) + '</div></div>' +
      hist.yearTotals.map(function (y) { return '<div class="kpi"><div class="l">' + y.year + '</div><div class="v ' + pc(mv(y)) + '">' + E.fmtPct(mv(y))+ '</div></div>'; }).join('') + '</div>' +
      C.lines({ series: [{ name: S.pmap[slug].name, points: acc }], labels: hist.months.map(function (m) { return E.fmtMonth(m.ym); }), splitAt: split }) + '</div>' +
      '<div class="card"><h3>Mes a mes</h3><p class="legal">En %. Los valores atenuados son del histórico previo a la app.</p>' + table + '</div>';
  }

  async function rotacionesHtml(slug) {
    var vs = S.versions[slug] || [];
    if (!vs.length) return '<div class="card"><p>Todavía no hay rotaciones publicadas.</p></div>';
    var from = E.addDays(E.monthStart(E.monthOf(vs[0].effectiveFrom)), -10);
    var quotes = await ensureQuotesFrom(from);
    var book = E.quoteBook(quotes, S.live);
    var segs = E.computeSegments(vs, book, {});
    var evs = vs.slice().reverse().map(function (v, idx) {
      var ss = segs.filter(function (s) { return s.versionId === v.id; });
      var r = ss.length ? { ars: E.chain(ss.map(function (s) { return s.returnArs; })), usd: E.chain(ss.map(function (s) { return s.returnUsd; })) } : null;
      var desde = ss.length ? ss[0].basisDate : null, hasta = ss.length ? ss[ss.length - 1].endDate : null;
      var hs = v.holdings.map(function (x) { var ins = S.insMap[x.ticker] || {}; return '<tr><td><b>' + h(x.ticker) + '</b> <small>' + h(tipo(ins.type)) + '</small></td><td class="num">' + E.fmtNum(x.weightPct, 0) + '%</td><td class="num">' + E.fmtArs(x.buyPriceArs) + '</td></tr>'; }).join('');
      return '<details class="ev" ' + (idx === 0 ? 'open' : '') + '><summary>' + E.fmtDate(v.effectiveFrom) + (v.effectiveTo ? ' → ' + E.fmtDate(v.effectiveTo) : ' → hoy') + (r ? ' <span class="' + pc(mv(r)) + '">' + E.fmtPct(mv(r), 1) + '</span>' : '') + '</summary>' +
        '<div class="meta">' + v.holdings.length + ' activos · beta ' + E.fmtNum(E.betaPortfolio(v.holdings), 2) + (r ? ' · rendimiento del período en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + ' (' + E.fmtDate(desde) + ' al ' + E.fmtDate(hasta) + ')' : ' · sin precios para medir este período') + '</div>' +
        (v.rationale ? '<p class="mt">' + h(v.rationale).replace(/\n/g, '<br>') + '</p>' : '') +
        '<div class="tablewrap"><table><thead><tr><th>Activo</th><th class="num">%</th><th class="num">Compra</th></tr></thead><tbody>' + hs + '</tbody></table></div></details>';
    }).join('');
    return '<div class="card"><h3>Línea de tiempo de rotaciones</h3><p class="legal">Cada rotación es un cambio de composición. Se muestra qué tenía el portafolio y cuánto rindió mientras estuvo vigente.</p><div class="tl">' + evs + '</div></div>';
  }

  function simuladorHtml(slug) {
    var vs = S.versions[slug] || [];
    var min = E.minSimulationDate(vs, S.book) || S.book.firstDate, max = S.book.latestDate;
    return '<div class="card"><h3>¿Qué hubiera rendido, estimado, si comprabas el…?</h3>' +
      '<p class="legal">Elegí una fecha y todos los números se recalculan desde ese día hasta la última cotización, siguiendo la estrategia con todas las rotaciones que hubo en el medio.</p>' +
      '<div class="row"><input type="date" id="simDate" min="' + h(min || '') + '" max="' + h(max || '') + '" value="' + h((S.sim[slug] && S.sim[slug].from) || '') + '" style="max-width:220px"><button class="btn amarillo" id="simGo">Calcular</button></div>' +
      '<p class="legal">Fecha mínima: ' + E.fmtDate(min) + ', que es cuando empezamos a guardar precios diarios.</p>' +
      '<div id="simOut"></div>' +
      '<p class="legal mt">Rendimiento estimado de la estrategia desde esa fecha. No contempla comisiones ni impuestos y puede diferir del resultado real de tu cartera.</p></div>';
  }
  async function runSim(slug, from) {
    var vs = S.versions[slug] || [];
    var out = $('simOut'); out.innerHTML = '<p class="muted">Calculando…</p>';
    var quotes = await ensureQuotesFrom(E.addDays(from, -12));
    var book = E.quoteBook(quotes, S.live);
    var r = E.simulate(vs, book, from, {});
    S.sim[slug] = { from: from, result: r };
    applySim(slug);
  }
  function applySim(slug) {
    var sim = S.sim[slug]; if (!sim || !$('simOut')) return;
    var r = sim.result;
    document.body.classList.add('simulando');
    var banner = $('simBanner'); if (!banner) { banner = document.createElement('div'); banner.id = 'simBanner'; banner.className = 'simbanner'; $('view').insertBefore(banner, $('view').firstChild.nextSibling); }
    banner.innerHTML = '<b>Estás viendo un escenario simulado</b><br><small>Compra estimada el ' + E.fmtDate(sim.from) + '. Los números de esta pantalla no son los datos reales.</small><br><button class="btn sm" id="simBack">Volver a la actualidad</button>';
    $('simBack').onclick = function () { delete S.sim[slug]; document.body.classList.remove('simulando'); route(); };
    if (!r.segments.length) { $('simOut').innerHTML = '<p class="alert warn">No hay precios suficientes para esa fecha.</p>'; return; }
    var v = mv(r.accumulated);
    $('simOut').innerHTML = '<div class="simresult"><div class="big ' + pc(v) + '">' + E.fmtPct(v, 1) + '</div><div class="l">estimado en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + ' del ' + E.fmtDate(r.basisDate) + ' al ' + E.fmtDate(r.endDate) + (r.rotations ? ' · ' + r.rotations + ' rotación' + (r.rotations > 1 ? 'es' : '') + ' en el medio' : '') + '</div></div>' +
      (r.months.length > 1 ? '<div class="tablewrap"><table class="ymtable"><thead><tr><th>Mes</th><th class="num">Estimado</th></tr></thead><tbody>' + r.months.map(function (m) { return '<tr><td>' + E.fmtMonthLong(m.ym) + '</td><td class="num ' + pc(mv(m)) + '">' + E.fmtPct(mv(m), 1) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '');
    var d = $('simDate'); if (d) d.value = sim.from;
  }

  function bindDetail(slug, tab) {
    document.querySelectorAll('[data-ficha]').forEach(function (el) { el.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openFicha(el.dataset.ficha); }; });
    if (tab === 'simulador') {
      $('simGo').onclick = function () { var d = $('simDate').value; if (!E.isValidDate(d)) return toast('Elegí una fecha'); runSim(slug, d); };
      $('simDate').onchange = function () { if (E.isValidDate(this.value)) runSim(slug, this.value); };
    } else if (S.sim[slug]) { delete S.sim[slug]; document.body.classList.remove('simulando'); }
  }

  // ============================================================
  // COMPARAR
  // ============================================================
  async function renderComparar() {
    setView('<p class="muted center">Cargando…</p>');
    await Promise.all(S.portfolios.map(function (p) { return ensureMonthly(p.slug); }));
    var hists = {}; S.portfolios.forEach(function (p) { hists[p.slug] = historyOf(p.slug); });
    var yms = {}; S.portfolios.forEach(function (p) { hists[p.slug].months.forEach(function (m) { yms[m.ym] = 1; }); });
    var labels = Object.keys(yms).sort();
    var colors = ['#111111', '#8A8A8A', '#FFD600'];
    var series = S.portfolios.map(function (p, i) {
      var map = {}; hists[p.slug].months.forEach(function (m) { map[m.ym] = S.moneda === 'USD' ? m.accUsd : m.accArs; });
      return { name: p.name, color: colors[i % 3], points: labels.map(function (l) { return map[l] != null ? map[l] : null; }) };
    });
    var rows = S.portfolios.map(function (p, i) {
      var hst = hists[p.slug], st = p.stats || {}, cur = st.current;
      var y = hst.yearTotals[hst.yearTotals.length - 1];
      return '<tr><td><b style="border-left:4px solid ' + colors[i % 3] + ';padding-left:8px">' + h(p.name) + '</b></td><td class="num ' + pc(cur ? mv(cur) : null) + '">' + E.fmtPct(cur ? mv(cur) : null, 1) + '</td><td class="num ' + pc(y ? mv(y) : null) + '">' + E.fmtPct(y ? mv(y) : null, 1) + '</td><td class="num ' + pc(mv(hst.accumulated)) + '"><b>' + E.fmtPct(mv(hst.accumulated), 1) + '</b></td></tr>';
    }).join('');
    var y0 = hists[S.portfolios[0].slug].yearTotals.slice(-1)[0];
    setView('<h1>Comparar</h1><p class="muted">Acumulado compuesto de los tres portafolios en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + '.</p>' +
      '<div class="card"><div class="comparar-legend">' + S.portfolios.map(function (p, i) { return '<span style="--c:' + colors[i % 3] + '">' + h(p.name) + '</span>'; }).join('') + '</div>' + C.lines({ series: series, labels: labels.map(E.fmtMonth) }) + '</div>' +
      '<div class="card"><div class="tablewrap"><table><thead><tr><th>Portafolio</th><th class="num">Mes en curso</th><th class="num">' + (y0 ? y0.year : 'Año') + '</th><th class="num">Acumulado</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="legal mt">Cada portafolio arrancó en una fecha distinta; el acumulado no es comparable de punta a punta.</p></div>' + legalFoot());
  }

  // ============================================================
  // APRENDER (fichas)
  // ============================================================
  function renderAprender(slug) {
    if (slug) {
      var c = S.education.filter(function (x) { return x.slug === slug; })[0];
      if (!c) { location.hash = '#/aprender'; return; }
      setView('<a href="#/aprender" class="legal">‹ Todas las fichas</a><div class="card ficha-body"><h1>' + h(c.title) + '</h1>' + (c.body || '').split(/\n\s*\n/).map(function (p) { return '<p>' + h(p).replace(/\n/g, '<br>') + '</p>'; }).join('') + '</div>' + legalFoot());
      return;
    }
    setView('<h1>Entender los instrumentos</h1><p class="muted">Explicaciones cortas, sin jerga, de cada tipo de activo que usamos.</p>' +
      (S.education.length ? S.education.map(function (c) { return '<a class="ficha" href="#/aprender/' + h(c.slug) + '">' + h(c.title) + '</a>'; }).join('') : '<div class="card"><p>Muy pronto.</p></div>') + legalFoot());
  }
  function openFicha(slug) {
    var c = S.education.filter(function (x) { return x.slug === slug; })[0];
    if (!c) { location.hash = '#/aprender'; return; }
    var m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="box" style="position:relative"><button class="iconbtn close" aria-label="Cerrar">✕</button><h3>' + h(c.title) + '</h3><div class="ficha-body">' + (c.body || '').split(/\n\s*\n/).map(function (p) { return '<p>' + h(p).replace(/\n/g, '<br>') + '</p>'; }).join('') + '</div></div>';
    m.onclick = function (e) { if (e.target === m || e.target.closest('.close')) m.remove(); };
    document.body.appendChild(m);
  }

  // ============================================================
  // ROUTER
  // ============================================================
  function route() {
    if (!S.session) { renderLogin(); return; }
    var parts = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
    var top = parts[0] || '';
    document.querySelectorAll('.bottomnav a').forEach(function (a) { a.classList.toggle('on', a.dataset.nav === (top === 'p' ? '' : top)); });
    if (!top) renderHome();
    else if (top === 'p') renderDetail(parts[1], parts[2]);
    else if (top === 'comparar') renderComparar();
    else if (top === 'aprender') renderAprender(parts[1]);
    else if (top === 'salir') { clearSession(); S.session = null; location.hash = '#/'; renderHeader(); renderLogin('Cerraste la sesión.'); }
    else renderHome();
  }

  // ---------- arranque ----------
  (async function init() {
    try { S.moneda = localStorage.getItem(MONEDA_KEY) === 'USD' ? 'USD' : 'ARS'; } catch (e) { }
    db.init();
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); S.installEvt = e; if (S.session && !location.hash.replace('#/', '')) renderHome(); });
    window.addEventListener('hashchange', route);
    S.session = loadSession();
    if (S.session) {
      try { await loadBase(); } catch (e) { console.error(e); setView('<div class="card"><p>No se pudieron cargar los datos. Revisá tu conexión y recargá.</p></div>'); return; }
    }
    renderHeader(); route();
    if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  })();
})();
