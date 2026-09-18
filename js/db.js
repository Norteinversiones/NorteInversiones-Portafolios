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
      // La app cliente no carga el SDK de Auth (no lo necesita).
      return typeof firebase.auth === 'function' ? firebase.auth() : null;
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
        if (v.id === draft.id) return;
        if (v.effectiveFrom === draft.effectiveFrom) {
          // Corrección: la versión con la misma fecha queda reemplazada (invisible para clientes y motor).
          b.set(col.doc(v.id), { status: 'replaced', replacedBy: draft.id, replacedAt: ts(), updatedAt: ts() }, { merge: true });
        } else if (v.effectiveFrom < draft.effectiveFrom && (!v.effectiveTo || v.effectiveTo > draft.effectiveFrom)) {
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

    // Restaura una versión reemplazada: vuelve a "published" y manda a "replaced" a las
    // publicadas con la misma fecha. Si es la más nueva, pasa a ser la vigente.
    restoreVersion: async function (slug, id) {
      var col = db.collection('portfolios').doc(slug).collection('versions');
      var all = docs(await col.get());
      var target = all.filter(function (v) { return v.id === id; })[0];
      if (!target) throw new Error('Versión no encontrada');
      var b = db.batch();
      all.forEach(function (v) {
        if (v.id !== id && v.status === 'published' && v.effectiveFrom === target.effectiveFrom) {
          b.set(col.doc(v.id), { status: 'replaced', replacedBy: id, replacedAt: ts(), updatedAt: ts() }, { merge: true });
        }
      });
      var later = all.filter(function (v) { return v.id !== id && v.status === 'published' && v.effectiveFrom > target.effectiveFrom; })
        .sort(byField('effectiveFrom'));
      b.set(col.doc(id), {
        status: 'published', effectiveTo: later.length ? later[0].effectiveFrom : null,
        replacedBy: firebase.firestore.FieldValue.delete(), replacedAt: firebase.firestore.FieldValue.delete(), updatedAt: ts()
      }, { merge: true });
      if (!later.length) b.set(db.collection('portfolios').doc(slug), { currentVersionId: id, currentEffectiveFrom: target.effectiveFrom, updatedAt: ts() }, { merge: true });
      await b.commit();
    },
    // Manda una versión publicada a "replaced" (duplicados). Si era la vigente, la vigente pasa a la publicada más nueva.
    retireVersion: async function (slug, id) {
      var col = db.collection('portfolios').doc(slug).collection('versions');
      var all = docs(await col.get());
      var b = db.batch();
      b.set(col.doc(id), { status: 'replaced', replacedAt: ts(), updatedAt: ts() }, { merge: true });
      var rest = all.filter(function (v) { return v.id !== id && v.status === 'published'; }).sort(byField('effectiveFrom'));
      var cur = rest.length ? rest[rest.length - 1] : null;
      b.set(db.collection('portfolios').doc(slug), { currentVersionId: cur ? cur.id : null, currentEffectiveFrom: cur ? cur.effectiveFrom : null, updatedAt: ts() }, { merge: true });
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

    // ---------- clientes (gestor) ----------
    // clients/{id}: name, nameNormalized, greeting, greetingReview, type, accounts[{alyc, comitente, capital}],
    //               cotitulares[], dni, phone, email, notes, isActive
    // Cada cuenta se refleja en authorized_accounts/{ALYC_COMITENTE} (índice de login).
    listClients: async function () {
      return docs(await db.collection('clients').get()).sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'es'); });
    },
    // Guarda el cliente y sincroniza sus cuentas en authorized_accounts (borra las que ya no tiene).
    saveClient: async function (c) {
      var id = c.id || db.collection('clients').doc().id;
      var accounts = (c.accounts || []).filter(function (a) { return a.alyc && String(a.comitente).replace(/\D/g, ''); })
        .map(function (a) { return { alyc: String(a.alyc).toUpperCase(), comitente: String(a.comitente).replace(/\D/g, ''), capital: Number(a.capital) || 0 }; });
      var prev = c.id ? await db.collection('clients').doc(id).get() : null;
      var prevAcc = prev && prev.exists ? (prev.data().accounts || []) : [];
      var b = db.batch();
      b.set(db.collection('clients').doc(id), clean({
        name: (c.name || '').trim(), nameNormalized: c.nameNormalized || N.clientes.nombreNormalizado(c.name), greeting: (c.greeting || '').trim(),
        greetingReview: !!c.greetingReview, type: c.type === 'PJ' ? 'PJ' : 'PH', accounts: accounts, cotitulares: c.cotitulares || [],
        dni: c.dni || '', phone: c.phone || '', email: c.email || '', notes: c.notes || '', isActive: c.isActive !== false,
        createdAt: c.id ? undefined : ts(), updatedAt: ts()
      }), { merge: true });
      accounts.forEach(function (a) {
        b.set(db.collection('authorized_accounts').doc(accountId(a.alyc, a.comitente)), {
          alyc: a.alyc, comitente: a.comitente, clientId: id, clientName: (c.name || '').trim(), greeting: (c.greeting || '').trim(),
          isActive: c.isActive !== false, updatedAt: ts()
        }, { merge: true });
      });
      prevAcc.forEach(function (a) {
        if (!accounts.some(function (x) { return x.alyc === a.alyc && x.comitente === a.comitente; })) b.delete(db.collection('authorized_accounts').doc(accountId(a.alyc, a.comitente)));
      });
      await b.commit();
      return id;
    },
    deleteClient: async function (c) {
      var b = db.batch();
      (c.accounts || []).forEach(function (a) { b.delete(db.collection('authorized_accounts').doc(accountId(a.alyc, a.comitente))); });
      b.delete(db.collection('clients').doc(c.id));
      await b.commit();
    },
    // Une dos clientes: las cuentas de `drop` pasan a `keep`; `drop` se borra.
    mergeClients: async function (keep, drop) {
      var accounts = (keep.accounts || []).slice();
      (drop.accounts || []).forEach(function (a) { if (!accounts.some(function (x) { return x.alyc === a.alyc && x.comitente === a.comitente; })) accounts.push(a); });
      var merged = Object.assign({}, keep, { accounts: accounts, cotitulares: (keep.cotitulares || []).concat(drop.cotitulares || []),
        notes: [keep.notes, drop.notes].filter(Boolean).join('\n') });
      await db.collection('clients').doc(drop.id).delete();
      await N.db.saveClient(merged);
    },
    // Importación: lista de clientes agrupados (sin id). Si una cuenta ya existe, actualiza el capital del cliente
    // que la tiene; si el nombre normalizado ya existe, agrega las cuentas nuevas a ese cliente.
    importClients: async function (grupos) {
      var existentes = await N.db.listClients();
      var porNombre = {}, porCuenta = {};
      existentes.forEach(function (c) { porNombre[c.nameNormalized] = c; (c.accounts || []).forEach(function (a) { porCuenta[a.alyc + '_' + a.comitente] = c; }); });
      var nuevos = 0, actualizados = 0;
      for (var i = 0; i < grupos.length; i++) {
        var g = grupos[i], target = porNombre[g.nameNormalized];
        if (!target) { for (var k = 0; k < g.accounts.length; k++) { var t = porCuenta[g.accounts[k].alyc + '_' + g.accounts[k].comitente]; if (t) { target = t; break; } } }
        if (target) {
          var accounts = (target.accounts || []).slice();
          g.accounts.forEach(function (a) {
            var ex = null; accounts.forEach(function (x) { if (x.alyc === a.alyc && x.comitente === a.comitente) ex = x; });
            if (ex) ex.capital = a.capital; else accounts.push(a);
          });
          await N.db.saveClient(Object.assign({}, target, { accounts: accounts }));
          actualizados++;
        } else {
          var id = await N.db.saveClient(g);
          porNombre[g.nameNormalized] = Object.assign({ id: id }, g);
          nuevos++;
        }
      }
      return { nuevos: nuevos, actualizados: actualizados };
    },
    // Cuentas del índice de login que no pertenecen a ningún cliente (p. ej. cuentas de prueba viejas).
    listOrphanAccounts: async function () {
      return docs(await db.collection('authorized_accounts').get()).filter(function (a) { return !a.clientId; });
    },

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
