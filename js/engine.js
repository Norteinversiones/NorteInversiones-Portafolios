/* ============================================================
   ENGINE · Motor de rendimientos · Norte Inversiones
   ÚNICO lugar de la app donde se calculan rendimientos (§5 del contexto).
   Funciones puras: sin DOM, sin Firestore, sin fetch. Recibe datos, devuelve números.

   Funciona en el navegador (window.NORTE.engine) y en Node (module.exports),
   así las pruebas corren en los dos lados.

   Convenciones
   - Fechas: strings "YYYY-MM-DD" (se comparan como texto). Meses: "YYYY-MM".
   - Retornos: en porcentaje (6.89 = +6,89 %).
   - Pesos: en porcentaje (weightPct, suman 100).
   - Valor en USD de cualquier activo = precio_ars / CCL del mismo día (§5.3).

   Reglas implementadas
   - Unidad de medición: mes calendario (§5.1). Cada mes se parte en segmentos
     por cada rotación que cae adentro (§5.2). Cada segmento tiene una sola versión.
   - r_segmento = Σ w_i · (P_i(fin) / P_i(inicio) − 1)
   - r_mes      = Π (1 + r_segmento) − 1
   - acumulado  = Π (1 + r_mes) − 1   (compuesto; nunca suma aritmética, §5.4)
   - Precio de INICIO de un segmento:
       · si el segmento arranca en la fecha de rotación → precios de compra de la versión
         (y CCL del día de compra) — es lo que efectivamente se pagó;
       · si arranca con el mes → último cierre ANTERIOR al mes (el cierre del mes previo);
         si no hay historia previa → primer cierre disponible del mes (basisDate lo informa);
       · si arranca en una fecha simulada (§8) → cierre de ese día (o el anterior disponible).
   - Precio de FIN de un segmento: cierre del día de fin (rotación o fin de mes). Para
     el segmento abierto: última cotización disponible (intradía si es más nueva que el
     último cierre).
   - Precios rancios: se toma el último cierre disponible hacia atrás, nunca se interpola.
     Si un activo no tiene precio en ninguno de los dos extremos, se excluye del segmento
     y se informa en `missing` (su peso cuenta como variación 0; no se renormaliza).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NORTE = root.NORTE || {}; root.NORTE.engine = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------
  // Fechas
  // ------------------------------------------------------------
  function todayART(now) {
    now = now || new Date();
    return new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function addDays(d, n) {
    var t = new Date(d + 'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function monthOf(d) { return d.slice(0, 7); }
  function monthStart(ym) { return ym + '-01'; }
  function monthEnd(ym) {
    var p = ym.split('-'); var y = Number(p[0]), m = Number(p[1]);
    return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
  }
  function nextMonth(ym) {
    var p = ym.split('-'); var y = Number(p[0]), m = Number(p[1]);
    return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  }
  function monthsBetween(a, b) {
    var out = []; var m = a;
    while (m <= b) { out.push(m); m = nextMonth(m); }
    return out;
  }
  function isWeekend(d) { var dow = new Date(d + 'T12:00:00Z').getUTCDay(); return dow === 0 || dow === 6; }
  function isValidDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(new Date(d + 'T12:00:00Z').getTime()); }

  // ------------------------------------------------------------
  // Libro de cotizaciones: índice sobre los docs `quotes/{fecha}` + `quotes/live`
  // ------------------------------------------------------------
  function quoteBook(quotes, live) {
    var eod = (quotes || [])
      .filter(function (q) { return q && q.prices && q.date && q.isEod !== false && !q.noTrading; })
      .slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    function idxAtOrBefore(date) {
      var lo = 0, hi = eod.length - 1, ans = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (eod[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    }
    function idxAtOrAfter(date) {
      var lo = 0, hi = eod.length - 1, ans = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (eod[mid].date >= date) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
      return ans;
    }
    function dayAtOrBefore(date) { var i = idxAtOrBefore(date); return i >= 0 ? eod[i] : null; }
    function dayAtOrAfter(date) { var i = idxAtOrAfter(date); return i >= 0 ? eod[i] : null; }

    // Último precio disponible de `ticker` en `date` o antes (arrastre, sin interpolar).
    function priceAtOrBefore(ticker, date, maxBack) {
      maxBack = maxBack || 30;
      var i = idxAtOrBefore(date), n = 0;
      while (i >= 0 && n < maxBack) {
        var q = eod[i], p = Number(q.prices[ticker]);
        if (p > 0) return { price: p, date: q.date, ccl: q.fx ? Number(q.fx.ccl) : null };
        i--; n++;
      }
      return null;
    }

    var lastDate = eod.length ? eod[eod.length - 1].date : null;
    // El intradía sólo vale si es más nuevo que el último cierre (mismo día: gana el cierre).
    var liveOk = !!(live && live.prices && live.date && (!lastDate || live.date > lastDate));

    function priceLatest(ticker) {
      if (liveOk) {
        var p = Number(live.prices[ticker]);
        if (p > 0) return { price: p, date: live.date, ccl: live.fx ? Number(live.fx.ccl) : null, isLive: true };
      }
      if (!lastDate) return null;
      var r = priceAtOrBefore(ticker, lastDate);
      if (r) r.isLive = false;
      return r;
    }

    return {
      eod: eod,
      firstDate: eod.length ? eod[0].date : null,
      lastDate: lastDate,
      liveOk: liveOk,
      live: liveOk ? live : null,
      latestDate: liveOk ? live.date : lastDate,
      dayAtOrBefore: dayAtOrBefore,
      dayAtOrAfter: dayAtOrAfter,
      priceAtOrBefore: priceAtOrBefore,
      priceLatest: priceLatest
    };
  }

  // ------------------------------------------------------------
  // Mapas de precios {ticker: {ars, usd, date}} para un conjunto de tenencias
  // ------------------------------------------------------------
  function pxFromBuy(version, book) {
    var m = {};
    var ccl = Number(version.cclAtBuy) || null;
    if (!ccl && book) { var d = book.dayAtOrBefore(version.effectiveFrom); if (d && d.fx) ccl = Number(d.fx.ccl) || null; }
    (version.holdings || []).forEach(function (h) {
      var ars = Number(h.buyPriceArs);
      if (ars > 0) m[h.ticker] = { ars: ars, usd: ccl ? ars / ccl : null, date: version.effectiveFrom };
    });
    return m;
  }
  function pxAtOrBefore(book, holdings, date) {
    var m = {};
    holdings.forEach(function (h) {
      var r = book.priceAtOrBefore(h.ticker, date);
      if (r) m[h.ticker] = { ars: r.price, usd: r.ccl > 0 ? r.price / r.ccl : null, date: r.date };
    });
    return m;
  }
  function pxLatest(book, holdings) {
    var m = {};
    holdings.forEach(function (h) {
      var r = book.priceLatest(h.ticker);
      if (r) m[h.ticker] = { ars: r.price, usd: r.ccl > 0 ? r.price / r.ccl : null, date: r.date, isLive: !!r.isLive };
    });
    return m;
  }

  // r = Σ w_i (P_fin / P_ini − 1), en ARS y USD.
  function segmentReturn(holdings, startPx, endPx) {
    var rArs = 0, rUsd = 0, wUsed = 0, missing = [];
    holdings.forEach(function (h) {
      var w = (Number(h.weightPct) || 0) / 100;
      var a = startPx[h.ticker], b = endPx[h.ticker];
      if (!a || !b || !(a.ars > 0) || !(b.ars > 0)) { missing.push(h.ticker); return; }
      rArs += w * (b.ars / a.ars - 1);
      if (a.usd > 0 && b.usd > 0) rUsd += w * (b.usd / a.usd - 1);
      wUsed += w;
    });
    return { ars: rArs * 100, usd: rUsd * 100, weightUsed: wUsed * 100, missing: missing };
  }

  function chain(returnsPct) {
    var f = 1;
    returnsPct.forEach(function (r) { f *= 1 + (Number(r) || 0) / 100; });
    return (f - 1) * 100;
  }

  // ------------------------------------------------------------
  // Segmentos (§5.2)
  //   versions: [{id, effectiveFrom, cclAtBuy, status, holdings:[{ticker, weightPct, buyPriceArs}]}]
  //   book:     quoteBook(...)
  //   opts:     { today, from, to, includeDrafts }
  //     from → simulador de fecha de compra (§8): el primer segmento arranca en `from`
  //            con precios de cierre de ese día, y sigue todas las rotaciones posteriores.
  // ------------------------------------------------------------
  function computeSegments(versions, book, opts) {
    opts = opts || {};
    var today = opts.today || todayART();
    var vs = (versions || [])
      // Sólo versiones publicadas (o borradores si se piden). Las reemplazadas por una
      // corrección (status "replaced") nunca cuentan.
      .filter(function (v) { return v && v.effectiveFrom && (v.status === 'published' || !v.status || (v.status === 'draft' && opts.includeDrafts)); })
      .slice()
      .sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0; });
    if (!vs.length) return [];

    var from = opts.from || null;
    var lastDate = opts.to && opts.to < today ? opts.to : today;
    var firstDate = from && from > vs[0].effectiveFrom ? from : vs[0].effectiveFrom;
    if (firstDate > lastDate) return [];

    var segs = [];
    monthsBetween(monthOf(firstDate), monthOf(lastDate)).forEach(function (ym) {
      var mStart = monthStart(ym), mEnd = monthEnd(ym);

      vs.forEach(function (v, i) {
        var nextFrom = vs[i + 1] ? vs[i + 1].effectiveFrom : null;

        var s = v.effectiveFrom > mStart ? v.effectiveFrom : mStart;
        if (from && from > s) s = from;
        var e = mEnd;
        if (nextFrom && nextFrom < e) e = nextFrom;
        if (lastDate < e) e = lastDate;

        if (nextFrom && nextFrom <= s) return;   // versión ya reemplazada
        if (v.effectiveFrom > e) return;         // versión todavía no vigente
        if (s > e) return;

        var holdings = v.holdings || [];
        var startPx, startBasis, basisDate;

        if (s === v.effectiveFrom) {
          startBasis = 'buy';
          basisDate = v.effectiveFrom;
          startPx = pxFromBuy(v, book);
        } else if (from && s === from) {
          startBasis = 'from';
          var dq = book.dayAtOrBefore(from);
          if (!dq) { dq = book.dayAtOrAfter(from); }
          if (!dq || dq.date > e) return;
          basisDate = dq.date;
          startPx = pxAtOrBefore(book, holdings, dq.date);
        } else {
          startBasis = 'close';
          var prev = book.dayAtOrBefore(addDays(mStart, -1));
          if (prev) {
            basisDate = prev.date;
            startPx = pxAtOrBefore(book, holdings, prev.date);
          } else {
            // Sin historia previa al mes: se arranca en el primer cierre disponible.
            var first = book.dayAtOrAfter(mStart);
            if (!first || first.date > e) return;
            basisDate = first.date;
            startPx = pxAtOrBefore(book, holdings, first.date);
          }
        }

        var endPx, endDate, isLive = false;
        if (!book.lastDate || e >= book.lastDate) {
          endPx = pxLatest(book, holdings);
          endDate = book.latestDate;
          isLive = !!book.liveOk;
        } else {
          var ed = book.dayAtOrBefore(e);
          if (!ed) return;                       // no hay ningún cierre para valuar el fin
          endPx = pxAtOrBefore(book, holdings, e);
          endDate = ed.date;
        }
        if (!endDate || endDate < basisDate) return;
        // Un segmento que arranca en un cierre y termina en ese mismo cierre no mide nada
        // (típico: mes en curso sin cotizaciones todavía). El de rotación sí vale el mismo día.
        if (startBasis !== 'buy' && endDate <= basisDate) return;

        var r = segmentReturn(holdings, startPx, endPx);
        segs.push({
          month: ym, versionId: v.id || null, dateFrom: s, dateTo: e,
          startBasis: startBasis, basisDate: basisDate, endDate: endDate,
          returnArs: r.ars, returnUsd: r.usd, weightUsed: r.weightUsed, missing: r.missing,
          isLive: isLive, isClosed: e < today && !isLive
        });
      });
    });
    return segs;
  }

  // ------------------------------------------------------------
  // Meses: encadena los segmentos de cada mes (§5.2) → [{ym, ars, usd, isClosed, ...}]
  // ------------------------------------------------------------
  function monthlyFromSegments(segments, today) {
    today = today || todayART();
    var byMonth = {};
    segments.forEach(function (s) { (byMonth[s.month] = byMonth[s.month] || []).push(s); });
    return Object.keys(byMonth).sort().map(function (ym) {
      var ss = byMonth[ym];
      var missing = [];
      ss.forEach(function (s) { s.missing.forEach(function (t) { if (missing.indexOf(t) < 0) missing.push(t); }); });
      return {
        ym: ym,
        ars: chain(ss.map(function (s) { return s.returnArs; })),
        usd: chain(ss.map(function (s) { return s.returnUsd; })),
        segments: ss.length,
        basisDate: ss[0].basisDate,
        basisIsPartial: ss[0].startBasis === 'close' && ss[0].basisDate >= monthStart(ym),
        endDate: ss[ss.length - 1].endDate,
        isLive: ss.some(function (s) { return s.isLive; }),
        isClosed: monthEnd(ym) < today && ss.every(function (s) { return s.isClosed; }),
        isLegacy: false,
        missing: missing
      };
    });
  }

  // Cálculo completo de un portafolio: segmentos + meses.
  function computePortfolio(versions, book, opts) {
    var segs = computeSegments(versions, book, opts);
    return { segments: segs, months: monthlyFromSegments(segs, (opts && opts.today) || todayART()) };
  }

  // ------------------------------------------------------------
  // Histórico: serie legacy (§9) + meses calculados por la app → acumulado compuesto (§5.4)
  //   legacy: [{ym, ars, usd}]  computed: salida de monthlyFromSegments
  // ------------------------------------------------------------
  function buildHistory(legacy, computed) {
    var map = {};
    (legacy || []).forEach(function (m) {
      map[m.ym] = { ym: m.ym, ars: Number(m.ars), usd: Number(m.usd), isLegacy: true, isClosed: true, segments: 0, missing: [] };
    });
    (computed || []).forEach(function (m) { map[m.ym] = Object.assign({}, m, { isLegacy: false }); });

    var months = Object.keys(map).sort().map(function (k) { return map[k]; });
    var fA = 1, fU = 1;
    months.forEach(function (m) {
      fA *= 1 + (m.ars || 0) / 100; fU *= 1 + (m.usd || 0) / 100;
      m.accArs = (fA - 1) * 100; m.accUsd = (fU - 1) * 100;
    });

    var years = {};
    months.forEach(function (m) {
      var y = m.ym.slice(0, 4);
      var yr = years[y] = years[y] || { year: y, fA: 1, fU: 1, months: 0 };
      yr.fA *= 1 + (m.ars || 0) / 100; yr.fU *= 1 + (m.usd || 0) / 100; yr.months++;
    });
    var yearTotals = Object.keys(years).sort().map(function (y) {
      return { year: y, ars: (years[y].fA - 1) * 100, usd: (years[y].fU - 1) * 100, months: years[y].months };
    });

    var firstApp = null;
    for (var i = 0; i < months.length; i++) if (!months[i].isLegacy) { firstApp = months[i].ym; break; }

    return {
      months: months,
      accumulated: { ars: (fA - 1) * 100, usd: (fU - 1) * 100 },
      yearTotals: yearTotals,
      firstAppMonth: firstApp,
      current: months.length && !months[months.length - 1].isClosed ? months[months.length - 1] : null
    };
  }

  // ------------------------------------------------------------
  // Simulador de fecha de compra (§8): rendimiento estimado de seguir la estrategia
  // desde `from` hasta la última cotización, encadenando todas las rotaciones.
  // Efímero: esta función no persiste nada; el estado vive sólo en la pantalla.
  // ------------------------------------------------------------
  function simulate(versions, book, from, opts) {
    opts = Object.assign({}, opts || {}, { from: from });
    var segs = computeSegments(versions, book, opts);
    var months = monthlyFromSegments(segs, opts.today || todayART());
    var acc = { ars: chain(segs.map(function (s) { return s.returnArs; })), usd: chain(segs.map(function (s) { return s.returnUsd; })) };
    return {
      from: from,
      basisDate: segs.length ? segs[0].basisDate : null,
      endDate: segs.length ? segs[segs.length - 1].endDate : null,
      segments: segs, months: months, accumulated: acc,
      rotations: segs.filter(function (s) { return s.startBasis === 'buy'; }).length
    };
  }

  // Fecha mínima seleccionable en el simulador: la más tardía entre el inicio de la
  // captura de precios y la primera versión cargada en la app.
  function minSimulationDate(versions, book) {
    var vs = (versions || []).filter(function (v) { return v.status !== 'draft'; })
      .map(function (v) { return v.effectiveFrom; }).sort();
    var a = vs[0] || null, b = book.firstDate || null;
    if (!a || !b) return a || b;
    return a > b ? a : b;
  }

  // ------------------------------------------------------------
  // Tenencias en vivo (detalle de portafolio): variación desde el precio de compra
  // ------------------------------------------------------------
  function holdingsLive(version, book) {
    var buy = pxFromBuy(version, book);
    var now = pxLatest(book, version.holdings || []);
    return (version.holdings || []).map(function (h) {
      var a = buy[h.ticker], b = now[h.ticker];
      return {
        ticker: h.ticker, weightPct: Number(h.weightPct) || 0, beta: Number(h.beta) || 0,
        buyArs: a ? a.ars : null, buyUsd: a ? a.usd : null,
        nowArs: b ? b.ars : null, nowUsd: b ? b.usd : null,
        asOf: b ? b.date : null, isLive: !!(b && b.isLive),
        stale: !!(b && book.latestDate && b.date < book.latestDate),
        varArs: a && b && a.ars > 0 ? (b.ars / a.ars - 1) * 100 : null,
        varUsd: a && b && a.usd > 0 && b.usd > 0 ? (b.usd / a.usd - 1) * 100 : null
      };
    });
  }

  // ------------------------------------------------------------
  // Derivados de la composición (§5.6)
  // ------------------------------------------------------------
  function betaPortfolio(holdings) {
    var b = 0;
    (holdings || []).forEach(function (h) { b += (Number(h.weightPct) || 0) / 100 * (Number(h.beta) || 0); });
    return b;
  }
  function weightTotal(holdings) {
    var t = 0;
    (holdings || []).forEach(function (h) { t += Number(h.weightPct) || 0; });
    return Math.round(t * 1e6) / 1e6;
  }
  // instrumentsByTicker: {ticker: {type}} → [{type, weightPct}] ordenado desc.
  function compositionByType(holdings, instrumentsByTicker) {
    var m = {};
    (holdings || []).forEach(function (h) {
      var ins = instrumentsByTicker && instrumentsByTicker[h.ticker];
      var t = ins && ins.type ? ins.type : 'OTRO';
      m[t] = (m[t] || 0) + (Number(h.weightPct) || 0);
    });
    return Object.keys(m).map(function (t) { return { type: t, weightPct: m[t] }; })
      .sort(function (a, b) { return b.weightPct - a.weightPct; });
  }

  // ------------------------------------------------------------
  // Validación de una versión antes de publicar (§4, §11)
  // ------------------------------------------------------------
  function validateVersion(version, catalogTickers, previousVersion) {
    var errors = [];
    var hs = (version && version.holdings) || [];
    if (!version || !isValidDate(version.effectiveFrom)) errors.push('La fecha de rotación es obligatoria (AAAA-MM-DD).');
    if (!hs.length) errors.push('La versión no tiene tenencias.');
    var total = weightTotal(hs);
    if (Math.abs(total - 100) > 1e-6) errors.push('Las ponderaciones suman ' + fmtNum(total, 2) + '% y deben sumar exactamente 100%.');
    var seen = {};
    hs.forEach(function (h) {
      if (!h.ticker) { errors.push('Hay una fila sin ticker.'); return; }
      if (seen[h.ticker]) errors.push('El ticker ' + h.ticker + ' está repetido.');
      seen[h.ticker] = true;
      if (catalogTickers && catalogTickers.indexOf(h.ticker) < 0) errors.push('El ticker ' + h.ticker + ' no está en el catálogo.');
      if (!(Number(h.weightPct) > 0)) errors.push(h.ticker + ': la ponderación debe ser mayor que 0.');
      if (!(Number(h.buyPriceArs) > 0)) errors.push(h.ticker + ': el precio de compra debe ser mayor que 0.');
    });
    if (!(Number(version && version.cclAtBuy) > 0)) errors.push('Falta el CCL del día de la rotación.');
    if (previousVersion && previousVersion.effectiveFrom && version && version.effectiveFrom
        && version.effectiveFrom < previousVersion.effectiveFrom) {
      errors.push('La fecha de rotación no puede ser anterior a la versión previa (' + fmtDate(previousVersion.effectiveFrom) + ').');
    }
    return errors;
  }

  // ------------------------------------------------------------
  // Formato argentino
  // ------------------------------------------------------------
  function fmtNum(v, dec) {
    if (v == null || isNaN(v)) return '—';
    dec = dec == null ? 2 : dec;
    var s = Math.abs(Number(v)).toFixed(dec);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (Number(v) < 0 ? '−' : '') + parts.join(',');
  }
  function fmtPct(v, dec) {
    if (v == null || isNaN(v)) return '—';
    dec = dec == null ? 2 : dec;
    var n = Number(v);
    // Evita "−0,00%"
    if (Math.abs(n) < Math.pow(10, -dec) / 2) n = 0;
    return (n > 0 ? '+' : '') + fmtNum(n, dec) + '%';
  }
  function fmtArs(v, dec) { if (v == null || isNaN(v)) return '—'; return '$' + fmtNum(v, dec == null ? 2 : dec); }
  function fmtUsd(v, dec) { if (v == null || isNaN(v)) return '—'; return 'US$' + fmtNum(v, dec == null ? 2 : dec); }
  function fmtDate(d) { if (!d || d.length < 10) return '—'; return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4); }
  var MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  function fmtMonth(ym) { if (!ym) return '—'; return MESES[Number(ym.slice(5, 7)) - 1] + " '" + ym.slice(2, 4); }
  function fmtMonthLong(ym) {
    var L = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    if (!ym) return '—'; return L[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
  }

  return {
    // fechas
    todayART: todayART, addDays: addDays, monthOf: monthOf, monthStart: monthStart, monthEnd: monthEnd,
    nextMonth: nextMonth, monthsBetween: monthsBetween, isWeekend: isWeekend, isValidDate: isValidDate,
    // núcleo
    quoteBook: quoteBook, computeSegments: computeSegments, monthlyFromSegments: monthlyFromSegments,
    computePortfolio: computePortfolio, buildHistory: buildHistory, chain: chain,
    simulate: simulate, minSimulationDate: minSimulationDate, holdingsLive: holdingsLive,
    // composición
    betaPortfolio: betaPortfolio, weightTotal: weightTotal, compositionByType: compositionByType,
    validateVersion: validateVersion,
    // formato
    fmtNum: fmtNum, fmtPct: fmtPct, fmtArs: fmtArs, fmtUsd: fmtUsd, fmtDate: fmtDate, fmtMonth: fmtMonth, fmtMonthLong: fmtMonthLong
  };
}));
