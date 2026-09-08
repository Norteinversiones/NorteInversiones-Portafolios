/* ============================================================
   RECOMPUTE · une la base con el motor. Lo dispara el Panel al publicar o al
   pedir "Recalcular". (La ingesta hace lo mismo en Node después de cada corrida.)
   Escribe portfolios/{slug}/monthly_returns/{ym} y portfolios/{slug}.stats.
   Un mes cerrado no se pisa salvo opts.force (§5.6: inmutable).
   ============================================================ */
(function () {
  var N = window.NORTE;

  N.recompute = async function (slug, opts) {
    opts = opts || {};
    var E = N.engine, db = N.db;
    var versions = await db.getVersions(slug, false);
    var existing = await db.getMonthlyReturns(slug);
    var legacy = existing.filter(function (m) { return m.isLegacy; });

    var computed = { segments: [], months: [] }, book = null;
    if (versions.length) {
      var from = E.addDays(E.monthStart(E.monthOf(versions[0].effectiveFrom)), -10);
      var quotes = await db.getQuotes(from);
      var live = await db.getLiveQuote();
      book = E.quoteBook(quotes, live);
      computed = E.computePortfolio(versions, book, {});
    }

    var toWrite = computed.months.filter(function (m) {
      var ex = null;
      existing.forEach(function (x) { if (x.ym === m.ym) ex = x; });
      return opts.force || !(ex && ex.isClosed && !ex.isLegacy);
    });
    if (toWrite.length) await db.saveMonthlyReturns(slug, toWrite);

    var history = E.buildHistory(legacy, computed.months.map(function (m) {
      // respetar el valor guardado de un mes cerrado que no se reescribió
      var ex = null; existing.forEach(function (x) { if (x.ym === m.ym && x.isClosed && !x.isLegacy) ex = x; });
      return ex && !opts.force ? ex : m;
    }));

    var stats = {
      accArs: history.accumulated.ars, accUsd: history.accumulated.usd,
      yearTotals: history.yearTotals,
      current: history.current ? {
        ym: history.current.ym, ars: history.current.ars, usd: history.current.usd,
        basisDate: history.current.basisDate || null, basisIsPartial: !!history.current.basisIsPartial,
        endDate: history.current.endDate || null, isLive: !!history.current.isLive, missing: history.current.missing || []
      } : null,
      firstAppMonth: history.firstAppMonth, monthsCount: history.months.length,
      latestDate: book ? book.latestDate : null, isLive: !!(book && book.liveOk),
      computedAt: new Date().toISOString()
    };
    await db.saveStats(slug, stats);
    return { history: history, computed: computed, stats: stats };
  };
})();
