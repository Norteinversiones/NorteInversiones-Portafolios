/* ============================================================
   APP CLIENTE · Norte Inversiones · Portafolios sugeridos
   Mobile-first. Ningún rendimiento se calcula acá: todo viene de engine.js
   (los resúmenes ya calculados en Firestore, o el motor en vivo para
   tenencias, rotaciones y simulador).
   ============================================================ */
(function () {
  'use strict';
  var N = window.NORTE, E = N.engine, db = N.db, C = N.charts;

  // Autocorrección: si el navegador sirvió un motor (engine.js) de una versión anterior,
  // se limpia la caché de la app y se recarga UNA vez. Evita errores tipo "E.xxx is not a function".
  if (typeof E.paymentsOf !== 'function') {
    var YA = 'norte_recarga_motor';
    var ya = false; try { ya = sessionStorage.getItem(YA) === '1'; sessionStorage.setItem(YA, '1'); } catch (x) { }
    if (!ya) {
      var limpiar = [];
      if (window.caches) limpiar.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
      if (navigator.serviceWorker) limpiar.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
      Promise.all(limpiar).catch(function () { }).then(function () { location.reload(); });
      return;
    }
  }
  var SESSION_KEY = 'norte_sesion_v1', MONEDA_KEY = 'norte_moneda', SESSION_DAYS = 30;

  var S = {
    session: null, moneda: 'ARS', portfolios: [], pmap: {}, live: null, lastEod: [], book: null,
    instruments: [], insMap: {}, education: [], versions: {}, monthly: {}, quotes: null, quotesFrom: null,
    sim: {}, installEvt: null, loaded: false, pushCfg: null, push: null
  };

  // ---------- utilidades ----------
  function $(id) { return document.getElementById(id); }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pc(v) { return v == null ? '' : v >= 0 ? 'pos' : 'neg'; }
  function tipo(t) { return N.TIPOS[t] || t || ''; }
  function riesgo(p) { return p.riskLevel === 1 ? 'Riesgo bajo' : p.riskLevel === 3 ? 'Riesgo alto' : 'Riesgo medio'; }
  function val(obj, key) { return obj ? (S.moneda === 'USD' ? obj[key + 'Usd'] != null ? obj[key + 'Usd'] : obj.usd : obj[key + 'Ars'] != null ? obj[key + 'Ars'] : obj.ars) : null; }
  function mv(m) { return m ? (S.moneda === 'USD' ? m.usd : m.ars) : null; }
  // Parte del rendimiento que viene de cobros de cupón / amortización (0 si no hubo).
  function cup(m) { var v = m ? (S.moneda === 'USD' ? m.couponUsd : m.couponArs) : 0; return v > 0.004 ? v : 0; }
  function cupNota(m, cls) { var v = cup(m); return v ? '<div class="' + (cls || 'cupon') + '">incluye ' + E.fmtPct(v) + ' por cobro de cupones</div>' : ''; }
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
      '<p>Norte Inversiones · Agente Productor · Matrícula N.° 2060 (CNV).</p>' +
      '<div class="social"><a href="https://x.com/NorteInversion" target="_blank" rel="noopener" aria-label="Norte Inversiones en X">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-7.4 8.5L23 22h-6.8l-5.3-6.9L4.8 22H1.6l7.9-9.1L1 2h7l4.8 6.3L18.9 2zm-1.2 18h1.9L7.4 3.9H5.4L17.7 20z"/></svg>X</a>' +
      '<a href="https://www.instagram.com/norteinversiones/" target="_blank" rel="noopener" aria-label="Norte Inversiones en Instagram">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2.2c3.2 0 3.6 0 4.8.1 1.2.1 1.8.2 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.2.4.4 1 .4 2.2.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 1.2-.2 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.2-1 .4-2.2.4-1.3.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-1.2-.1-1.8-.2-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8c.1-1.2.2-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2zm0 1.8c-3.1 0-3.5 0-4.7.1-1.1 0-1.7.2-2.1.4-.5.2-.9.4-1.2.8-.4.4-.6.7-.8 1.2-.2.4-.3 1-.4 2.1C2.8 9.7 2.8 10 2.8 12s0 3.5.1 4.7c0 1.1.2 1.7.4 2.1.2.5.4.9.8 1.2.4.4.7.6 1.2.8.4.2 1 .3 2.1.4 1.2.1 1.6.1 4.7.1s3.5 0 4.7-.1c1.1 0 1.7-.2 2.1-.4.5-.2.9-.4 1.2-.8.4-.4.6-.7.8-1.2.2-.4.3-1 .4-2.1.1-1.2.1-1.6.1-4.7s0-3.5-.1-4.7c0-1.1-.2-1.7-.4-2.1-.2-.5-.4-.9-.8-1.2-.4-.4-.7-.6-1.2-.8-.4-.2-1-.3-2.1-.4C15.5 4 15.1 4 12 4zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 1.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zm5.2-3.1a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"/></svg>Instagram</a></div></div>';
  }
  function delayNote() { return '<p class="legal mt">Las cotizaciones pueden no coincidir exactamente con las del mercado por un leve delay. Actualizado: ' + h(lastUpdate()) + '.</p>'; }

  // ---------- qué cambió entre dos composiciones ----------
  function pw(v) { return E.fmtNum(v, Math.abs(v - Math.round(v)) < 1e-9 ? 0 : 1) + '%'; }
  function cambiosHtml(prev, cur) {
    if (!prev) return '<p class="legal">Composición inicial del portafolio.</p>';
    var d = E.diffHoldings(prev, cur);
    if (!d.changed) return '<p class="legal">Misma composición que la rotación anterior.</p>';
    function fila(cls, txt, x, det) { var ins = S.insMap[x.ticker] || {}; return '<div class="chg"><span class="ct ' + cls + '">' + txt + '</span><b>' + h(x.ticker) + '</b><span class="cn">' + h(ins.name || '') + '</span><span class="cp">' + det + '</span></div>'; }
    return '<div class="chgs">' +
      d.in.map(function (x) { return fila('in', 'Entra', x, pw(x.to)); }).join('') +
      d.out.map(function (x) { return fila('out', 'Sale', x, pw(x.from)); }).join('') +
      d.up.map(function (x) { return fila('up', '↑ Sube', x, pw(x.from) + ' → ' + pw(x.to)); }).join('') +
      d.down.map(function (x) { return fila('down', '↓ Baja', x, pw(x.from) + ' → ' + pw(x.to)); }).join('') + '</div>';
  }

  // ---------- cobros de cupón / amortización ----------
  // pays: [{ ticker, date, pctArs, pctUsd, kind }] · muestra cuánto aportó cada uno al portafolio.
  function cobrosHtml(pays) {
    return '<div class="chgs">' + (pays || []).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (p) {
      var ins = S.insMap[p.ticker] || {}, v = S.moneda === 'USD' ? p.pctUsd : p.pctArs;
      return '<div class="chg"><span class="ct up">' + E.fmtDate(p.date).slice(0, 5) + '</span><b>' + h(p.ticker) + '</b><span class="cn">' + h(p.kind) + (ins.name ? ' · ' + h(ins.name) : '') + '</span><span class="cp pos">' + E.fmtPct(v) + '</span></div>';
    }).join('') + '</div>';
  }

  // ---------- calculadora por monto ----------
  var MONTO_KEY = 'norte_monto', ROT_VISTA_KEY = 'norte_rot_vista';
  var RENTA_FIJA = { BONO_SOBERANO: 1, BONO_CER: 1, ON: 1, LECAP: 1, BONCAP: 1 };
  function montoGuardado() { try { return Number(localStorage.getItem(MONTO_KEY)) || 0; } catch (e) { return 0; } }
  function calcHtml(cur, monto) {
    if (!(monto > 0)) return '<p class="legal">Escribí un monto para ver cuánto correspondería a cada activo.</p>';
    var fx = S.live && S.live.fx ? S.live.fx : (S.lastEod[0] && S.lastEod[0].fx);
    var enUsd = S.moneda === 'USD', ccl = fx && fx.ccl;
    if (enUsd && !(ccl > 0)) return '<p class="legal">No hay cotización del dólar para convertir el monto.</p>';
    var montoArs = enUsd ? monto * ccl : monto, usado = 0;
    var rows = E.holdingsLive(cur, S.book).map(function (x) {
      var ins = S.insMap[x.ticker] || {}, parte = montoArs * x.weightPct / 100, cant = '—';
      if (x.nowArs > 0 && ins.type !== 'FCI') {
        if (RENTA_FIJA[ins.type]) { var vn = Math.floor(parte / x.nowArs * 100); cant = E.fmtNum(vn, 0) + ' <small>nominales</small>'; usado += vn * x.nowArs / 100; }
        else { var n = Math.floor(parte / x.nowArs); cant = E.fmtNum(n, 0) + ' <small>' + (n === 1 ? 'unidad' : 'unidades') + '</small>'; usado += n * x.nowArs; }
      } else usado += parte;
      return '<tr><td><b>' + h(x.ticker) + '</b> <small>' + E.fmtNum(x.weightPct, 0) + '%</small></td><td class="num">' + (enUsd ? E.fmtUsd(parte / ccl, 0) : E.fmtArs(parte, 0)) + '</td><td class="num">' + cant + '</td></tr>';
    }).join('');
    var sobra = Math.max(0, montoArs - usado);
    return '<div class="tablewrap"><table class="calc"><thead><tr><th>Activo</th><th class="num">Monto</th><th class="num">Cantidad aprox.</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="legal mt">Quedaría sin invertir aprox. ' + (enUsd ? E.fmtUsd(sobra / ccl, 0) : E.fmtArs(sobra, 0)) + ' por el redondeo a unidades enteras.' + (enUsd ? ' Monto convertido a pesos al CCL de ' + E.fmtArs(ccl, 0) + '.' : '') + '</p>';
  }

  // ---------- directorio de clientes (interfaz; hoy implementación local) ----------
  N.clientDirectory = {
    lookup: async function (alyc, comitente) {
      var a = await db.getAccount(alyc, comitente);
      if (!a || a.isActive === false) return null;
      // El saludo lo define el gestor de clientes (campo "Cómo saludarlo"); si falta, el nombre.
      return { clientId: a.clientId || a.id, displayName: a.greeting || '' };
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
  // ---- ahorro de lecturas de Firestore ----
  // Los datos base (portafolios, precios, catálogo, ajustes de avisos) se guardan unos minutos en el
  // navegador: reabrir o recargar la app dentro de ese plazo no le pide nada a la base.
  // En horario de mercado los precios cambian cada 10 minutos (plazo corto); fuera de horario casi no cambian.
  var BASE_KEY = 'norte_base_v1';
  function enHorarioMercado() {
    var d = new Date(Date.now() - 3 * 3600e3), dow = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return dow >= 1 && dow <= 5 && m >= 10 * 60 + 25 && m <= 21 * 60;   // 10:25 a 21:00 ART (incluye los cierres de las 19:15 y 20:45)
  }
  function baseTtl() { return enHorarioMercado() ? 3 * 60e3 : 15 * 60e3; }
  async function loadBase() {
    // Si la app se abrió tocando una notificación (?aviso=...), se piden datos frescos sí o sí.
    var desdeAviso = /[?&]aviso=/.test(location.search);
    if (desdeAviso) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { } }
    var c = desdeAviso ? null : db.cache.get(BASE_KEY), r;
    if (c && c.r && Date.now() - c.at < baseTtl() && c.who === S.session.alyc + '_' + S.session.comitente) r = c.r;
    else {
      // 5 consultas: portafolios (traen su histórico adentro), intradía, últimos 3 cierres, catálogo
      // (1 documento) y ajustes de avisos. Las fichas educativas están desactivadas: no se piden.
      r = db.cache.plano(await Promise.all([db.getPortfolios(), db.getLiveQuote(), db.getLastQuotes(3), db.getCatalog(), db.getPushConfig().catch(function () { return null; })]));
      db.cache.set(BASE_KEY, { at: Date.now(), who: S.session.alyc + '_' + S.session.comitente, r: r });
    }
    S.portfolios = r[0].filter(function (p) { return p.name; }); S.pmap = {}; S.portfolios.forEach(function (p) { S.pmap[p.slug] = p; });
    S.instruments = r[3].items; S.quotesRev = r[3].quotesRev || 0; S.insMap = {}; S.instruments.forEach(function (i) { S.insMap[i.ticker] = i; });
    S.pays = E.paymentsOf(S.instruments); // cobros de cupón / amortización cargados en el catálogo
    S.live = r[1]; S.lastEod = r[2]; S.book = E.quoteBook(S.lastEod, S.live, S.pays);
    S.pushCfg = r[4];
    S.education = []; S.versions = {}; S.monthly = {}; S.loaded = true;
    pushInit(); // en segundo plano: no frena la carga
  }
  // Versiones: quedan guardadas en el navegador y sólo se vuelven a leer si el portafolio cambió.
  async function ensureVersions(slug) {
    if (!S.versions[slug]) { var p = S.pmap[slug] || {}; S.versions[slug] = await db.getVersionsCached(slug, [p.versionsRev || 0, p.currentVersionId || '', p.currentEffectiveFrom || ''].join('|')); }
    return S.versions[slug];
  }
  // Meses: vienen dentro del documento del portafolio (campo history); 0 lecturas extra.
  // Si un portafolio todavía no lo tiene, se leen de monthly_returns como antes.
  async function ensureMonthly(slug) {
    if (!S.monthly[slug]) { var p = S.pmap[slug] || {}; S.monthly[slug] = Array.isArray(p.history) && p.history.length ? p.history : await db.getMonthlyReturns(slug); }
    return S.monthly[slug];
  }
  async function ensureQuotesFrom(date) {
    if (S.quotes && S.quotesFrom <= date) return S.quotes;
    // Los cierres viejos quedan guardados en el navegador: sólo se piden los días nuevos.
    S.quotes = await db.getQuotesCached(date, S.quotesRev); S.quotesFrom = date; return S.quotes;
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
  // NOTIFICACIONES (avisos de apertura, cierre y rotaciones)
  //   S.pushCfg = config/push (clave pública y horarios) · S.push = { token, prefs } si está suscripto.
  // ============================================================
  var PUSH_KEY = 'norte_push', PUSH_ST = 'norte_push_st';
  function pushDefaults() { var rot = {}; S.portfolios.forEach(function (p) { rot[p.slug] = true; }); return { open: true, close: true, rot: rot }; }
  function pushSoportado() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && firebase.messaging; }
  // Estado para mostrar: 'off' (sin configurar en el Panel), 'ios' (hay que instalar la app), 'nosoporta',
  // 'bloqueado' (permiso denegado), 'inactivo' (se puede activar), 'activo'.
  function pushEstado() {
    if (!S.pushCfg || !S.pushCfg.vapidKey) return 'off';
    if (isIos() && !isStandalone()) return 'ios';
    if (!pushSoportado()) return 'nosoporta';
    if (Notification.permission === 'denied') return 'bloqueado';
    return S.push && Notification.permission === 'granted' ? 'activo' : 'inactivo';
  }
  async function pushToken() {
    var reg = await navigator.serviceWorker.ready;
    return firebase.app('cliente').messaging().getToken({ vapidKey: S.pushCfg.vapidKey, serviceWorkerRegistration: reg });
  }
  async function pushGuardar(prefs) {
    var token = await pushToken();
    if (!token) throw new Error('sin token');
    S.push = { token: token, prefs: prefs };
    var acc = db.accountId(S.session.alyc, S.session.comitente);
    await db.saveMyPush({ token: token, accountId: acc, prefs: prefs });
    try { localStorage.setItem(PUSH_KEY, '1'); } catch (e) { }
    db.cache.set(PUSH_ST, { token: token, prefs: prefs, acc: acc, at: Date.now() });
  }
  // Al abrir la app: lee los ajustes y, si este dispositivo ya estaba suscripto, renueva el registro.
  async function pushInit() {
    try {
      // S.pushCfg ya vino con los datos base. Si este dispositivo está suscripto, se compara el token
      // actual con el guardado acá: si es el mismo (y se registró hace menos de 7 días) no se toca la base.
      var marcado = false; try { marcado = localStorage.getItem(PUSH_KEY) === '1'; } catch (e) { }
      if (S.pushCfg && S.pushCfg.vapidKey && pushSoportado() && Notification.permission === 'granted' && marcado && S.session) {
        var st = db.cache.get(PUSH_ST), token = await pushToken();
        if (st && st.token === token && st.acc === db.accountId(S.session.alyc, S.session.comitente) && Date.now() - st.at < 7 * 86400e3) S.push = { token: token, prefs: st.prefs };
        else { var mio = st ? null : await db.getMyPush(); await pushGuardar(st && st.prefs ? st.prefs : mio && mio.prefs ? mio.prefs : pushDefaults()); }
      }
    } catch (e) { console.warn('Avisos:', e.message || e); }
    if (S.session && !location.hash.replace(/^#\/?/, '')) renderHome();
  }
  function avisosCardHtml() {
    var e = pushEstado();
    if (e === 'off' || e === 'nosoporta') return '';
    if (e === 'activo') return '<a class="avisos on" href="#/avisos"><span>🔔 Avisos activados en este dispositivo</span><b>Configurar ›</b></a>';
    return '<a class="avisos" href="#/avisos"><span>🔔 <b>Recibí avisos en tu celular</b><br><small>Apertura y cierre del mercado, y cada rotación de los portafolios.</small></span><b>Activar ›</b></a>';
  }
  function renderAvisos() {
    var e = pushEstado(), cuerpo;
    var hs = S.pushCfg ? (S.pushCfg.openTime || '10:30') + ' y ' + (S.pushCfg.closeTime || '18:00') : '';
    if (e === 'off' || e === 'nosoporta') cuerpo = '<div class="card"><p>Este navegador no permite recibir avisos. Probá abrir la app desde Chrome en tu celular.</p></div>';
    else if (e === 'ios') cuerpo = '<div class="card"><h3>Primero instalá la app</h3><p>En iPhone los avisos solo funcionan con la app instalada en la pantalla de inicio:</p><ol><li>Abrí esta página en <b>Safari</b>.</li><li>Tocá el botón <b>Compartir</b>.</li><li>Elegí <b>"Agregar a inicio"</b>.</li><li>Abrí la app desde el ícono nuevo y volvé a esta pantalla.</li></ol></div>';
    else if (e === 'bloqueado') cuerpo = '<div class="card"><h3>Los avisos están bloqueados</h3><p>En algún momento se rechazó el permiso de notificaciones para esta app. Para activarlos, entrá a la configuración del navegador (o del celular) → Notificaciones → y permití los avisos de Norte Inversiones. Después volvé a esta pantalla.</p></div>';
    else if (e === 'inactivo') cuerpo = '<div class="card"><h3>Activar avisos en este dispositivo</h3><p>Te vamos a avisar:</p><ul><li>Cuando <b>abre y cierra el mercado</b> (días hábiles, ' + hs + ' hs). El aviso de cierre trae el rendimiento del día de cada portafolio y el valor del dólar.</li><li>Cada vez que publicamos una <b>rotación</b> en un portafolio.</li></ul><p class="legal">Después podés elegir cuáles recibir, o desactivarlos cuando quieras.</p><button class="btn amarillo lg" id="pushOn">Activar avisos</button><p class="legal mt" id="pushMsg"></p></div>';
    else {
      var p = S.push.prefs || pushDefaults(), rot = p.rot || {};
      var chk = function (k, txt, on) { return '<label class="swrow"><span>' + txt + '</span><input type="checkbox" data-pk="' + k + '"' + (on ? ' checked' : '') + '></label>'; };
      cuerpo = '<div class="card"><h3>Mercado</h3>' + chk('open', 'Apertura del mercado', p.open !== false) + chk('close', 'Cierre del mercado <small>rendimiento del día y dólar</small>', p.close !== false) + '</div>' +
        '<div class="card"><h3>Rotaciones</h3><p class="legal">Un aviso cada vez que cambia la composición de un portafolio.</p>' +
        S.portfolios.map(function (pf) { return chk('rot:' + pf.slug, h(pf.name), rot[pf.slug] !== false); }).join('') + '</div>' +
        '<p><button class="btn sec" id="pushOff">Desactivar todos los avisos en este dispositivo</button></p>';
    }
    setView('<a href="#/" class="legal">‹ Inicio</a><h1>Avisos</h1><p class="muted">Notificaciones en tu celular. Se configuran por dispositivo.</p>' + cuerpo + legalFoot());
    var on = $('pushOn');
    if (on) on.onclick = async function () {
      on.disabled = true; $('pushMsg').textContent = 'Activando…';
      try {
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') { renderAvisos(); return; }
        await pushGuardar(pushDefaults()); toast('Avisos activados'); renderAvisos();
      } catch (x) { console.error(x); on.disabled = false; $('pushMsg').textContent = 'No se pudieron activar. Probá de nuevo en un momento.'; }
    };
    var off = $('pushOff');
    if (off) off.onclick = async function () {
      try { await db.deleteMyPush(); } catch (x) { }
      S.push = null; try { localStorage.removeItem(PUSH_KEY); } catch (x) { } db.cache.del(PUSH_ST);
      toast('Avisos desactivados'); renderAvisos();
    };
    document.querySelectorAll('[data-pk]').forEach(function (c) {
      c.onchange = async function () {
        var p = S.push.prefs || pushDefaults(); p.rot = p.rot || {};
        if (c.dataset.pk.indexOf('rot:') === 0) p.rot[c.dataset.pk.slice(4)] = c.checked; else p[c.dataset.pk] = c.checked;
        try { await pushGuardar(p); toast('Guardado'); } catch (x) { console.error(x); c.checked = !c.checked; toast('No se pudo guardar'); }
      };
    });
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
        await db.ensureAnon();
        var r = await N.clientDirectory.lookup(alycSel, num);
        if (!r) { $('loginMsg').textContent = 'No encontramos esa cuenta en ' + alycSel + '. Revisá el número o escribinos.'; this.disabled = false; return; }
        S.session = { alyc: alycSel, comitente: num, name: r.displayName, clientId: r.clientId, at: Date.now() };
        saveSession(S.session);
        await db.openSession(alycSel, num, true);
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
        '<div class="nums"><div class="n"><div class="l">' + (cur ? E.fmtMonthLong(cur.ym) : 'Mes en curso') + '</div><div class="v ' + pc(mes) + '">' + E.fmtPct(mes) + '</div><div class="s">' + (cur && cur.basisIsPartial ? 'desde el ' + E.fmtDate(cur.basisDate) : cur && cur.isLive ? 'en vivo' : cur ? 'al ' + E.fmtDate(cur.endDate) : 'sin datos') + '</div>' + cupNota(cur) + '</div>' +
        '<div class="n"><div class="l">Acumulado</div><div class="v ' + pc(acc) + '">' + E.fmtPct(acc) + '</div><div class="s">' + (p.inceptionDate ? 'desde ' + E.fmtMonth(p.inceptionDate.slice(0, 7)) : '') + (st.monthsCount ? ' · ' + st.monthsCount + ' meses' : '') + '</div></div></div>' +
        sparkHtml(p, st) +
        '<span class="more">Ver portafolio ›</span></a>';
    }).join('');
    var install = S.installEvt ? '<div class="installtip"><b>Instalá la app en tu teléfono</b> para tenerla a mano. <button class="btn sm amarillo" id="btnInstall">Instalar</button></div>'
      : isIos() && !isStandalone() ? '<div class="installtip"><b>Para instalarla en tu iPhone:</b> tocá el botón Compartir de Safari y elegí "Agregar a inicio".</div>' : '';
    setView('<h1>Hola' + (S.session && S.session.name ? ', ' + h(S.session.name) : '') + '</h1><p class="muted">Tres portafolios sugeridos, actualizados todos los meses. Valores en ' + (S.moneda === 'USD' ? 'dólares (CCL)' : 'pesos') + '.</p>' +
      rotBannerHtml() + avisosCardHtml() +
      '<div class="pcards">' + cards + '</div>' +
      '<p><a class="btn sec" href="#/comparar">Comparar los tres</a></p>' + install + legalFoot());
    var rb = $('rotClose'); if (rb) rb.onclick = function () { try { localStorage.setItem(ROT_VISTA_KEY, rb.dataset.d); } catch (e) { } renderHome(); };
    var bi = $('btnInstall'); if (bi) bi.onclick = async function () { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; renderHome(); };
  }
  // Aviso de rotación reciente (hasta 10 días después). Se puede cerrar; vuelve con la próxima rotación.
  function rotBannerHtml() {
    var desde = E.addDays(E.todayART(), -10);
    var rot = S.portfolios.filter(function (p) { return p.currentEffectiveFrom && p.currentEffectiveFrom >= desde; });
    if (!rot.length) return '';
    var ultima = rot.map(function (p) { return p.currentEffectiveFrom; }).sort().pop(), vista = null;
    try { vista = localStorage.getItem(ROT_VISTA_KEY); } catch (e) { }
    if (vista === ultima) return '';
    return '<div class="rotbanner"><button class="iconbtn" id="rotClose" data-d="' + h(ultima) + '" aria-label="Cerrar aviso">✕</button>' +
      '<b>Nueva rotación · ' + E.fmtDate(ultima) + '</b><div class="s">Mirá qué cambió en cada portafolio:</div>' +
      '<div class="links">' + rot.map(function (p) { return '<a href="#/p/' + p.slug + '/rotaciones">' + h(p.name) + ' ›</a>'; }).join('') + '</div></div>';
  }
  // Sparkline de los últimos 30 días (calculada por el robot en stats.sparkline). Se oculta si no hay datos.
  function sparkHtml(p, st) {
    var sp = st && st.sparkline;
    if (!sp || !sp.values || sp.values.length < 2) return '';
    var vals = S.moneda === 'USD' && sp.valuesUsd ? sp.valuesUsd : sp.values;
    var color = p.riskLevel === 1 ? '#1E8E3E' : p.riskLevel === 3 ? '#D93025' : '#E6C000';
    var ult = vals[vals.length - 1];
    return '<div class="spark-wrap"><div class="l">Últimos 30 días · <span class="' + pc(ult) + '">' + E.fmtPct(ult, 1) + '</span> desde el ' + E.fmtDate(sp.from) + '</div>' + C.sparkline(vals, color) + '</div>';
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
      '<div class="row2"><span>Acumulado <b class="' + pc(acc) + '">' + E.fmtPct(acc) + '</b></span>' + (p.inceptionDate ? '<span class="muted">desde ' + E.fmtMonth(p.inceptionDate.slice(0, 7)) + '</span>' : '') + '</div>' +
      (cup(curM) ? '<div class="cupon">Del ' + E.fmtPct(mes) + ' del mes, <b>' + E.fmtPct(cup(curM)) + '</b> viene del cobro de cupones (renta de bonos, letras u ONs); el resto, de la variación de precios.</div>' : '') + '</div>';
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
      var v = S.moneda === 'USD' ? x.varUsd : x.varArs, cpn = S.moneda === 'USD' ? x.couponPctUsd : x.couponPctArs;
      return '<div class="holding"><div class="hl"><div class="tk">' + h(x.ticker) + (ins.type ? '<span class="tipo">' + h(tipo(ins.type)) + '</span>' : '') + '</div><div class="nm">' + h(ins.name || '') + '</div>' +
        '<div class="px"><span class="l">Precio de compra</span><b>' + buy + '</b></div>' +
        '<div class="px"><span class="l">Precio actual</span><b>' + now + '</b>' + (x.stale ? ' <span class="stale">al ' + E.fmtDate(x.asOf) + '</span>' : '') + '</div></div>' +
        '<div class="hc"><div class="l">Tenencia</div><div class="v">' + E.fmtNum(x.weightPct, 0) + '%</div></div>' +
        '<div class="hc"><div class="l">Resultado</div><div class="v ' + pc(v) + '">' + E.fmtPct(v) + '</div>' + (cpn > 0.004 ? '<div class="cupon">cupón ' + E.fmtPct(cpn) + '</div>' : '') + '</div></div>';
    }).join('');
    var comp = E.compositionByType(cur.holdings, S.insMap).map(function (c) { return { label: tipo(c.type), value: c.weightPct }; });
    var vs = S.versions[slug] || [], prev = vs.length > 1 ? vs[vs.length - 2] : null;
    var cambios = prev && E.diffHoldings(prev, cur).changed
      ? '<div class="card"><h3>Qué cambió en la última rotación</h3><p class="legal">Rotación del ' + E.fmtDate(cur.effectiveFrom) + ', comparada con la composición anterior.</p>' + cambiosHtml(prev, cur) +
        '<p class="mt"><a class="legal" href="#/p/' + slug + '/rotaciones">Ver todas las rotaciones ›</a></p></div>' : '';
    var monto = montoGuardado();
    var calc = '<div class="card"><h3>¿Cuánto comprar de cada activo?</h3><p class="legal">Escribí el monto que querés invertir y te mostramos cómo se reparte según los porcentajes del portafolio, a precios actuales.</p>' +
      '<label class="f"><span>Monto a invertir (' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + ')</span><input type="text" id="calcMonto" inputmode="numeric" autocomplete="off" placeholder="Ej. 1.000.000" value="' + (monto ? E.fmtNum(monto, 0) : '') + '"></label>' +
      '<div id="calcOut">' + calcHtml(cur, monto) + '</div>' +
      '<p class="legal">Cálculo orientativo: no incluye comisiones ni derechos de mercado, y los precios pueden diferir de los de tu bróker al momento de operar. En bonos, letras y ONs la cantidad son nominales y puede haber mínimos de compra.</p></div>';
    return cambios + '<div class="card"><h3>Composición</h3>' + C.donut({ slices: comp }) + '</div>' +
      '<div class="card"><h3>Activos</h3><p class="legal">Resultado de cada activo desde su precio de compra, en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + '. En bonos, letras y ONs incluye los cupones cobrados mientras estuvieron en cartera; debajo se indica qué parte es cupón.</p>' + rows + delayNote() + '</div>' + calc +
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
    var todos = hist.months.reduce(function (t, m) { return t.concat(m.payments || []); }, []);
    var cobrosCard = todos.length ? '<div class="card"><h3>Cupones cobrados</h3><p class="legal">Renta y amortización que pagaron los bonos, letras y ONs mientras estuvieron en el portafolio. El porcentaje es lo que cada cobro sumó al rendimiento del portafolio en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + '; ya está incluido en los rendimientos mensuales.</p>' + cobrosHtml(todos) + '</div>' : '';
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
      cobrosCard +
      '<div class="card"><h3>Mes a mes</h3><p class="legal">En %. Los valores atenuados son del histórico previo a la app.</p>' + table + '</div>';
  }

  async function rotacionesHtml(slug) {
    var vs = S.versions[slug] || [];
    if (!vs.length) return '<div class="card"><p>Todavía no hay rotaciones publicadas.</p></div>';
    var from = E.addDays(E.monthStart(E.monthOf(vs[0].effectiveFrom)), -10);
    var quotes = await ensureQuotesFrom(from);
    var book = E.quoteBook(quotes, S.live, S.pays);
    var segs = E.computeSegments(vs, book, {});
    var evs = vs.slice().reverse().map(function (v, idx) {
      var prevV = vs[vs.length - 2 - idx] || null;
      var ss = segs.filter(function (s) { return s.versionId === v.id; });
      var r = ss.length ? { ars: E.chain(ss.map(function (s) { return s.returnArs; })), usd: E.chain(ss.map(function (s) { return s.returnUsd; })),
        couponArs: ss.reduce(function (t, s) { return t + (s.couponArs || 0); }, 0), couponUsd: ss.reduce(function (t, s) { return t + (s.couponUsd || 0); }, 0),
        payments: ss.reduce(function (t, s) { return t.concat(s.payments || []); }, []) } : null;
      var desde = ss.length ? ss[0].basisDate : null, hasta = ss.length ? ss[ss.length - 1].endDate : null;
      var hs = v.holdings.map(function (x) { var ins = S.insMap[x.ticker] || {}; return '<tr><td><b>' + h(x.ticker) + '</b> <small>' + h(tipo(ins.type)) + '</small></td><td class="num">' + E.fmtNum(x.weightPct, 0) + '%</td><td class="num">' + E.fmtArs(x.buyPriceArs) + '</td></tr>'; }).join('');
      return '<details class="ev" ' + (idx === 0 ? 'open' : '') + '><summary>' + E.fmtDate(v.effectiveFrom) + (v.effectiveTo ? ' → ' + E.fmtDate(v.effectiveTo) : ' → hoy') + (r ? ' <span class="' + pc(mv(r)) + '">' + E.fmtPct(mv(r), 1) + '</span>' : '') + '</summary>' +
        '<div class="meta">' + v.holdings.length + ' activos · beta ' + E.fmtNum(E.betaPortfolio(v.holdings), 2) + (r ? ' · rendimiento del período en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + ' (' + E.fmtDate(desde) + ' al ' + E.fmtDate(hasta) + ')' : ' · sin precios para medir este período') + '</div>' +
        (r && cup(r) ? '<h4>Cupones cobrados en el período</h4>' + cobrosHtml(r.payments) : '') +
        '<h4>Qué cambió</h4>' + cambiosHtml(prevV, v) +
        (v.rationale ? '<h4>Por qué</h4><p>' + h(v.rationale).replace(/\n/g, '<br>') + '</p>' : '') +
        '<h4>Composición completa</h4><div class="tablewrap"><table><thead><tr><th>Activo</th><th class="num">%</th><th class="num">Compra</th></tr></thead><tbody>' + hs + '</tbody></table></div></details>';
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
    var book = E.quoteBook(quotes, S.live, S.pays);
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
    $('simOut').innerHTML = '<div class="simresult"><div class="big ' + pc(v) + '">' + E.fmtPct(v, 1) + '</div><div class="l">estimado en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + ' del ' + E.fmtDate(r.basisDate) + ' al ' + E.fmtDate(r.endDate) + (r.rotations ? ' · ' + r.rotations + ' rotación' + (r.rotations > 1 ? 'es' : '') + ' en el medio' : '') + '</div>' +
      cupNota({ couponArs: r.segments.reduce(function (t, s) { return t + (s.couponArs || 0); }, 0), couponUsd: r.segments.reduce(function (t, s) { return t + (s.couponUsd || 0); }, 0) }) + '</div>' +
      (r.months.length > 1 ? '<div class="tablewrap"><table class="ymtable"><thead><tr><th>Mes</th><th class="num">Estimado</th></tr></thead><tbody>' + r.months.map(function (m) { return '<tr><td>' + E.fmtMonthLong(m.ym) + '</td><td class="num ' + pc(mv(m)) + '">' + E.fmtPct(mv(m), 1) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '');
    var d = $('simDate'); if (d) d.value = sim.from;
  }

  function bindDetail(slug, tab) {
    // Tocar una barra deja fijo su % (y saca el de las demás, salvo el mes en curso).
    document.querySelectorAll('svg .bar').forEach(function (g) {
      g.addEventListener('click', function () {
        var on = g.classList.contains('on') && !g.dataset.fixed;
        g.parentNode.querySelectorAll('.bar.on').forEach(function (o) { if (o !== g && !o.dataset.fixed) o.classList.remove('on'); });
        g.classList.toggle('on', !on || !!g.dataset.fixed);
      });
      if (g.classList.contains('on')) g.dataset.fixed = '1';
    });
    document.querySelectorAll('[data-ficha]').forEach(function (el) { el.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openFicha(el.dataset.ficha); }; });
    var cm = $('calcMonto');
    if (cm) cm.oninput = function () {
      var n = Number(cm.value.replace(/\D/g, '')) || 0;
      cm.value = n ? E.fmtNum(n, 0) : '';
      try { localStorage.setItem(MONTO_KEY, String(n)); } catch (e) { }
      $('calcOut').innerHTML = calcHtml(currentVersion(slug), n);
    };
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
    // Colores de identificación de cada portafolio (por nivel de riesgo): verde, amarillo, rojo.
    var colors = S.portfolios.map(function (p) { return p.riskLevel === 1 ? '#1E8E3E' : p.riskLevel === 3 ? '#D93025' : '#FFD600'; });
    var series = S.portfolios.map(function (p, i) {
      var map = {}; hists[p.slug].months.forEach(function (m) { map[m.ym] = S.moneda === 'USD' ? m.accUsd : m.accArs; });
      return { name: p.name, color: colors[i], points: labels.map(function (l) { return map[l] != null ? map[l] : null; }) };
    });
    var rows = S.portfolios.map(function (p, i) {
      var hst = hists[p.slug], st = p.stats || {}, cur = st.current;
      var y = hst.yearTotals[hst.yearTotals.length - 1];
      return '<tr><td><b style="border-left:4px solid ' + colors[i] + ';padding-left:8px">' + h(p.name) + '</b></td><td class="num ' + pc(cur ? mv(cur) : null) + '">' + E.fmtPct(cur ? mv(cur) : null, 1) + '</td><td class="num ' + pc(y ? mv(y) : null) + '">' + E.fmtPct(y ? mv(y) : null, 1) + '</td><td class="num ' + pc(mv(hst.accumulated)) + '"><b>' + E.fmtPct(mv(hst.accumulated), 1) + '</b></td></tr>';
    }).join('');
    var y0 = hists[S.portfolios[0].slug].yearTotals.slice(-1)[0];
    setView('<h1>Comparar</h1><p class="muted">Acumulado compuesto de los tres portafolios en ' + (S.moneda === 'USD' ? 'dólares' : 'pesos') + '.</p>' +
      '<div class="card"><div class="comparar-legend">' + S.portfolios.map(function (p, i) { return '<span style="--c:' + colors[i] + '">' + h(p.name) + '</span>'; }).join('') + '</div>' + C.lines({ series: series, labels: labels.map(E.fmtMonth) }) + '</div>' +
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
    else if (top === 'avisos') renderAvisos();
    else if (top === 'aprender') renderHome(); // fichas educativas desactivadas por ahora
    else if (top === 'salir') { db.cache.del(BASE_KEY); db.cache.del(PUSH_ST); if (S.push) { db.deleteMyPush().catch(function () { }); S.push = null; try { localStorage.removeItem(PUSH_KEY); } catch (e) { } } clearSession(); S.session = null; S.loaded = false; db.closeSession(); location.hash = '#/'; renderHeader(); renderLogin('Cerraste la sesión.'); }
    else renderHome();
  }

  // ---------- arranque ----------
  (async function init() {
    try { S.moneda = localStorage.getItem(MONEDA_KEY) === 'USD' ? 'USD' : 'ARS'; } catch (e) { }
    db.init('cliente');
    if (N.ticker) N.ticker.init();
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); S.installEvt = e; if (S.session && !location.hash.replace('#/', '')) renderHome(); });
    window.addEventListener('hashchange', route);
    S.session = loadSession();
    if (S.session) {
      try { await db.openSession(S.session.alyc, S.session.comitente); await loadBase(); } catch (e) {
        console.error(e);
        // Sin permiso = la sesión ya no es válida (cuenta dada de baja o sesión vencida): se vuelve a pedir el comitente.
        if (e && e.code === 'permission-denied') { db.cache.del(BASE_KEY); db.cache.del('norte_ses_ok'); clearSession(); S.session = null; renderHeader(); renderLogin('Tu sesión venció. Ingresá de nuevo con tu número de comitente.'); return; }
        setView('<div class="card"><p>No se pudieron cargar los datos. Revisá tu conexión y recargá.</p></div>'); return;
      }
    }
    renderHeader(); route();
    if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  })();
})();
