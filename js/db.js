/* ============================================================
   DB · acceso a Firestore (SDK compat por CDN, sin bundler).
   Lo usan el Panel (admin.html) y la app cliente (index.html).
   Ninguna función de acá calcula rendimientos: sólo lee y escribe.

   Colecciones:
     instruments/{ticker}
     quotes/{YYYY-MM-DD} · quotes/live · (quotes_all sólo la ingesta)
     portfolios/{slug}                       + campo stats (resumen calculado)
     portfolios/{slug}/versions/{id}         una por rotación
     portfolios/{slug}/monthly_returns/{ym}  legacy + calculados
     authorized_accounts/{ALYC_COMITENTE}
     education/{slug}
     jobs/ingesta
   ============================================================ */
(function () {
  var N = window.NORTE = window.NORTE || {};
  var db = null;

  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function docs(snap) { return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); }
  function byField(f) { return function (a, b) { return (a[f] || 0) < (b[f] || 0) ? -1 : (a[f] || 0) > (b[f] || 0) ? 1 : 0; }; }
  function clean(o) { // Firestore no acepta undefined
    var out = {};
    Object.keys(o).forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; });
    return out;
  }
  function accountId(alyc, comitente) {
    return String(alyc || '').trim().toUpperCase() + '_' + String(comitente || '').trim().replace(/\D/g, '');
  }
  async function batched(items, fn) { // fn(batch, item) · lotes de 400
    for (var i = 0; i < items.length; i += 400) {
      var b = db.batch();
      items.slice(i, i + 400).forEach(function (it) { fn(b, it); });
      await b.commit();
    }
  }

  N.db = {
    init: function () {
      if (!firebase.apps.length) firebase.initializeApp(N.firebaseConfig);
      db = firebase.firestore();
      return firebase.auth();
    },
    accountId: accountId,

    // ---------- catálogo ----------
    getInstruments: async function () {
      return docs(await db.collection('instruments').get())
        .map(function (x) { x.ticker = x.id; return x; })
        .sort(byField('order'));
    },
    saveInstrument: async function (ins) {
      var id = String(ins.ticker).trim().toUpperCase();
      await db.collection('instruments').doc(id).set(clean(Object.assign({}, ins, { ticker: id, updatedAt: ts() })), { merge: true });
      return id;
    },

    // ---------- portafolios ----------
    getPortfolios: async function () {
      return docs(await db.collection('portfolios').get()).map(function (p) { p.slug = p.id; return p; }).sort(byField('order'));
    },
    // Siembra (o completa) los 3 portafolios. Borra campos de la app vieja si quedaron.
    seedPortfolios: async function () {
      var del = firebase.firestore.FieldValue.delete();
      var b = db.batch();
      N.SEED.portfolios.forEach(function (p) {
        b.set(db.collection('portfolios').doc(p.slug), Object.assign({}, p, {
          createdAt: ts(), nombre: del, holdings: del, ejemplo: del
        }), { merge: true });
      });
      await b.commit();
    },
    savePortfolio: async function (slug, data) {
      await db.collection('portfolios').doc(slug).set(clean(Object.assign({}, data, { updatedAt: ts() })), { merge: true });
    },
    saveStats: async function (slug, stats) {
      await db.collection('portfolios').doc(slug).set({ stats: stats, statsAt: ts() }, { merge: true });
    },

    // ---------- versiones (rotaciones) ----------
    // all=true (admin) trae borradores; si no, sólo publicadas (la regla lo exige).
    getVersions: async function (slug, all) {
      var col = db.collection('portfolios').doc(slug).collection('versions');
      var snap = all ? await col.get() : await col.where('status', '==', 'published').get();
      return docs(snap).sort(byField('effectiveFrom'));
    },
    saveVersion: async function (slug, id, data) {
      var col = db.collection('portfolios').doc(slug).collection('versions');
      var payload = clean(Object.assign({}, data, { updatedAt: ts() }));
      if (id) { await col.doc(id).set(payload, { merge: true }); return id; }
      payload.createdAt = ts();
      var ref = await col.add(payload);
      return ref.id;
    },
    deleteVersion: async function (slug, id) {
      await db.collection('portfolios').doc(slug).collection('versions').doc(id).delete();
    },
    // Publica un borrador: cierra la versión anterior (effectiveTo) y marca la vigente.
    publishVersion: async function (slug, draft, user) {
      var col = db.collection('portfolios').doc(slug).collection('versions');
      var published = docs(await col.where('status', '==', 'published').get()).sort(byField('effectiveFrom'));
      var b = db.batch();
      published.forEach(function (v) {
        if (v.effectiveFrom < draft.effectiveFrom && (!v.effectiveTo || v.effectiveTo > draft.effectiveFrom)) {
          b.set(col.doc(v.id), { effectiveTo: draft.effectiveFrom, updatedAt: ts() }, { merge: true });
        }
      });
      b.set(col.doc(draft.id), {
        status: 'published', effectiveTo: null, publishedAt: ts(), publishedBy: user || null, updatedAt: ts()
      }, { merge: true });
      var last = published.filter(function (v) { return v.effectiveFrom > draft.effectiveFrom; });
      if (!last.length) {
        b.set(db.collection('portfolios').doc(slug), { currentVersionId: draft.id, currentEffectiveFrom: draft.effectiveFrom, updatedAt: ts() }, { merge: true });
      }
      await b.commit();
    },

    // ---------- cotizaciones ----------
    getLiveQuote: async function () {
      var d = await db.collection('quotes').doc('live').get();
      return d.exists ? d.data() : null;
    },
    // Cierres desde `fromDate` (inclusive). El doc "live" también tiene `date`: se filtra.
    getQuotes: async function (fromDate) {
      var q = db.collection('quotes').orderBy('date');
      if (fromDate) q = q.where('date', '>=', fromDate);
      return docs(await q.get()).filter(function (x) { return x.id !== 'live' && x.isEod !== false; });
    },
    getLastQuotes: async function (n) {
      return docs(await db.collection('quotes').orderBy('date', 'desc').limit(n || 5).get())
        .filter(function (x) { return x.id !== 'live'; });
    },
    getQuote: async function (date) {
      var d = await db.collection('quotes').doc(date).get();
      return d.exists ? d.data() : null;
    },
    // Cierre cargado a mano (apertura de mes, feriado mal detectado, etc.).
    saveManualQuote: async function (date, prices, fx, user) {
      await db.collection('quotes').doc(date).set({
        date: date, isEod: true, source: 'manual', prices: prices, fx: fx, stale: {}, missing: [],
        n: Object.keys(prices).length, manualBy: user || null, capturedAt: ts()
      });
    },

    // ---------- rendimientos mensuales ----------
    getMonthlyReturns: async function (slug) {
      return docs(await db.collection('portfolios').doc(slug).collection('monthly_returns').get()).sort(byField('ym'));
    },
    saveMonthlyReturns: async function (slug, list) {
      var col = db.collection('portfolios').doc(slug).collection('monthly_returns');
      await batched(list, function (b, m) {
        b.set(col.doc(m.ym), clean({
          ym: m.ym, ars: m.ars, usd: m.usd, isLegacy: !!m.isLegacy, isClosed: !!m.isClosed,
          segments: m.segments || 0, basisDate: m.basisDate || null, basisIsPartial: !!m.basisIsPartial,
          endDate: m.endDate || null, isLive: !!m.isLive, missing: m.missing || [], computedAt: ts()
        }), { merge: true });
      });
    },
    deleteMonthlyReturn: async function (slug, ym) {
      await db.collection('portfolios').doc(slug).collection('monthly_returns').doc(ym).delete();
    },

    // ---------- comitentes ----------
    listAccounts: async function () {
      return docs(await db.collection('authorized_accounts').get()).sort(function (a, b) {
        return (a.clientName || '').localeCompare(b.clientName || '', 'es');
      });
    },
    getAccount: async function (alyc, comitente) {
      var d = await db.collection('authorized_accounts').doc(accountId(alyc, comitente)).get();
      return d.exists ? Object.assign({ id: d.id }, d.data()) : null;
    },
    saveAccount: async function (a) {
      var id = accountId(a.alyc, a.comitente);
      await db.collection('authorized_accounts').doc(id).set(clean({
        alyc: String(a.alyc).trim().toUpperCase(), comitente: String(a.comitente).trim().replace(/\D/g, ''),
        clientName: (a.clientName || '').trim(), isActive: a.isActive !== false, updatedAt: ts()
      }), { merge: true });
      return id;
    },
    importAccounts: async function (list) {
      await batched(list, function (b, a) {
        b.set(db.collection('authorized_accounts').doc(accountId(a.alyc, a.comitente)), clean({
          alyc: String(a.alyc).trim().toUpperCase(), comitente: String(a.comitente).trim().replace(/\D/g, ''),
          clientName: (a.clientName || '').trim(), isActive: true, updatedAt: ts()
        }), { merge: true });
      });
    },
    deleteAccount: async function (id) { await db.collection('authorized_accounts').doc(id).delete(); },

    // ---------- fichas ----------
    getEducation: async function (all) {
      var col = db.collection('education');
      var snap = all ? await col.get() : await col.where('isPublished', '==', true).get();
      return docs(snap).map(function (c) { c.slug = c.id; return c; }).sort(byField('order'));
    },
    saveEducation: async function (card) {
      await db.collection('education').doc(card.slug).set(clean(Object.assign({}, card, { updatedAt: ts() })), { merge: true });
    },

    // ---------- salud ----------
    getJobHealth: async function () {
      var d = await db.collection('jobs').doc('ingesta').get();
      return d.exists ? d.data() : null;
    }
  };
})();
