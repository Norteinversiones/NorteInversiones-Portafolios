/* ============================================================
   INGESTA DE PRECIOS · Norte Inversiones
   Corre en GitHub Actions (ver .github/workflows/precios.yml).

   Modos:
     node capture.js eod    -> cierre del día (una fila por fecha; si se corre
                               dos veces el mismo día, pisa: idempotente)
     node capture.js live   -> intradía (pisa siempre el doc quotes/live)

   Fuentes:
     data912.com  -> precios ARS de acciones, CEDEARs, bonos, Lecaps, ONs
     dolarapi.com -> CCL y MEP

   Colecciones Firestore que escribe:
     instruments/{ticker}     catálogo (se siembra desde catalogo.json si está vacío)
     quotes/{YYYY-MM-DD}      cierre: fx + precios de los tickers del catálogo
     quotes/live              intradía: misma forma, isEod=false
     quotes_all/{YYYY-MM-DD}  archivo crudo con TODOS los símbolos del feed
                              (para dar historia a un ticker que se agregue después)
     jobs/ingesta             salud: última corrida de cada modo
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const MODE = ['live', 'market', 'push'].indexOf(process.argv[2]) >= 0 ? process.argv[2] : 'eod';
const FORCE = process.argv.includes('--force');

const D912 = 'https://data912.com/live/';
const FEEDS = ['arg_stocks', 'arg_cedears', 'arg_bonds', 'arg_notes', 'arg_corp'];
const DOLARAPI = 'https://dolarapi.com/v1/dolares';

// ---------- utilidades ----------
function log() { console.log('[' + new Date().toISOString() + ']', ...arguments); }

// Fecha calendario en Argentina (UTC-3, sin horario de verano).
function fechaART(d) {
  d = d || new Date();
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function esFinDeSemana(fecha) {
  const dow = new Date(fecha + 'T12:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

async function getJson(url, intentos) {
  intentos = intentos || 3;
  let ultimoError;
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'norte-portafolios-ingesta/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      ultimoError = e;
      log('fallo', url, '(' + i + '/' + intentos + '):', e.message);
      if (i < intentos) await new Promise(function (res) { setTimeout(res, 3000 * i); });
    }
  }
  throw ultimoError;
}

// Precio de una fila del feed: último operado; si no operó, punta media.
function precioDe(f) {
  const c = Number(f.c);
  if (c > 0) return c;
  const bid = Number(f.px_bid), ask = Number(f.px_ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return null;
}

// ---------- fuentes ----------
async function traerFeeds() {
  const mapa = new Map(); // symbol -> precio ARS
  const errores = [];
  for (const ep of FEEDS) {
    try {
      const filas = await getJson(D912 + ep);
      let n = 0;
      for (const f of filas) {
        const p = precioDe(f);
        if (f.symbol && p != null) { mapa.set(String(f.symbol).toUpperCase(), p); n++; }
      }
      log(ep + ':', n, 'símbolos con precio');
    } catch (e) {
      errores.push(ep + ': ' + e.message);
    }
  }
  return { mapa, errores };
}

async function traerFx() {
  const lista = await getJson(DOLARAPI);
  const ccl = lista.find(function (x) { return x.casa === 'contadoconliqui'; });
  const mep = lista.find(function (x) { return x.casa === 'bolsa'; });
  if (!ccl || !mep) throw new Error('dolarapi no devolvió CCL/MEP');
  // Convención: el valor que usan los cálculos es el de VENTA. Se guardan ambos.
  return {
    ccl: Number(ccl.venta), cclCompra: Number(ccl.compra), cclVenta: Number(ccl.venta), cclAt: ccl.fechaActualizacion || null,
    mep: Number(mep.venta), mepCompra: Number(mep.compra), mepVenta: Number(mep.venta), mepAt: mep.fechaActualizacion || null
  };
}

// ---------- catálogo ----------
// Catálogo completo (activos e inactivos), UNA sola lectura por corrida.
// Primero el documento consolidado config/catalog (lo mantiene el Panel): 1 lectura en vez de una
// por instrumento. Si no existe todavía, se lee la colección instruments como antes.
let _catalogo = null;
function catalogoCompleto(db) {
  if (!_catalogo) _catalogo = (async function () {
    try {
      const m = await db.collection('config').doc('catalog').get();
      if (m.exists && Array.isArray(m.data().items) && m.data().items.length) return m.data().items;
    } catch (e) { log('config/catalog no disponible, uso la colección:', e.message); }
    const snap = await db.collection('instruments').get();
    if (!snap.empty) return snap.docs.map(function (d) { return Object.assign({ ticker: d.id }, d.data()); });
    log('catálogo vacío en Firestore: siembro desde catalogo.json');
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogo.json'), 'utf8'));
    const batch = db.batch();
    seed.forEach(function (i, idx) {
      batch.set(db.collection('instruments').doc(i.ticker), Object.assign({}, i, {
        isActive: true,
        order: idx,
        educationSlug: i.type.toLowerCase().replace('_', '-'),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }));
    });
    await batch.commit();
    return seed.map(function (i) { return Object.assign({ isActive: true }, i); });
  })();
  return _catalogo;
}
async function cargarCatalogo(db) {
  return (await catalogoCompleto(db)).filter(function (i) { return i.isActive !== false; });
}

function preciosCatalogo(catalogo, mapa) {
  const prices = {}, missing = [];
  for (const ins of catalogo) {
    const sym = String(ins.priceSymbol || ins.ticker).toUpperCase();
    const p = mapa.get(sym);
    if (p != null) prices[ins.ticker] = p; else missing.push(ins.ticker);
  }
  return { prices, missing };
}

// Último cierre con precios anterior a `fecha`.
// Filtra sólo por `date` (un solo campo) para no necesitar índice compuesto;
// isEod/prices se filtran en código.
async function ultimoCierreAntesDe(db, fecha) {
  const snap = await db.collection('quotes')
    .where('date', '<', fecha)
    .orderBy('date', 'desc')
    .limit(15)
    .get();
  for (const d of snap.docs) { const x = d.data(); if (x.isEod && x.prices) return x; }
  return null;
}

// ---------- modos ----------
async function correrEod(db) {
  const fecha = fechaART();
  if (esFinDeSemana(fecha) && !FORCE) {
    log(fecha, 'es fin de semana: nada que capturar');
    return { skipped: 'weekend', date: fecha };
  }

  const catalogo = await cargarCatalogo(db);
  const [feeds, fx] = await Promise.all([traerFeeds(), traerFx()]);
  const mapa = feeds.mapa, errores = feeds.errores;
  if (errores.length >= FEEDS.length) throw new Error('ningún feed respondió: ' + errores.join(' | '));

  const res = preciosCatalogo(catalogo, mapa);
  const prices = res.prices, missing = res.missing;
  const prev = await ultimoCierreAntesDe(db, fecha);

  // Detección de feriado: si (casi) nada cambió respecto del último cierre, no hubo rueda.
  if (prev && prev.prices && !FORCE) {
    let iguales = 0, comparables = 0;
    for (const tk of Object.keys(prices)) {
      if (prev.prices[tk] != null) { comparables++; if (prev.prices[tk] === prices[tk]) iguales++; }
    }
    if (comparables >= 5 && iguales / comparables >= 0.9) {
      log(fecha + ': ' + iguales + '/' + comparables + ' precios idénticos al cierre anterior (' + prev.date + ') -> sin rueda');
      await db.collection('quotes').doc(fecha).set({
        date: fecha, isEod: true, noTrading: true, prevDate: prev.date,
        capturedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { skipped: 'no_trading', date: fecha, prevDate: prev.date };
    }
  }

  // Arrastre de precios rancios: si un ticker no cotizó, se repite el último y se marca desde cuándo.
  const stale = {};
  const missingFinal = [];
  for (const tk of missing) {
    if (prev && prev.prices && prev.prices[tk] != null) {
      prices[tk] = prev.prices[tk];
      stale[tk] = (prev.stale && prev.stale[tk]) || prev.date;
    } else {
      missingFinal.push(tk);
    }
  }

  const doc = {
    date: fecha, isEod: true, fx: fx, prices: prices, stale: stale, missing: missingFinal,
    feedErrors: errores, source: 'data912+dolarapi', n: Object.keys(prices).length,
    capturedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  const todo = {};
  mapa.forEach(function (p, s) { todo[s] = p; });

  await db.collection('quotes').doc(fecha).set(doc);
  await db.collection('quotes_all').doc(fecha).set({
    date: fecha, fx: fx, prices: todo, n: mapa.size,
    capturedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  log('cierre', fecha, 'guardado:', doc.n, 'precios ·', Object.keys(stale).length, 'arrastrados ·',
      missingFinal.length, 'faltantes', missingFinal.join(','));
  return { date: fecha, n: doc.n, stale: Object.keys(stale).length, missing: missingFinal, feedErrors: errores };
}

async function correrLive(db) {
  const catalogo = await cargarCatalogo(db);
  const [feeds, fx] = await Promise.all([traerFeeds(), traerFx()]);
  const mapa = feeds.mapa, errores = feeds.errores;
  if (errores.length >= FEEDS.length) throw new Error('ningún feed respondió: ' + errores.join(' | '));

  const res = preciosCatalogo(catalogo, mapa);
  const fecha = fechaART();
  await db.collection('quotes').doc('live').set({
    date: fecha, isEod: false, fx: fx, prices: res.prices, missing: res.missing, feedErrors: errores,
    source: 'data912+dolarapi', n: Object.keys(res.prices).length,
    asOf: admin.firestore.FieldValue.serverTimestamp()
  });
  log('intradía', fecha, 'guardado:', Object.keys(res.prices).length, 'precios ·', res.missing.length, 'faltantes', res.missing.join(','));
  return { date: fecha, n: Object.keys(res.prices).length, missing: res.missing, feedErrors: errores };
}

// ---------- cinta de cotizaciones (modo market) ----------
// Índices/commodities: Yahoo Finance (endpoint público de gráficos, sin key; query1 con respaldo en query2).
// Dólar MEP: dolarapi. Riesgo país: argentinadatos. Escribe market/ticker (sólo el último valor).
// Si una fuente falla, el ítem conserva el valor anterior con stale:true; nunca se rompe la cinta.
const TICKER_DEFS = [
  { key: 'spx', label: 'S&P 500', yahoo: '^GSPC', unit: 'pts', decimals: 2 },
  { key: 'ndq', label: 'Nasdaq', yahoo: '^IXIC', unit: 'pts', decimals: 2 },
  { key: 'merval', label: 'Merval', yahoo: '^MERV', unit: 'pts', decimals: 0 },
  { key: 'oro', label: 'Oro', yahoo: 'GC=F', unit: 'US$/oz', decimals: 2 },
  { key: 'wti', label: 'Petróleo WTI', yahoo: 'CL=F', unit: 'US$/bbl', decimals: 2 },
  { key: 'mep', label: 'Dólar MEP', unit: '$', decimals: 0 },
  { key: 'riesgo', label: 'Riesgo país', unit: 'pb', decimals: 0 }
];
const YAHOO_UA = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) norte-portafolios/1.0' };

async function yahooQuote(symbol) {
  const path = '/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1d';
  let lastErr;
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(host + path, { headers: YAHOO_UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!meta || !(meta.regularMarketPrice > 0)) throw new Error('sin precio en la respuesta');
      const price = Number(meta.regularMarketPrice);
      let pct = meta.regularMarketChangePercent != null ? Number(meta.regularMarketChangePercent) : null;
      const prev = Number(meta.chartPreviousClose || meta.previousClose);
      if ((pct == null || isNaN(pct)) && prev > 0) pct = (price / prev - 1) * 100;
      return { value: price, changePct: pct != null && !isNaN(pct) ? pct : null, prevClose: prev > 0 ? prev : null,
               asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(), source: 'yahoo' };
    } catch (e) { lastErr = e; log('yahoo', symbol, host, 'falló:', e.message); }
  }
  throw lastErr;
}

async function correrMarket(db) {
  const ref = db.collection('market').doc('ticker');
  const prevDoc = await ref.get();
  const prevItems = {};
  if (prevDoc.exists) (prevDoc.data().items || []).forEach(function (it) { prevItems[it.key] = it; });
  const hoy = fechaART();
  const errores = [];
  const items = [];

  // Dólar MEP: variación contra el último valor guardado de un día anterior.
  let mep = null;
  try { const fx = await traerFx(); mep = fx.mep; } catch (e) { errores.push('mep: ' + e.message); }
  // Riesgo país: último valor y variación contra el día anterior (histórico de argentinadatos).
  let riesgo = null;
  try {
    const hist = await getJson('https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais');
    const serie = (Array.isArray(hist) ? hist : []).filter(function (x) { return x && x.valor > 0 && x.fecha; })
      .sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
    if (serie.length) {
      const ult = serie[serie.length - 1], ant = serie.length > 1 ? serie[serie.length - 2] : null;
      riesgo = { value: Number(ult.valor), changePct: ant ? (ult.valor / ant.valor - 1) * 100 : null, prevClose: ant ? Number(ant.valor) : null,
                 asOf: ult.fecha + 'T00:00:00.000Z', source: 'argentinadatos' };
    }
  } catch (e) { errores.push('riesgo: ' + e.message); }

  for (const def of TICKER_DEFS) {
    const prev = prevItems[def.key] || null;
    let datos = null;
    try {
      if (def.yahoo) datos = await yahooQuote(def.yahoo);
      else if (def.key === 'mep' && mep > 0) {
        // prevClose = último valor guardado de un día distinto (o el que ya teníamos como prevClose si es el mismo día)
        let prevClose = null;
        if (prev) prevClose = (prev.asOf || '').slice(0, 10) !== hoy ? prev.value : (prev.prevClose || null);
        datos = { value: mep, changePct: prevClose > 0 ? (mep / prevClose - 1) * 100 : null, prevClose: prevClose, asOf: new Date().toISOString(), source: 'dolarapi' };
      }
      else if (def.key === 'riesgo' && riesgo) datos = riesgo;
      else throw new Error('sin datos');
    } catch (e) {
      errores.push(def.key + ': ' + e.message);
    }
    if (datos) items.push(Object.assign({ key: def.key, label: def.label, unit: def.unit, decimals: def.decimals, stale: false }, datos));
    else if (prev) items.push(Object.assign({}, prev, { stale: true }));
    else items.push({ key: def.key, label: def.label, unit: def.unit, decimals: def.decimals, value: null, changePct: null, prevClose: null, asOf: null, source: null, stale: true });
  }

  await ref.set({ items: items, errors: errores, updatedAt: admin.firestore.FieldValue.serverTimestamp(), date: hoy });
  log('cinta guardada:', items.map(function (i) { return i.key + '=' + (i.value == null ? '—' : i.value) + (i.stale ? '(viejo)' : ''); }).join(' '), errores.length ? '· errores: ' + errores.join(' | ') : '');
  return { n: items.filter(function (i) { return !i.stale; }).length, errors: errores };
}

// ---------- recálculo de rendimientos (mismo motor que el Panel) ----------
// Después de cada corrida: meses cerrados (una vez, inmutables) + mes en curso + resumen.
const engine = require('../js/engine.js');

// Lecturas por corrida (optimizado): portafolios (3) + versiones publicadas + los cierres de una
// ventana corta, UNA sola vez para los tres portafolios. Los meses ya cerrados no se vuelven a
// calcular ni a leer: salen de la copia guardada en el documento del portafolio (campo history).
async function recalcularPortafolios(db) {
  const hoy = fechaART();
  const pagos = engine.paymentsOf(await catalogoCompleto(db));
  const ports = await db.collection('portfolios').get();

  // 1) versiones y meses guardados de cada portafolio
  const items = [];
  for (const pd of ports.docs) {
    const p = pd.data();
    const vsnap = await pd.ref.collection('versions').where('status', '==', 'published').get();
    const versions = vsnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : 1; });
    let existing;
    if (Array.isArray(p.history)) existing = p.history;                 // 0 lecturas
    else existing = (await pd.ref.collection('monthly_returns').get()).docs.map(function (d) { return d.data(); });  // sólo la primera vez
    // Primer mes que hay que calcular: el más viejo que no esté guardado como cerrado.
    let desdeMes = null;
    if (versions.length) {
      const meses = engine.monthsBetween(engine.monthOf(versions[0].effectiveFrom), engine.monthOf(hoy));
      desdeMes = meses.find(function (ym) { return !existing.some(function (x) { return x.ym === ym && x.isClosed && !x.isLegacy; }); }) || engine.monthOf(hoy);
    }
    items.push({ ref: pd.ref, slug: pd.id, versions: versions, existing: existing, desdeMes: desdeMes });
  }

  // 2) cierres: una sola consulta para los tres portafolios, con la ventana mínima necesaria
  const conVersiones = items.filter(function (it) { return it.desdeMes; });
  let book = null;
  if (conVersiones.length) {
    const mesMin = conVersiones.map(function (it) { return it.desdeMes; }).sort()[0];
    // Lo necesario: la base del mes más viejo a calcular (cierre anterior, con margen para feriados y
    // arrastre) y los 30 días de la sparkline (con el mismo margen).
    const a = engine.addDays(engine.monthStart(mesMin), -12), b = engine.addDays(hoy, -42);
    const desde = a < b ? a : b;
    const qsnap = await db.collection('quotes').where('date', '>=', desde).orderBy('date').get();
    const quotes = qsnap.docs.filter(function (d) { return d.id !== 'live'; }).map(function (d) { return d.data(); });
    const liveDoc = await db.collection('quotes').doc('live').get();
    book = engine.quoteBook(quotes, liveDoc.exists ? liveDoc.data() : null, pagos);
  }

  // 3) cálculo y guardado
  for (const it of items) {
    try {
      const existing = it.existing, legacy = existing.filter(function (m) { return m.isLegacy; });
      const calculados = it.desdeMes ? engine.computePortfolio(it.versions, book, {}).months.filter(function (m) { return m.ym >= it.desdeMes; }) : [];
      // meses cerrados anteriores a la ventana: se toman tal cual están guardados (inmutables)
      const guardados = existing.filter(function (m) { return !m.isLegacy && m.isClosed && (!it.desdeMes || m.ym < it.desdeMes); });

      const batch = db.batch();
      let n = 0;
      const merged = guardados.concat(calculados.map(function (m) {
        const ex = existing.find(function (x) { return x.ym === m.ym; });
        if (ex && ex.isClosed && !ex.isLegacy) return ex;       // mes cerrado: inmutable
        batch.set(it.ref.collection('monthly_returns').doc(m.ym), {
          ym: m.ym, ars: m.ars, usd: m.usd, isLegacy: false, isClosed: !!m.isClosed, segments: m.segments,
          basisDate: m.basisDate || null, basisIsPartial: !!m.basisIsPartial, endDate: m.endDate || null,
          isLive: !!m.isLive, missing: m.missing || [], couponArs: m.couponArs || 0, couponUsd: m.couponUsd || 0, payments: m.payments || [],
          computedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        n++;
        return m;
      }));
      const history = engine.buildHistory(legacy, merged);
      const cur = history.current;
      // Sparkline de la home: acumulado día a día de los últimos 30 días (mismo motor, calculado acá
      // para no cargarle el cálculo al navegador del cliente). null si no hay 2 puntos.
      const sparkline = book && it.versions.length ? engine.dailySeries(it.versions, book, { days: 30 }) : null;
      batch.set(it.ref, {
        stats: {
          accArs: history.accumulated.ars, accUsd: history.accumulated.usd, yearTotals: history.yearTotals,
          current: cur ? { ym: cur.ym, ars: cur.ars, usd: cur.usd, basisDate: cur.basisDate || null, basisIsPartial: !!cur.basisIsPartial,
                           endDate: cur.endDate || null, isLive: !!cur.isLive, missing: cur.missing || [],
                           couponArs: cur.couponArs || 0, couponUsd: cur.couponUsd || 0 } : null,
          firstAppMonth: history.firstAppMonth, monthsCount: history.months.length,
          latestDate: book ? book.latestDate : null, isLive: !!(book && book.liveOk), computedAt: new Date().toISOString(),
          sparkline: sparkline
        },
        history: engine.packHistory(history.months),
        statsAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await batch.commit();
      log('recalculado', it.slug + ':', n, 'meses escritos ·', it.versions.length, 'versiones · acum ARS', history.accumulated.ars.toFixed(2) + '%');
    } catch (e) {
      log('ERROR recalculando', it.slug + ':', e.message);
    }
  }
}

// ============================================================
// NOTIFICACIONES PUSH (modo "push")
//   config/push   (lo edita el Panel): enabled{open,close,rotation}, openTime, closeTime,
//                 holidays[], testTo, testAt
//   push_tokens/{uid} (lo escribe la app del cliente): token, accountId, prefs{open,close,rot{slug}}
//   jobs/push     (estado del robot): lastOpen, lastClose, rot{slug: effectiveFrom}, lastTestAt
// Cada corrida es idempotente: un aviso sale una sola vez por día / por rotación.
// ============================================================
function horaART(d) {
  d = d || new Date();
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(11, 16);
}
function minutos(hhmm) { const p = String(hhmm || '').split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
function pctTxt(v) { return engine.fmtPct(v, 2); }
function emojiRiesgo(r) { return r === 1 ? '🟢' : r === 3 ? '🔴' : '🟡'; }

// Manda un aviso a una lista de dispositivos. Borra los tokens que ya no sirven.
async function enviarPush(db, destinos, aviso) {
  if (!destinos.length) return { enviados: 0, fallidos: 0 };
  const data = { title: String(aviso.title), body: String(aviso.body), url: String(aviso.url || ''), tag: String(aviso.tag || 'norte') };
  let ok = 0, mal = 0;
  for (let i = 0; i < destinos.length; i += 500) {
    const lote = destinos.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: lote.map(function (d) { return d.token; }),
      data: data,
      webpush: { headers: { Urgency: 'high', TTL: String(aviso.ttl || 3600) } }
    });
    const borrar = db.batch(); let nb = 0;
    res.responses.forEach(function (r, k) {
      if (r.success) { ok++; return; }
      mal++;
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument') {
        borrar.delete(db.collection('push_tokens').doc(lote[k].id)); nb++;
      } else log('push fallido:', code);
    });
    if (nb) await borrar.commit();
  }
  log('push "' + data.title + '":', ok, 'enviados ·', mal, 'fallidos');
  return { enviados: ok, fallidos: mal };
}

// Rendimiento del día de cada portafolio: del último cierre anterior a hoy hasta el último precio.
async function rendimientosDelDia(db, hoy) {
  const desde = engine.addDays(hoy, -12);
  const qsnap = await db.collection('quotes').where('date', '>=', desde).orderBy('date').get();
  const quotes = qsnap.docs.filter(function (d) { return d.id !== 'live'; }).map(function (d) { return d.data(); })
    .filter(function (q) { return q.date < hoy && q.isEod !== false && !q.noTrading; });
  const liveDoc = await db.collection('quotes').doc('live').get();
  const live = liveDoc.exists ? liveDoc.data() : null;
  if (!live || live.date !== hoy || !quotes.length) return null;      // hoy no hay precios: no se informa
  const prev = quotes[quotes.length - 1];
  // Sin rueda (feriado no cargado): los precios de hoy son idénticos al último cierre.
  const tks = Object.keys(live.prices || {});
  if (tks.length && tks.every(function (t) { return Number(live.prices[t]) === Number((prev.prices || {})[t]); })) return null;
  const pagos = engine.paymentsOf(await catalogoCompleto(db));
  const book = engine.quoteBook(quotes, live, pagos);
  const ports = await db.collection('portfolios').get();
  const filas = [];
  for (const pd of ports.docs) {
    const p = pd.data(); if (!p.name) continue;
    const vsnap = await pd.ref.collection('versions').where('status', '==', 'published').get();
    const versions = vsnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    if (!versions.length) continue;
    const sim = engine.simulate(versions, book, prev.date, { today: hoy });
    if (!sim.segments.length) continue;
    filas.push({ name: p.name, riskLevel: p.riskLevel, order: p.order || 0, ars: sim.accumulated.ars });
  }
  filas.sort(function (a, b) { return a.order - b.order; });
  return { filas: filas, fx: live.fx || null };
}

async function correrPush(db) {
  const cfgDoc = await db.collection('config').doc('push').get();
  const cfg = cfgDoc.exists ? cfgDoc.data() : {};
  const en = cfg.enabled || {};
  const stRef = db.collection('jobs').doc('push');
  const stDoc = await stRef.get();
  const st = stDoc.exists ? stDoc.data() : {};
  const hoy = fechaART(), ahora = minutos(horaART());
  // Los dispositivos se leen sólo si hay algo para mandar (una corrida sin novedades no los toca).
  let _toks = null;
  const dispositivos = async function () {
    if (!_toks) { const tsnap = await db.collection('push_tokens').get(); _toks = tsnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }).filter(function (t) { return t.token; }); }
    return _toks;
  };
  const quiere = function (t, clave) { return !(t.prefs && t.prefs[clave] === false); };
  const out = { enviados: [] }, cambios = {};
  const habil = !esFinDeSemana(hoy) && (cfg.holidays || []).indexOf(hoy) < 0;
  const abre = minutos(cfg.openTime || '10:30'), cierra = minutos(cfg.closeTime || '18:00');

  // --- prueba pedida desde el Panel ---
  if (cfg.testAt && cfg.testAt !== st.lastTestAt) {
    const dest = (await dispositivos()).filter(function (t) { return !cfg.testTo || t.accountId === cfg.testTo; });
    const r = await enviarPush(db, dest, { title: '✅ Prueba de avisos', body: 'Las notificaciones de Norte Inversiones funcionan en este dispositivo.', tag: 'prueba' });
    cambios.lastTestAt = cfg.testAt; cambios.lastTestResult = Object.assign({ at: new Date().toISOString(), destinatarios: dest.length }, r);
    out.enviados.push('prueba');
  }

  // --- apertura ---
  if (en.open !== false && habil && st.lastOpen !== hoy && ahora >= abre && ahora <= abre + 90) {
    await enviarPush(db, (await dispositivos()).filter(function (t) { return quiere(t, 'open'); }),
      { title: '🔔 Abrió el mercado', body: 'Ya opera la rueda en BYMA. Entrá para ver cómo vienen los portafolios.', tag: 'apertura', ttl: 3600 });
    cambios.lastOpen = hoy; out.enviados.push('apertura');
  }

  // --- cierre: rendimiento del día de cada portafolio + dólar ---
  if (en.close !== false && habil && st.lastClose !== hoy && ahora >= cierra + 3 && ahora <= cierra + 240) {
    try { await correrLive(db); await recalcularPortafolios(db); } catch (e) { log('no se pudo refrescar el intradía antes del cierre:', e.message); }
    const dia = await rendimientosDelDia(db, hoy);
    if (dia && dia.filas.length) {
      const lineas = dia.filas.map(function (f) { return emojiRiesgo(f.riskLevel) + ' ' + f.name + ' ' + pctTxt(f.ars); });
      if (dia.fx) lineas.push('💵 MEP ' + engine.fmtArs(dia.fx.mep, 0) + ' · CCL ' + engine.fmtArs(dia.fx.ccl, 0));
      await enviarPush(db, (await dispositivos()).filter(function (t) { return quiere(t, 'close'); }),
        { title: '🔔 Cierre del mercado · ' + engine.fmtDate(hoy).slice(0, 5), body: lineas.join('\n'), tag: 'cierre', ttl: 6 * 3600 });
      out.enviados.push('cierre');
    } else log('cierre: hoy no hubo precios nuevos (¿feriado sin cargar?), no se avisa');
    cambios.lastClose = hoy;
  }

  // --- rotaciones: una notificación por portafolio cuando se publica una rotación nueva ---
  if (en.rotation !== false) {
    const rot = Object.assign({}, st.rot || {}); let tocado = false;
    const ports = await db.collection('portfolios').get();
    for (const pd of ports.docs) {
      const p = pd.data(), slug = pd.id; if (!p.name) continue;
      // Sin novedades (la rotación vigente ya está avisada): no hace falta leer las versiones.
      if (rot[slug] && p.currentEffectiveFrom && p.currentEffectiveFrom <= rot[slug]) continue;
      const vsnap = await pd.ref.collection('versions').where('status', '==', 'published').get();
      const vs = vsnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (v) { return v.effectiveFrom && v.effectiveFrom <= hoy; })
        .sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : 1; });
      if (!vs.length) continue;
      const cur = vs[vs.length - 1], prev = vs.length > 1 ? vs[vs.length - 2] : null;
      if (!rot[slug]) { rot[slug] = cur.effectiveFrom; tocado = true; continue; }   // primera vez: sólo se anota
      if (cur.effectiveFrom <= rot[slug]) continue;                                 // misma fecha = corrección: no se avisa
      const d = engine.diffHoldings(prev, cur), partes = [];
      const lista = function (xs) { return xs.map(function (x) { return x.ticker; }).join(', '); };
      if (d.in.length) partes.push('Entra: ' + lista(d.in));
      if (d.out.length) partes.push('Sale: ' + lista(d.out));
      if (d.up.length) partes.push('Sube: ' + lista(d.up));
      if (d.down.length) partes.push('Baja: ' + lista(d.down));
      await enviarPush(db, (await dispositivos()).filter(function (t) { return !(t.prefs && t.prefs.rot && t.prefs.rot[slug] === false); }),
        { title: emojiRiesgo(p.riskLevel) + ' Nueva rotación · ' + p.name, body: partes.length ? partes.join('\n') : 'Se publicó una nueva composición. Entrá para verla.',
          url: '#/p/' + slug + '/rotaciones', tag: 'rot-' + slug, ttl: 24 * 3600 });
      rot[slug] = cur.effectiveFrom; tocado = true; out.enviados.push('rotación ' + slug);
    }
    if (tocado) cambios.rot = rot;
  }

  // Sólo se escribe el estado si cambió algo (la hora de la última pasada queda en jobs/ingesta).
  if (Object.keys(cambios).length) await stRef.set(cambios, { merge: true });
  return out;
}

// ---------- main ----------
(async function main() {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) {
    console.error('Falta la variable FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  const db = admin.firestore();

  const t0 = Date.now();
  let resultado = null, error = null;
  try {
    resultado = MODE === 'live' ? await correrLive(db) : MODE === 'market' ? await correrMarket(db) : MODE === 'push' ? await correrPush(db) : await correrEod(db);
  } catch (e) {
    error = e.message || String(e);
    log('ERROR:', error);
  }
  if (!error && MODE !== 'market' && MODE !== 'push' && resultado && !resultado.skipped) await recalcularPortafolios(db);
  const registro = {
    at: admin.firestore.FieldValue.serverTimestamp(), ok: !error, error: error,
    ms: Date.now() - t0, result: resultado
  };
  const salud = {};
  salud[MODE] = registro;
  await db.collection('jobs').doc('ingesta').set(salud, { merge: true });
  process.exit(error ? 1 : 0);
})();
