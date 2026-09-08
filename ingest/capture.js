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

const MODE = process.argv[2] === 'live' ? 'live' : 'eod';
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
    resultado = MODE === 'live' ? await correrLive(db) : await correrEod(db);
  } catch (e) {
    error = e.message || String(e);
    log('ERROR:', error);
  }
  const registro = {
    at: admin.firestore.FieldValue.serverTimestamp(), ok: !error, error: error,
    ms: Date.now() - t0, result: resultado
  };
  const salud = {};
  salud[MODE] = registro;
  await db.collection('jobs').doc('ingesta').set(salud, { merge: true });
  process.exit(error ? 1 : 0);
})();
