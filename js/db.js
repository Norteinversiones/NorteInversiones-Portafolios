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
     authorized_accounts/{ALYC_COMITENTE}    índice de login: SIN nombre completo (es legible desde afuera)
     sessions/{uid}                          con qué comitente entró cada sesión de cliente
     config/push · push_tokens/{uid}         notificaciones (ajustes y dispositivos suscriptos)
     education/{slug}
     jobs/ingesta
   ============================================================ */
(function () {
  var N = window.NORTE = window.NORTE || {};
  var db = null, auth = null, closing = null;

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
  // Saludo corto a partir de un nombre completo (nunca devuelve el nombre entero).
  function saludoDe(nombre, alyc) {
    nombre = String(nombre || '').trim();
    if (!nombre) return '';
    if (N.clientes && N.clientes.saludoSugerido) { try { return N.clientes.saludoSugerido(nombre, alyc, 'PH').saludo || ''; } catch (e) { } }
    return nombre.split(/[\s,]+/)[0];
  }
  // ---------- caché local (ahorra lecturas de Firestore) ----------
  // Se guarda en el navegador lo que no cambia (o cambia poco) para no volver a pedirlo.
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { try { localStorage.removeItem(k); } catch (x) { } } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }
  // Firestore devuelve fechas como objetos Timestamp: para guardarlas en caché se pasan a milisegundos.
  function plano(o) {
    if (o == null || typeof o !== 'object') return o;
    if (typeof o.toMillis === 'function') return o.toMillis();
    if (Array.isArray(o)) return o.map(plano);
    var r = {}; Object.keys(o).forEach(function (k) { r[k] = plano(o[k]); }); return r;
  }
  function inc() { return firebase.firestore.FieldValue.increment(1); }

  async function batched(items, fn) { // fn(batch, item) · lotes de 400
    for (var i = 0; i < items.length; i += 400) {
      var b = db.batch();
      items.slice(i, i + 400).forEach(function (it) { fn(b, it); });
      await b.commit();
    }
  }

  N.db = {
    // appName: la app cliente usa una instancia propia ('cliente') para que su sesión anónima
    // no se mezcle con el login de Google del Panel (comparten dominio).
    init: function (appName) {
      var app;
      try { app = appName ? firebase.app(appName) : firebase.app(); }
      catch (e) { app = appName ? firebase.initializeApp(N.firebaseConfig, appName) : firebase.initializeApp(N.firebaseConfig); }
      db = app.firestore();
      auth = typeof app.auth === 'function' ? app.auth() : null;
      return auth;
    },
    accountId: accountId, cache: { get: lsGet, set: lsSet, del: lsDel, plano: plano },

    // ---------- sesión del cliente ----------
    // El cliente entra con una identidad anónima de Firebase y registra en sessions/{uid}
    // con qué comitente entró. Las reglas sólo dejan leer los portafolios a quien tenga
    // una sesión que apunte a una cuenta autorizada y activa.
    // Devuelve el uid, o null si no se pudo (p. ej. el acceso anónimo todavía no está habilitado).
    ensureAnon: async function () {
      if (!auth) return null;
      try {
        if (closing) await closing; // si se está cerrando la sesión anterior, esperar a que termine
        if (!auth.currentUser) {
          await new Promise(function (ok) { var off = auth.onAuthStateChanged(function () { off(); ok(); }); });
        }
        if (!auth.currentUser) await auth.signInAnonymously();
        return auth.currentUser ? auth.currentUser.uid : null;
      } catch (e) { console.warn('Sesión anónima no disponible:', e.code || e.message); return null; }
    },
    // forzar=true (ingreso con comitente): escribe siempre, aunque haya una marca local.
    openSession: async function (alyc, comitente, forzar) {
      var uid = await N.db.ensureAnon();
      if (!uid) return false;
      // La sesión queda guardada en Firestore; sólo se reescribe una vez por día (registra el
      // último ingreso) o si cambió la cuenta. Así abrir la app no gasta una escritura cada vez.
      var id = accountId(alyc, comitente), marca = lsGet('norte_ses_ok');
      if (!forzar && marca && marca.uid === uid && marca.id === id && Date.now() - marca.at < 20 * 3600e3) return true;
      try {
        await db.collection('sessions').doc(uid).set({ accountId: id, at: ts() });
        lsSet('norte_ses_ok', { uid: uid, id: id, at: Date.now() });
        return true;
      } catch (e) { console.warn('No se pudo registrar la sesión:', e.code || e.message); return false; }
    },
    closeSession: function () {
      lsDel('norte_ses_ok');
      if (!auth || !auth.currentUser) return Promise.resolve();
      var uid = auth.currentUser.uid;
      closing = db.collection('sessions').doc(uid).delete().catch(function () { })
        .then(function () { return auth.signOut(); }).catch(function () { })
        .then(function () { closing = null; });
      return closing;
    },

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
    // Catálogo para la app de clientes y el robot: UN solo documento (config/catalog) con todos los
    // instrumentos, en vez de leer uno por uno. Lo mantiene el Panel (syncCatalog). Si todavía no
    // existe o no se puede leer, se usa la colección completa como antes.
    getCatalog: async function () {
      try {
        var d = await db.collection('config').doc('catalog').get();
        if (d.exists && Array.isArray(d.data().items) && d.data().items.length) return { items: d.data().items.slice().sort(byField('order')), quotesRev: d.data().quotesRev || 0, fromMirror: true };
      } catch (e) { }
      return { items: await N.db.getInstruments(), quotesRev: 0, fromMirror: false };
    },
    // (Panel) Deja config/catalog igual a la colección instruments. Sólo escribe si cambió algo.
    syncCatalog: async function (instruments) {
      var items = (instruments || []).map(function (i) {
        return clean({ ticker: i.ticker, name: i.name, type: i.type, order: i.order, isActive: i.isActive, priceSymbol: i.priceSymbol, underlying: i.underlying,
          cedearRatio: i.cedearRatio, usdBasis: i.usdBasis, educationSlug: i.educationSlug, payments: i.payments && i.payments.length ? i.payments : undefined });
      });
      var ref = db.collection('config').doc('catalog'), cur = await ref.get();
      if (cur.exists && JSON.stringify(cur.data().items || []) === JSON.stringify(items)) return false;
      await ref.set({ items: items, n: items.length, updatedAt: ts() }, { merge: true });
      return true;
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
    // history: copia de todos los meses (legacy + calculados) dentro del documento del portafolio,
    // para que la app de clientes y el robot no tengan que leer monthly_returns mes por mes.
    saveStats: async function (slug, stats, history) {
      var data = { stats: stats, statsAt: ts() };
      if (history) data.history = history;
      await db.collection('portfolios').doc(slug).set(data, { merge: true });
    },

    // ---------- versiones (rotaciones) ----------
    // all=true (admin) trae borradores; si no, sólo publicadas (la regla lo exige).
    getVersions: async function (slug, all) {
      var col = db.collection('portfolios').doc(slug).collection('versions');
      var snap = all ? await col.get() : await col.where('status', '==', 'published').get();
      return docs(snap).sort(byField('effectiveFrom'));
    },
    // (App de clientes) Versiones publicadas con caché local: sólo se vuelven a leer de Firestore
    // cuando el portafolio cambió (rev = versionsRev + versión vigente del documento del portafolio).
    getVersionsCached: async function (slug, rev) {
      var k = 'norte_vs_' + slug, c = lsGet(k);
      if (c && c.rev === rev && Array.isArray(c.list)) return c.list;
      var list = plano(await N.db.getVersions(slug, false));
      lsSet(k, { rev: rev, list: list });
      return list;
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
      // versionsRev: contador que le avisa a la app de clientes que tiene que volver a leer las versiones.
      b.set(db.collection('portfolios').doc(slug), { versionsRev: inc() }, { merge: true });
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
      b.set(db.collection('portfolios').doc(slug), { versionsRev: inc() }, { merge: true });
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
      b.set(db.collection('portfolios').doc(slug), { currentVersionId: cur ? cur.id : null, currentEffectiveFrom: cur ? cur.effectiveFrom : null, versionsRev: inc(), updatedAt: ts() }, { merge: true });
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
    // (App de clientes) Cierres desde `fromDate` con caché local. Un cierre viejo no cambia, así que
    // se guarda en el navegador y sólo se piden a Firestore los días nuevos (y se repasan los últimos
    // 4 días, por si el robot corrigió un cierre reciente). `rev` (config/catalog.quotesRev) cambia
    // cuando se carga un cierre a mano desde el Panel: ahí se descarta lo guardado.
    getQuotesCached: async function (fromDate, rev) {
      var k = 'norte_quotes', c = lsGet(k);
      if (!c || c.rev !== (rev || 0) || !c.from || !Array.isArray(c.list)) c = { rev: rev || 0, from: null, list: [] };
      var pedirDesde;
      if (!c.from || fromDate < c.from) { pedirDesde = fromDate; c.list = []; c.from = fromDate; }   // falta historia más vieja: se pide todo el tramo
      else { var ult = c.list.length ? c.list[c.list.length - 1].date : c.from; var d = new Date(ult + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 4); pedirDesde = d.toISOString().slice(0, 10); if (pedirDesde < c.from) pedirDesde = c.from; }
      var nuevos = plano(await N.db.getQuotes(pedirDesde)).map(function (q) { return { date: q.date, isEod: q.isEod, noTrading: q.noTrading, prices: q.prices, fx: q.fx }; });
      c.list = c.list.filter(function (q) { return q.date < pedirDesde; }).concat(nuevos);
      lsSet(k, c);
      return c.list.filter(function (q) { return q.date >= fromDate; });
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
      // Un cierre cargado a mano puede pisar uno ya guardado en el navegador de los clientes: se avisa.
      await db.collection('config').doc('catalog').set({ quotesRev: inc() }, { merge: true });
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
          endDate: m.endDate || null, isLive: !!m.isLive, missing: m.missing || [],
          couponArs: m.couponArs || 0, couponUsd: m.couponUsd || 0, payments: m.payments || [], computedAt: ts()
        }), { merge: true });
      });
    },
    deleteMonthlyReturn: async function (slug, ym) {
      await db.collection('portfolios').doc(slug).collection('monthly_returns').doc(ym).delete();
    },

    // ---------- comitentes ----------
    listAccounts: async function () {
      return docs(await db.collection('authorized_accounts').get()).sort(function (a, b) {
        return (a.greeting || a.clientName || '').localeCompare(b.greeting || b.clientName || '', 'es');
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
        greeting: saludoDe(a.clientName, a.alyc), clientName: firebase.firestore.FieldValue.delete(), isActive: a.isActive !== false, updatedAt: ts()
      }), { merge: true });
      return id;
    },
    importAccounts: async function (list) {
      await batched(list, function (b, a) {
        b.set(db.collection('authorized_accounts').doc(accountId(a.alyc, a.comitente)), clean({
          alyc: String(a.alyc).trim().toUpperCase(), comitente: String(a.comitente).trim().replace(/\D/g, ''),
          greeting: saludoDe(a.clientName, a.alyc), clientName: firebase.firestore.FieldValue.delete(), isActive: true, updatedAt: ts()
        }), { merge: true });
      });
    },
    deleteAccount: async function (id) { await db.collection('authorized_accounts').doc(id).delete(); },

    // ---------- clientes (gestor) ----------
    // clients/{id}: name, nameNormalized, greeting, greetingReview, type, accounts[{alyc, comitente, capital}],
    //               cotitulares[], dni, phone, email, notes, isActive,
    //               referredBy (nombre de quien lo refirió), referredByClientId (si ese referidor es cliente)
    // Cada cuenta se refleja en authorized_accounts/{ALYC_COMITENTE} (índice de login).
    // El referido es dato interno: NO se copia a authorized_accounts, así la app de clientes no lo ve.
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
        // Referido: si quien guarda no trae el campo, `clean` lo saca y el merge deja
        // intacto el que ya estuviera cargado (no se puede borrar sin querer).
        referredBy: c.referredBy === undefined ? undefined : String(c.referredBy || '').trim(),
        referredByClientId: c.referredByClientId === undefined ? undefined : (c.referredByClientId || ''),
        createdAt: c.id ? undefined : ts(), updatedAt: ts()
      }), { merge: true });
      accounts.forEach(function (a) {
        b.set(db.collection('authorized_accounts').doc(accountId(a.alyc, a.comitente)), {
          // Sólo el saludo: el nombre completo NO va acá (este índice se puede consultar desde afuera).
          alyc: a.alyc, comitente: a.comitente, clientId: id, greeting: (c.greeting || '').trim(),
          clientName: firebase.firestore.FieldValue.delete(),
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
    // Limpieza (una vez): saca el nombre completo de las cuentas del índice de login que todavía lo
    // tengan. Si la cuenta no tenía saludo, usa el del cliente o uno sugerido. Devuelve cuántas tocó.
    scrubAccountNames: async function (clients) {
      var saludos = {};
      (clients || []).forEach(function (c) { saludos[c.id] = (c.greeting || '').trim(); });
      var sucias = docs(await db.collection('authorized_accounts').get()).filter(function (a) { return a.clientName !== undefined; });
      await batched(sucias, function (b, a) {
        b.set(db.collection('authorized_accounts').doc(a.id), {
          clientName: firebase.firestore.FieldValue.delete(),
          greeting: (a.greeting || '').trim() || saludos[a.clientId] || saludoDe(a.clientName, a.alyc)
        }, { merge: true });
      });
      return sucias.length;
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

    // ---------- notificaciones push ----------
    // config/push: ajustes (Panel) · push_tokens/{uid}: dispositivo de un cliente · jobs/push: estado del robot.
    uid: function () { return auth && auth.currentUser ? auth.currentUser.uid : null; },
    getPushConfig: async function () {
      var d = await db.collection('config').doc('push').get();
      return d.exists ? d.data() : null;
    },
    savePushConfig: async function (data) {
      await db.collection('config').doc('push').set(clean(Object.assign({}, data, { updatedAt: ts() })), { merge: true });
    },
    getMyPush: async function () {
      var uid = N.db.uid(); if (!uid) return null;
      var d = await db.collection('push_tokens').doc(uid).get();
      return d.exists ? d.data() : null;
    },
    saveMyPush: async function (data) {
      var uid = N.db.uid(); if (!uid) throw new Error('sin sesión');
      await db.collection('push_tokens').doc(uid).set({ token: data.token, accountId: data.accountId, prefs: data.prefs, updatedAt: ts() });
    },
    deleteMyPush: async function () {
      var uid = N.db.uid(); if (!uid) return;
      await db.collection('push_tokens').doc(uid).delete();
    },
    listPushTokens: async function () { return docs(await db.collection('push_tokens').get()); },
    getPushState: async function () {
      var d = await db.collection('jobs').doc('push').get();
      return d.exists ? d.data() : null;
    },

    // ---------- cinta de cotizaciones ----------
    getMarketTicker: async function () {
      var d = await db.collection('market').doc('ticker').get();
      return d.exists ? d.data() : null;
    },

    // ---------- salud ----------
    getJobHealth: async function () {
      var d = await db.collection('jobs').doc('ingesta').get();
      return d.exists ? d.data() : null;
    }
  };
})();
