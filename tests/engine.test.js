/* ============================================================
   PRUEBAS DEL MOTOR · corren en Node (node tests/engine.test.js)
   y en el navegador (tests/index.html).
   Casos exigidos por el contexto (§5 y prompt de arranque):
     - mes sin rotación (un solo segmento)
     - mes con rotación en el medio (dos segmentos encadenados)
     - mes con dos rotaciones
     - portafolio dos meses sin cambios → dos rendimientos mensuales distintos
     - encadenamiento de acumulado sobre varios meses
     - rendimiento en USD vía precio_ars / CCL
     - instrumento que no cotizó (arrastre, sin interpolar)
   Más: simulador de fecha de compra, mes en curso con intradía, sin historia
   previa al mes, rotación el 1° del mes, borradores, validación, formato.
   ============================================================ */
(function () {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var E = isNode ? require('../js/engine.js') : window.NORTE.engine;

  var results = [];
  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, err: e.message || String(e) }); }
  }
  function eq(a, b, msg) {
    if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'esperado ' + JSON.stringify(b) + ', obtenido ' + JSON.stringify(a));
  }
  function near(a, b, msg, tol) {
    tol = tol || 1e-6;
    if (a == null || isNaN(a) || Math.abs(a - b) > tol) throw new Error((msg ? msg + ': ' : '') + 'esperado ≈' + b + ', obtenido ' + a);
  }

  // ---------- datos de laboratorio ----------
  function q(date, prices, ccl) { return { date: date, isEod: true, prices: prices, fx: { ccl: ccl, mep: ccl - 50 } }; }
  function H(t, w, px) { return { ticker: t, weightPct: w, buyPriceArs: px, beta: 1 }; }

  // v1: 60% A @100, 40% B @200, rotación 15/08, CCL 1000
  var v1 = { id: 'v1', effectiveFrom: '2026-08-15', cclAtBuy: 1000, status: 'published', holdings: [H('A', 60, 100), H('B', 40, 200)] };
  // v2: 50/50, rotación 15/09, A @115, B @180, CCL 1050
  var v2 = { id: 'v2', effectiveFrom: '2026-09-15', cclAtBuy: 1050, status: 'published', holdings: [H('A', 50, 115), H('B', 50, 180)] };
  // v3: 100% A, rotación 20/09, A @118, CCL 1080
  var v3 = { id: 'v3', effectiveFrom: '2026-09-20', cclAtBuy: 1080, status: 'published', holdings: [H('A', 100, 118)] };

  var qAug31 = q('2026-08-31', { A: 110, B: 190 }, 1000);
  var qSep10 = q('2026-09-10', { A: 112, B: 188 }, 1020);
  var qSep15 = q('2026-09-15', { A: 116, B: 182 }, 1050);
  var qSep20 = q('2026-09-20', { A: 118.5, B: 185 }, 1080);
  var qSep30 = q('2026-09-30', { A: 121, B: 171 }, 1100);
  var qOct31 = q('2026-10-31', { A: 133.1, B: 180 }, 1210);

  // ---------- 1. mes sin rotación ----------
  test('Mes sin rotación: un solo segmento, base = cierre del mes anterior', function () {
    var book = E.quoteBook([qAug31, qSep30]);
    var r = E.computePortfolio([v1], book, { today: '2026-10-05' });
    eq(r.months.length, 2, 'meses');
    var aug = r.months[0], sep = r.months[1];
    eq(aug.ym, '2026-08'); eq(aug.segments, 1);
    near(aug.ars, 4, 'agosto ARS (desde precios de compra)');
    near(aug.usd, 4, 'agosto USD');
    eq(sep.ym, '2026-09'); eq(sep.segments, 1);
    eq(r.segments[1].startBasis, 'close'); eq(r.segments[1].basisDate, '2026-08-31');
    near(sep.ars, 2, 'septiembre ARS');
    near(sep.usd, 0.4 * (171 / 1100 / (190 / 1000) - 1) * 100, 'septiembre USD (A neutro en USD, B cae)');
    eq(sep.isClosed, true); eq(aug.isClosed, true);
  });

  // ---------- 2. rotación en el medio del mes ----------
  test('Rotación entrado el mes: dos segmentos encadenados', function () {
    var book = E.quoteBook([qAug31, qSep15, qSep30]);
    var r = E.computePortfolio([v1, v2], book, { today: '2026-10-05' });
    var segSep = r.segments.filter(function (s) { return s.month === '2026-09'; });
    eq(segSep.length, 2, 'segmentos de septiembre');
    eq(segSep[0].versionId, 'v1'); eq(segSep[0].startBasis, 'close'); eq(segSep[0].dateTo, '2026-09-15'); eq(segSep[0].endDate, '2026-09-15');
    eq(segSep[1].versionId, 'v2'); eq(segSep[1].startBasis, 'buy'); eq(segSep[1].dateFrom, '2026-09-15');
    var r1 = (0.6 * (116 / 110 - 1) + 0.4 * (182 / 190 - 1)) * 100;
    var r2 = (0.5 * (121 / 115 - 1) + 0.5 * (171 / 180 - 1)) * 100;
    near(segSep[0].returnArs, r1, 'segmento 1');
    near(segSep[1].returnArs, r2, 'segmento 2');
    var sep = r.months.filter(function (m) { return m.ym === '2026-09'; })[0];
    near(sep.ars, ((1 + r1 / 100) * (1 + r2 / 100) - 1) * 100, 'mes encadenado (no suma)');
    eq(sep.segments, 2);
  });

  // ---------- 3. dos rotaciones en el mes ----------
  test('Dos rotaciones en el mes: tres segmentos', function () {
    var book = E.quoteBook([qAug31, qSep15, qSep20, qSep30]);
    var r = E.computePortfolio([v1, v2, v3], book, { today: '2026-10-05' });
    var segSep = r.segments.filter(function (s) { return s.month === '2026-09'; });
    eq(segSep.length, 3);
    eq(segSep.map(function (s) { return s.versionId; }).join(','), 'v1,v2,v3');
    eq(segSep[1].dateTo, '2026-09-20'); eq(segSep[2].startBasis, 'buy');
    near(segSep[2].returnArs, (121 / 118 - 1) * 100, 'segmento v3');
    var r1 = 0.6 * (116 / 110 - 1) + 0.4 * (182 / 190 - 1);
    var r2 = 0.5 * (118.5 / 115 - 1) + 0.5 * (185 / 180 - 1);
    var r3 = 121 / 118 - 1;
    var sep = r.months.filter(function (m) { return m.ym === '2026-09'; })[0];
    near(sep.ars, ((1 + r1) * (1 + r2) * (1 + r3) - 1) * 100, 'mes con 3 segmentos');
  });

  // ---------- 4. dos meses sin cambios ----------
  test('Dos meses sin tocar el portafolio: dos rendimientos mensuales con base propia', function () {
    var book = E.quoteBook([qAug31, qSep30, qOct31]);
    var r = E.computePortfolio([v1], book, { today: '2026-11-05' });
    eq(r.months.map(function (m) { return m.ym; }).join(','), '2026-08,2026-09,2026-10');
    var oct = r.months[2];
    eq(r.segments[2].basisDate, '2026-09-30', 'base de octubre = cierre de septiembre');
    near(oct.ars, (0.6 * (133.1 / 121 - 1) + 0.4 * (180 / 171 - 1)) * 100, 'octubre');
    near(r.months[1].ars, 2, 'septiembre no cambia por agregar octubre');
  });

  // ---------- 5. acumulado compuesto ----------
  test('Acumulado: compuesto, nunca suma aritmética', function () {
    near(E.chain([10, -10]), -1, '(1,10)(0,90)−1');
    var h = E.buildHistory(
      [{ ym: '2026-07', ars: 10, usd: 10 }, { ym: '2026-08', ars: -10, usd: -10 }],
      [{ ym: '2026-09', ars: 5, usd: 5, isClosed: true }]
    );
    near(h.accumulated.ars, ((1.1 * 0.9 * 1.05) - 1) * 100, 'acumulado total');
    eq(h.months.length, 3);
    eq(h.months[0].isLegacy, true); eq(h.months[2].isLegacy, false);
    near(h.months[1].accArs, -1, 'acumulado corriente a agosto');
    eq(h.firstAppMonth, '2026-09');
    eq(h.yearTotals.length, 1); eq(h.yearTotals[0].year, '2026');
    near(h.yearTotals[0].ars, h.accumulated.ars, 'total del año = acumulado (un solo año)');
  });

  test('Acumulado: serie legacy real del Conservador (§9) = 51,54% ARS / 31,41% USD', function () {
    var ars = [6.89, 1.99, 9.50, 2.04, 2.80, 3.75, 3.75, 0.66, 0.78, 2.02, 0.98, 6.15, 1.61, -0.26];
    var usd = [-0.31, 2.98, -1.16, 3.82, 3.33, 5.32, 5.32, 3.81, 1.09, 1.94, 0.27, 1.23, 1.24, -1.00];
    near(E.chain(ars), 51.54, 'ARS', 0.05);
    near(E.chain(usd), 31.41, 'USD', 0.05);
  });

  test('Mes calculado pisa al legacy del mismo mes', function () {
    var h = E.buildHistory([{ ym: '2026-09', ars: 1, usd: 1 }], [{ ym: '2026-09', ars: 2, usd: 2, isClosed: false }]);
    eq(h.months.length, 1); near(h.months[0].ars, 2); eq(h.months[0].isLegacy, false);
    eq(h.current.ym, '2026-09', 'mes en curso');
  });

  // ---------- 6. USD vía precio/CCL ----------
  test('USD = precio_ars / CCL: si el CCL dobla junto con el precio, USD = 0%', function () {
    var v = { id: 'x', effectiveFrom: '2026-09-01', cclAtBuy: 1000, status: 'published', holdings: [H('A', 100, 100)] };
    var book = E.quoteBook([q('2026-09-30', { A: 200 }, 2000)]);
    var r = E.computePortfolio([v], book, { today: '2026-10-05' });
    near(r.months[0].ars, 100, 'ARS +100%');
    near(r.months[0].usd, 0, 'USD 0%');
  });

  // ---------- 7. instrumento que no cotizó ----------
  test('Precio rancio: se arrastra el último disponible hacia atrás, sin interpolar', function () {
    var book = E.quoteBook([qAug31, q('2026-09-29', { A: 120, B: 180 }, 1100), q('2026-09-30', { A: 121 }, 1100)]);
    var r = E.computePortfolio([v1], book, { today: '2026-10-05' });
    var sep = r.months[1];
    near(sep.ars, (0.6 * (121 / 110 - 1) + 0.4 * (180 / 190 - 1)) * 100, 'B toma el precio del 29/09');
    eq(sep.missing.length, 0);
    var pb = book.priceAtOrBefore('B', '2026-09-30');
    eq(pb.date, '2026-09-29'); eq(pb.price, 180);
  });

  test('Instrumento sin ningún precio: se excluye y se informa en missing', function () {
    var v = { id: 'x', effectiveFrom: '2026-09-01', cclAtBuy: 1000, status: 'published',
              holdings: [H('A', 60, 100), H('B', 30, 200), H('C', 10, 50)] };
    var book = E.quoteBook([q('2026-09-30', { A: 110, B: 220 }, 1000)]);
    var r = E.computePortfolio([v], book, { today: '2026-10-05' });
    eq(r.months[0].missing.join(','), 'C');
    near(r.segments[0].weightUsed, 90);
    near(r.months[0].ars, (0.6 * 0.1 + 0.3 * 0.1) * 100, 'C pesa 0 de variación');
  });

  // ---------- 8. mes en curso con intradía ----------
  test('Mes en curso: cierra en la última cotización (intradía) y no está cerrado', function () {
    var live = { date: '2026-09-20', isEod: false, prices: { A: 130, B: 200 }, fx: { ccl: 1200 } };
    var book = E.quoteBook([qAug31, q('2026-09-19', { A: 125, B: 195 }, 1150)], live);
    eq(book.liveOk, true);
    var r = E.computePortfolio([v1], book, { today: '2026-09-20' });
    var sep = r.months[1];
    eq(sep.isClosed, false); eq(sep.isLive, true); eq(sep.endDate, '2026-09-20');
    near(sep.ars, (0.6 * (130 / 110 - 1) + 0.4 * (200 / 190 - 1)) * 100, 'usa el intradía');
    eq(r.months[0].isClosed, true, 'agosto sí está cerrado');
  });

  test('Intradía del mismo día que el último cierre: gana el cierre', function () {
    var live = { date: '2026-09-19', isEod: false, prices: { A: 999, B: 999 }, fx: { ccl: 1150 } };
    var book = E.quoteBook([qAug31, q('2026-09-19', { A: 125, B: 195 }, 1150)], live);
    eq(book.liveOk, false);
    eq(book.priceLatest('A').price, 125);
  });

  // ---------- 9. simulador de fecha de compra ----------
  test('Simulador: arranca en la fecha elegida (cierre) y sigue las rotaciones posteriores', function () {
    var book = E.quoteBook([qAug31, qSep10, qSep15, qSep30]);
    var s = E.simulate([v1, v2], book, '2026-09-10', { today: '2026-10-05' });
    eq(s.basisDate, '2026-09-10'); eq(s.segments.length, 2); eq(s.rotations, 1);
    eq(s.segments[0].startBasis, 'from'); eq(s.segments[1].startBasis, 'buy');
    var r1 = 0.6 * (116 / 112 - 1) + 0.4 * (182 / 188 - 1);
    var r2 = 0.5 * (121 / 115 - 1) + 0.5 * (171 / 180 - 1);
    near(s.accumulated.ars, ((1 + r1) * (1 + r2) - 1) * 100, 'estimado encadenado');
    eq(s.months.length, 1);
  });

  test('Simulador: fecha sin cierre toma el cierre anterior disponible', function () {
    var book = E.quoteBook([qAug31, qSep10, qSep30]);
    var s = E.simulate([v1], book, '2026-09-12', { today: '2026-10-05' });
    eq(s.basisDate, '2026-09-10');
    near(s.accumulated.ars, (0.6 * (121 / 112 - 1) + 0.4 * (171 / 188 - 1)) * 100);
  });

  test('Simulador: fecha anterior a la primera versión → arranca en la rotación con precios de compra', function () {
    var book = E.quoteBook([qAug31, qSep30]);
    var s = E.simulate([v1], book, '2026-08-01', { today: '2026-10-05' });
    eq(s.segments[0].startBasis, 'buy'); eq(s.basisDate, '2026-08-15');
    eq(E.minSimulationDate([v1], book), '2026-08-31', 'fecha mínima = inicio de la captura');
  });

  // ---------- 10. sin historia previa al mes ----------
  test('Sin cierres antes del mes: la base es el primer cierre disponible y se informa', function () {
    var v = { id: 'x', effectiveFrom: '2026-08-10', cclAtBuy: 1000, status: 'published', holdings: [H('A', 60, 100), H('B', 40, 200)] };
    var book = E.quoteBook([q('2026-09-07', { A: 100, B: 200 }, 1000), q('2026-09-30', { A: 110, B: 210 }, 1000)]);
    var r = E.computePortfolio([v], book, { today: '2026-10-05' });
    eq(r.months.length, 1, 'agosto no se puede medir (sin precios): no aparece');
    eq(r.months[0].ym, '2026-09');
    eq(r.months[0].basisDate, '2026-09-07'); eq(r.months[0].basisIsPartial, true);
    near(r.months[0].ars, (0.6 * 0.1 + 0.4 * 0.05) * 100);
  });

  // ---------- 11. rotación el primer día del mes ----------
  test('Rotación el 1° del mes: el mes tiene un solo segmento con base = precios de compra', function () {
    var vOct = { id: 'vo', effectiveFrom: '2026-10-01', cclAtBuy: 1100, status: 'published', holdings: [H('A', 100, 121)] };
    var book = E.quoteBook([qAug31, qSep30, qOct31]);
    var r = E.computePortfolio([v1, vOct], book, { today: '2026-11-05' });
    var oct = r.segments.filter(function (s) { return s.month === '2026-10'; });
    eq(oct.length, 1); eq(oct[0].versionId, 'vo'); eq(oct[0].startBasis, 'buy');
    var sep = r.segments.filter(function (s) { return s.month === '2026-09'; });
    eq(sep.length, 1); eq(sep[0].versionId, 'v1'); eq(sep[0].dateTo, '2026-09-30');
    near(oct[0].returnArs, (133.1 / 121 - 1) * 100);
  });

  // ---------- 12. borradores ----------
  test('Los borradores no cuentan salvo que se pidan', function () {
    var draft = Object.assign({}, v2, { id: 'd', status: 'draft' });
    var book = E.quoteBook([qAug31, qSep15, qSep30]);
    eq(E.computePortfolio([v1, draft], book, { today: '2026-10-05' }).segments.filter(function (s) { return s.month === '2026-09'; }).length, 1);
    eq(E.computePortfolio([v1, draft], book, { today: '2026-10-05', includeDrafts: true }).segments.filter(function (s) { return s.month === '2026-09'; }).length, 2);
  });

  test('Una versión reemplazada por una corrección no cuenta nunca', function () {
    var replaced = Object.assign({}, v2, { id: 'r', status: 'replaced' });
    var book = E.quoteBook([qAug31, qSep15, qSep30]);
    eq(E.computePortfolio([v1, replaced], book, { today: '2026-10-05', includeDrafts: true }).segments.filter(function (s) { return s.month === '2026-09'; }).length, 1);
  });

  // ---------- 13. tenencias en vivo ----------
  test('Tenencias en vivo: variación desde el precio de compra en ARS y USD', function () {
    var live = { date: '2026-09-20', isEod: false, prices: { A: 130 }, fx: { ccl: 1300 } };
    var book = E.quoteBook([qAug31, q('2026-09-19', { A: 125, B: 195 }, 1150)], live);
    var hs = E.holdingsLive(v1, book);
    eq(hs[0].ticker, 'A'); near(hs[0].varArs, 30); near(hs[0].varUsd, 0); eq(hs[0].isLive, true); eq(hs[0].stale, false);
    eq(hs[1].ticker, 'B'); near(hs[1].varArs, -2.5); eq(hs[1].asOf, '2026-09-19'); eq(hs[1].stale, true, 'B no tiene intradía: rancio');
  });

  // ---------- 14. composición ----------
  test('Beta ponderada, suma de pesos y composición por tipo', function () {
    var hs = [{ ticker: 'A', weightPct: 60, beta: 0.5 }, { ticker: 'B', weightPct: 40, beta: 1.5 }];
    near(E.betaPortfolio(hs), 0.9);
    eq(E.weightTotal(hs), 100);
    var c = E.compositionByType(hs, { A: { type: 'CEDEAR' }, B: { type: 'BONO_SOBERANO' } });
    eq(c[0].type, 'CEDEAR'); eq(c[0].weightPct, 60); eq(c[1].weightPct, 40);
    // Beta real del Conservador (§4.1) = 0,295
    var cons = [[20, .10], [10, .97], [20, .10], [15, .30], [15, .30], [10, .58], [10, .10]]
      .map(function (x, i) { return { ticker: 't' + i, weightPct: x[0], beta: x[1] }; });
    near(E.betaPortfolio(cons), 0.295, 'beta Conservador', 1e-9);
  });

  // ---------- 15. validación ----------
  test('Validación: 105% bloquea, 100% pasa', function () {
    var bad = { effectiveFrom: '2026-09-03', cclAtBuy: 1586.38, holdings: [H('A', 60, 100), H('B', 45, 200)] };
    var errs = E.validateVersion(bad, ['A', 'B']);
    eq(errs.length, 1); eq(errs[0].indexOf('105') > 0, true, errs[0]);
    var good = { effectiveFrom: '2026-09-03', cclAtBuy: 1586.38, holdings: [H('A', 60, 100), H('B', 40, 200)] };
    eq(E.validateVersion(good, ['A', 'B']).length, 0);
    var errs2 = E.validateVersion({ effectiveFrom: '2026-08-01', cclAtBuy: 1, holdings: [H('Z', 100, 0)] }, ['A'], { effectiveFrom: '2026-09-01' });
    eq(errs2.length, 3, errs2.join(' | ')); // no está en catálogo, precio 0, fecha anterior a la previa
  });

  // ---------- 16. formato ----------
  test('Formato argentino', function () {
    eq(E.fmtNum(1586.38), '1.586,38');
    eq(E.fmtNum(-1234567.891, 1), '−1.234.567,9');
    eq(E.fmtPct(6.891), '+6,89%'); eq(E.fmtPct(-0.26), '−0,26%'); eq(E.fmtPct(-0.001), '0,00%'); eq(E.fmtPct(3.14159, 1), '+3,1%');
    eq(E.fmtArs(36700), '$36.700,00'); eq(E.fmtUsd(468.86), 'US$468,86');
    eq(E.fmtDate('2026-09-07'), '07/09/2026'); eq(E.fmtMonth('2026-09'), "Sep '26"); eq(E.fmtMonthLong('2025-12'), 'Diciembre 2025');
    eq(E.monthEnd('2026-02'), '2026-02-28'); eq(E.monthEnd('2028-02'), '2028-02-29'); eq(E.monthEnd('2026-12'), '2026-12-31');
    eq(E.nextMonth('2026-12'), '2027-01'); eq(E.addDays('2026-03-01', -1), '2026-02-28');
    eq(E.monthsBetween('2025-11', '2026-02').join(','), '2025-11,2025-12,2026-01,2026-02');
    eq(E.isWeekend('2026-09-05'), true); eq(E.isWeekend('2026-09-07'), false);
  });

  // ---------- reporte ----------
  var fails = results.filter(function (r) { return !r.ok; });
  if (isNode) {
    results.forEach(function (r) { console.log((r.ok ? '  ok  ' : ' FAIL ') + r.name + (r.ok ? '' : '\n        ' + r.err)); });
    console.log('\n' + (results.length - fails.length) + '/' + results.length + ' pruebas OK');
    process.exit(fails.length ? 1 : 0);
  } else {
    window.NORTE_TEST_RESULTS = results;
    if (typeof document !== 'undefined' && document.getElementById('out')) {
      var out = document.getElementById('out');
      out.innerHTML = '<h2 class="' + (fails.length ? 'bad' : 'good') + '">' + (results.length - fails.length) + '/' + results.length + ' pruebas OK</h2>' +
        results.map(function (r) {
          return '<div class="t ' + (r.ok ? 'ok' : 'fail') + '"><b>' + (r.ok ? '✔' : '✘') + '</b> ' + r.name +
            (r.ok ? '' : '<pre>' + r.err.replace(/</g, '&lt;') + '</pre>') + '</div>';
        }).join('');
    }
  }
})();
