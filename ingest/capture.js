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

const MODE = process.argv[2] === 'live' ? 'live' : process.argv[2] === 'market' ? 'market' : 'eod';
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
async function cargarCatalogo(db) {
  const snap = await db.collection('instruments').get();
  if (!snap.empty) {
    return snap.docs
      .map(function (d) { return Object.assign({ ticker: d.id }, d.data()); })
      .filter(function (i) { return i.isActive !== false; });
  }
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
}

// Precios de los tickers del catálogo, resueltos por priceSymbol.
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

async function recalcularPortafolios(db) {
  const ports = await db.collection('portfolios').get();
  for (const pd of ports.docs) {
    const slug = pd.id;
    try {
      const vsnap = await pd.ref.collection('versions').where('status', '==', 'published').get();
      const versions = vsnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : 1; });
      const msnap = await pd.ref.collection('monthly_returns').get();
      const existing = msnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const legacy = existing.filter(function (m) { return m.isLegacy; });

      let computed = { months: [] }, book = null;
      if (versions.length) {
        const from = engine.addDays(engine.monthStart(engine.monthOf(versions[0].effectiveFrom)), -10);
        const qsnap = await db.collection('quotes').where('date', '>=', from).orderBy('date').get();
        const quotes = qsnap.docs.filter(function (d) { return d.id !== 'live'; }).map(function (d) { return d.data(); });
        const liveDoc = await db.collection('quotes').doc('live').get();
        book = engine.quoteBook(quotes, liveDoc.exists ? liveDoc.data() : null);
        computed = engine.computePortfolio(versions, book, {});
      }

      const batch = db.batch();
      let n = 0;
      const merged = computed.months.map(function (m) {
        const ex = existing.find(function (x) { return x.ym === m.ym; });
        if (ex && ex.isClosed && !ex.isLegacy) return ex;       // mes cerrado: inmutable
        batch.set(pd.ref.collection('monthly_returns').doc(m.ym), {
          ym: m.ym, ars: m.ars, usd: m.usd, isLegacy: false, isClosed: !!m.isClosed, segments: m.segments,
          basisDate: m.basisDate || null, basisIsPartial: !!m.basisIsPartial, endDate: m.endDate || null,
          isLive: !!m.isLive, missing: m.missing || [], computedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        n++;
        return m;
      });
      const history = engine.buildHistory(legacy, merged);
      const cur = history.current;
      // Sparkline de la home: acumulado día a día de los últimos 30 días (mismo motor, calculado acá
      // para no cargarle el cálculo al navegador del cliente). null si no hay 2 puntos.
      const sparkline = book ? engine.dailySeries(versions, book, { days: 30 }) : null;
      batch.set(pd.ref, {
        stats: {
          accArs: history.accumulated.ars, accUsd: history.accumulated.usd, yearTotals: history.yearTotals,
          current: cur ? { ym: cur.ym, ars: cur.ars, usd: cur.usd, basisDate: cur.basisDate || null, basisIsPartial: !!cur.basisIsPartial,
                           endDate: cur.endDate || null, isLive: !!cur.isLive, missing: cur.missing || [] } : null,
          firstAppMonth: history.firstAppMonth, monthsCount: history.months.length,
          latestDate: book ? book.latestDate : null, isLive: !!(book && book.liveOk), computedAt: new Date().toISOString(),
          sparkline: sparkline
        },
        statsAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await batch.commit();
      log('recalculado', slug + ':', n, 'meses escritos ·', versions.length, 'versiones · acum ARS', history.accumulated.ars.toFixed(2) + '%');
    } catch (e) {
      log('ERROR recalculando', slug + ':', e.message);
    }
  }
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
    resultado = MODE === 'live' ? await correrLive(db) : MODE === 'market' ? await correrMarket(db) : await correrEod(db);
  } catch (e) {
    error = e.message || String(e);
    log('ERROR:', error);
  }
  if (!error && MODE !== 'market' && resultado && !resultado.skipped) await recalcularPortafolios(db);
  const registro = {
    at: admin.firestore.FieldValue.serverTimestamp(), ok: !error, error: error,
    ms: Date.now() - t0, result: resultado
  };
  const salud = {};
  salud[MODE] = registro;
  await db.collection('jobs').doc('ingesta').set(salud, { merge: true });
  process.exit(error ? 1 : 0);
})();
