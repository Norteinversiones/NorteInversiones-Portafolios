/* ============================================================
   PANEL · pestaña CLIENTES (gestor de clientes de Norte)
   Un cliente = una persona/empresa con una o más cuentas comitente.
   Las cuentas alimentan el índice de login de la app (authorized_accounts).
   Importación: subir el Excel/CSV directamente desde acá (SheetJS por CDN).
   ============================================================ */
(function () {
  'use strict';
  var N = window.NORTE, E = N.engine, db = N.db, CL = N.clientes;
  var SORT_KEY = 'norte.clientes.orden';
  var CS = { list: null, q: '', alyc: '', ref: '', edit: null, preview: null, orphans: [], soloRevisar: false, sort: null, byId: {} };
  var SIN_REF = '__sin__'; // valor del selector "Sin referido"

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  // Texto comparable: sin acentos, sin mayúsculas. Se usa para buscar y para sugerir.
  function norm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  function num(v) { var n = Number(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  function fmtArs0(v) { return '$' + E.fmtNum(v, 0); }
  var ALYC_LABEL = { IOL: 'IOL', COCOS: 'Cocos', BALANZ: 'Balanz' };
  function alycLabel(a) { return ALYC_LABEL[a] || a; }

  // Brókers para los KPIs y el filtro: primero los de la configuración
  // (NORTE.ALYCS en js/firebase-config.js) y después cualquier otro que aparezca
  // en los datos, así sumar un bróker nuevo no obliga a tocar esta pantalla.
  function alycsDisponibles(list) {
    var visto = {}, out = [];
    (N.ALYCS || []).forEach(function (a) { if (a && !visto[a]) { visto[a] = 1; out.push(a); } });
    list.forEach(function (c) { (c.accounts || []).forEach(function (a) { if (a.alyc && !visto[a.alyc]) { visto[a.alyc] = 1; out.push(a.alyc); } }); });
    return out;
  }
  function cuentasDe(c) { return (c.accounts || []).filter(function (a) { return !CS.alyc || a.alyc === CS.alyc; }); }
  function capitalDe(c) { return cuentasDe(c).reduce(function (s, a) { return s + (Number(a.capital) || 0); }, 0); }

  // ---------- orden de la lista ----------
  // Una entrada por columna clickeable: `num` decide el tipo de comparación y el
  // sentido del primer clic (los números arrancan de mayor a menor), `val` saca el
  // valor a comparar. Un valor vacío (texto en blanco, capital 0 o sin cargar) va
  // siempre al final, en cualquier dirección.
  var COLS = {
    name: { num: false, val: function (c) { return c.name || ''; } },
    greeting: { num: false, val: function (c) { return c.greeting || ''; } },
    cuentas: { num: false, val: function (c) { return cuentasDe(c).map(function (a) { return alycLabel(a.alyc) + ' ' + a.comitente; }).sort().join(' '); } },
    capital: { num: true, val: function (c) { return CS.alyc ? capitalDe(c) : CL.capitalTotal(c); } },
    referido: { num: false, val: function (c) { return c.referredBy || ''; } }
  };
  var SORT_DEF = { col: 'capital', dir: 'desc' }; // al abrir la pestaña: capital de mayor a menor

  function cargarSort() {
    try {
      var s = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
      if (s && COLS[s.col]) return { col: s.col, dir: s.dir === 'asc' ? 'asc' : 'desc' };
    } catch (e) { }
    return { col: SORT_DEF.col, dir: SORT_DEF.dir };
  }
  function guardarSort() { try { localStorage.setItem(SORT_KEY, JSON.stringify(CS.sort)); } catch (e) { } }
  function txtCmp(a, b) { return String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true }); }

  function ordenar(list) {
    var def = COLS[CS.sort.col] || COLS[SORT_DEF.col], dir = CS.sort.dir === 'asc' ? 1 : -1;
    // Se calcula el valor una vez por cliente (no dentro del comparador).
    return list.map(function (c) {
      var v = def.val(c);
      return { c: c, v: v, vacio: def.num ? !Number(v) : !String(v).trim() };
    }).sort(function (x, y) {
      if (x.vacio !== y.vacio) return x.vacio ? 1 : -1;
      if (!x.vacio) {
        var r = def.num ? (Number(x.v) - Number(y.v)) : txtCmp(x.v, y.v);
        if (r) return r * dir;
      }
      return txtCmp(x.c.name || '', y.c.name || ''); // desempate estable por nombre
    }).map(function (o) { return o.c; });
  }

  // Encabezado clickeable con la flechita de la columna activa.
  function thSort(col, txt, cls) {
    var on = CS.sort.col === col;
    return '<th' + (cls ? ' class="' + cls + '"' : '') + '><button type="button" class="sortth' + (on ? ' on' : '') + '" data-sort="' + col + '"' +
      ' title="Ordenar por ' + h(txt) + '">' + h(txt) + '<span class="ar">' + (on ? (CS.sort.dir === 'asc' ? '▲' : '▼') : '') + '</span></button></th>';
  }

  // ---------- referidos ----------
  // `referredBy` es el nombre de quien lo refirió (texto libre) y `referredByClientId`
  // el id del referidor cuando además es cliente. Para agrupar referidores se usa la
  // misma clave que agrupa clientes (nombreNormalizado: tokens ordenados, sin acentos),
  // así "Juan Pérez" y "PEREZ JUAN" cuentan como una sola persona.
  function refKey(c) {
    var t = String(c.referredBy || '').trim();
    return t ? CL.nombreNormalizado(t) : '';
  }
  function indexar(list) { CS.byId = {}; list.forEach(function (c) { CS.byId[c.id] = c; }); }
  // Referidores presentes en la base, con cuántos clientes trajo cada uno y su capital.
  // Ordenados por capital de mayor a menor. El capital es el total del cliente: este
  // resumen es de toda la base y no depende del bróker elegido ni del buscador.
  function referidores(list) {
    var map = {}, orden = [];
    list.forEach(function (c) {
      var k = refKey(c); if (!k) return;
      if (!map[k]) { map[k] = { key: k, label: String(c.referredBy).trim(), clientId: '', n: 0, capital: 0 }; orden.push(k); }
      var r = map[k];
      r.n++; r.capital += CL.capitalTotal(c);
      // Si alguno de los referidos lo tiene vinculado, mostramos el nombre de su ficha.
      if (!r.clientId && c.referredByClientId && CS.byId[c.referredByClientId]) {
        r.clientId = c.referredByClientId; r.label = CS.byId[c.referredByClientId].name || r.label;
      }
    });
    return orden.map(function (k) { return map[k]; }).sort(function (a, b) { return (b.capital - a.capital) || txtCmp(a.label, b.label); });
  }
  // Celda "Referido" de la lista. Si está vinculado a un cliente, es un botón que abre
  // su ficha; si el vínculo quedó colgado (lo borraron o lo unieron), cae a texto.
  function refCelda(c) {
    var t = String(c.referredBy || '').trim();
    if (!t) return '<span class="muted">—</span>';
    var o = c.referredByClientId ? CS.byId[c.referredByClientId] : null;
    return o ? '<button type="button" class="linkref" data-ref="' + h(o.id) + '" title="Abrir la ficha de ' + h(o.name) + '">' + h(o.name) + '</button>'
      : '<small>' + h(t) + '</small>';
  }

  // Filtro combinado: bróker + referidor + texto (nombre, saludo, referido o comitente).
  function filtrar(list) {
    var q = norm(CS.q);
    return list.filter(function (c) {
      if (CS.soloRevisar && !c.greetingReview) return false;
      if (CS.alyc && !(c.accounts || []).some(function (a) { return a.alyc === CS.alyc; })) return false;
      if (CS.ref) { var k = refKey(c); if (CS.ref === SIN_REF ? !!k : k !== CS.ref) return false; }
      if (!q) return true;
      return norm(c.name).indexOf(q) >= 0 || norm(c.greeting).indexOf(q) >= 0 || norm(c.referredBy).indexOf(q) >= 0 ||
        (c.accounts || []).some(function (a) { return String(a.comitente).indexOf(q) >= 0; });
    });
  }

  function filtrosHtml(list) {
    var porAlyc = {};
    list.forEach(function (c) {
      var v = {};
      (c.accounts || []).forEach(function (a) { if (a.alyc && !v[a.alyc]) { v[a.alyc] = 1; porAlyc[a.alyc] = (porAlyc[a.alyc] || 0) + 1; } });
    });
    var btn = function (val, txt, n) {
      return '<button type="button" data-alyc="' + h(val) + '"' + (CS.alyc === val ? ' class="on"' : '') + '>' + h(txt) + ' <span class="n">' + n + '</span></button>';
    };
    return '<div class="pills" data-role="alyc">' + btn('', 'Todos', list.length) +
      alycsDisponibles(list).map(function (a) { return btn(a, alycLabel(a), porAlyc[a] || 0); }).join('') + '</div>';
  }

  // Selector de referidor. Se dibuja una vez por render (queda fuera de #clLista),
  // así que al elegir uno sólo se repinta la lista.
  function refSelectHtml(list) {
    var sin = list.filter(function (c) { return !refKey(c); }).length;
    return '<select id="clRef" class="selauto" title="Filtrar por quién lo refirió">' +
      '<option value=""' + (CS.ref ? '' : ' selected') + '>Todos</option>' +
      '<option value="' + SIN_REF + '"' + (CS.ref === SIN_REF ? ' selected' : '') + '>Sin referido (' + sin + ')</option>' +
      referidores(list).map(function (r) {
        return '<option value="' + h(r.key) + '"' + (CS.ref === r.key ? ' selected' : '') + '>' + h(r.label) + ' (' + r.n + ')</option>';
      }).join('') + '</select>';
  }

  // Tarjeta "Referidos": un renglón por referidor, de mayor a menor capital.
  function resumenRefHtml(list) {
    var refs = referidores(list);
    if (!refs.length) return '';
    var tot = refs.reduce(function (s, r) { return s + r.capital; }, 0), cli = refs.reduce(function (s, r) { return s + r.n; }, 0);
    return '<div class="card" id="clRefResumen"><div class="row between"><h2>Referidos</h2>' +
      '<button class="btn sm sec' + (CS.ref ? '' : ' hidden') + '" data-act="refall">Ver todos los clientes</button></div>' +
      '<p class="sub">Quién trajo a cada cliente. Tocá un referidor para filtrar la lista de arriba.</p>' +
      '<div class="tablewrap"><table><thead><tr><th>Referidor</th><th class="num">Clientes</th><th class="num">Capital</th></tr></thead><tbody>' +
      refs.map(function (r) {
        return '<tr class="refrow' + (CS.ref === r.key ? ' on' : '') + '" data-refkey="' + h(r.key) + '" style="cursor:pointer">' +
          '<td><b>' + h(r.label) + '</b>' + (r.clientId ? ' <span class="tag">cliente</span>' : '') + '</td>' +
          '<td class="num">' + r.n + '</td><td class="num">' + fmtArs0(r.capital) + '</td></tr>';
      }).join('') +
      '<tr class="total"><td>' + refs.length + (refs.length === 1 ? ' referidor' : ' referidores') + '</td><td class="num">' + cli + '</td><td class="num">' + fmtArs0(tot) + '</td></tr>' +
      '</tbody></table></div></div>';
  }

  // Contenido de #clLista (tabla + pie). Al buscar o filtrar se repinta sólo esto:
  // si se volviera a dibujar toda la pestaña, el input se recrearía en cada tecla
  // y el cursor se perdería.
  function listaHtml(list) {
    if (!list.length) return '<p class="muted">Todavía no hay clientes. Subí la planilla en el cuadro de la derecha.</p>';
    indexar(list);
    var visibles = ordenar(filtrar(list)), cuentasVis = 0, capVis = 0;
    visibles.forEach(function (c) { cuentasVis += cuentasDe(c).length; capVis += capitalDe(c); });
    if (!visibles.length) return '<p class="muted">Ningún cliente coincide con la búsqueda' + (CS.alyc ? ' en ' + h(alycLabel(CS.alyc)) : '') + '. <button class="btn sm sec" data-act="limpiar">Ver todos</button></p>';
    return '<table><thead><tr>' + thSort('name', 'Cliente') + thSort('greeting', 'Saludo') + thSort('cuentas', 'Cuentas') +
      thSort('capital', 'Capital' + (CS.alyc ? ' ' + alycLabel(CS.alyc) : ''), 'num') + thSort('referido', 'Referido') + '<th></th></tr></thead><tbody>' +
      visibles.slice(0, 400).map(function (c) {
        return '<tr data-id="' + h(c.id) + '" style="cursor:pointer"><td><b>' + h(c.name) + '</b>' + (c.type === 'PJ' ? ' <span class="tag">PJ</span>' : '') + (c.isActive === false ? ' <span class="tag bad">inactivo</span>' : '') + (c.cotitulares && c.cotitulares.length ? '<br><small>y/o ' + h(c.cotitulares.join(', ')) + '</small>' : '') + '</td>' +
          '<td>' + h(c.greeting) + '</td>' +
          '<td><small>' + (c.accounts || []).map(function (a) {
            var t = h(alycLabel(a.alyc)) + ' ' + h(a.comitente);
            return CS.alyc && a.alyc !== CS.alyc ? '<span class="muted">' + t + '</span>' : t;
          }).join('<br>') + '</small></td>' +
          '<td class="num">' + fmtArs0(CS.alyc ? capitalDe(c) : CL.capitalTotal(c)) + '</td>' +
          '<td>' + refCelda(c) + '</td><td>' + (CS.edit && CS.edit.id === c.id ? '▾' : '›') + '</td></tr>' +
          (CS.edit && CS.edit.id === c.id ? '<tr class="editrow"><td colspan="6"><div class="card flat" id="clForm">' + formHtml(CS.edit) + '</div></td></tr>' : '');
      }).join('') + '</tbody></table>' +
      '<p class="muted">' + visibles.length + (visibles.length === 1 ? ' cliente · ' : ' clientes · ') + cuentasVis + ' cuentas' + (CS.alyc ? ' en ' + h(alycLabel(CS.alyc)) : '') + ' · ' + fmtArs0(capVis) +
      (visibles.length > 400 ? ' · se muestran las primeras 400' : '') + '</p>';
  }

  N.renderClientes = async function (ctx) {
    var sec = ctx.freshSection('tab-clientes'), toast = ctx.toast, busy = ctx.busy;
    if (!CS.sort) CS.sort = cargarSort(); // último orden elegido, o capital de mayor a menor
    sec.innerHTML = '<p class="muted">Cargando clientes…</p>';
    if (!CS.list) { CS.list = await db.listClients(); CS.orphans = await db.listOrphanAccounts(); }
    var list = CS.list;
    indexar(list);

    // ---- totales ----
    var alycs = alycsDisponibles(list), tot = {}, cnt = {}, totAll = 0, cuentas = 0;
    list.forEach(function (c) { (c.accounts || []).forEach(function (a) { tot[a.alyc] = (tot[a.alyc] || 0) + (Number(a.capital) || 0); cnt[a.alyc] = (cnt[a.alyc] || 0) + 1; totAll += Number(a.capital) || 0; cuentas++; }); });

    var html = '<div class="card"><div class="row between"><h2>Clientes</h2><div class="row"><span class="tag ok">' + list.length + ' clientes</span><span class="tag">' + cuentas + ' cuentas</span>' + '</div></div>' +
      '<div class="kpis mb">' + alycs.map(function (a) { return '<div class="kpi"><div class="l">Capital ' + h(alycLabel(a)) + '</div><div class="v">' + fmtArs0(tot[a] || 0) + '</div><small class="muted">' + (cnt[a] || 0) + ' cuentas</small></div>'; }).join('') +
      '<div class="kpi"><div class="l">Capital total</div><div class="v">' + fmtArs0(totAll) + '</div><small class="muted">' + cuentas + ' cuentas · ' + list.length + ' clientes</small></div></div>' +
      '<div class="row"><input type="search" id="clQ" class="grow" placeholder="Buscar por nombre, saludo, referido o comitente" value="' + h(CS.q) + '">' +
      '<button class="btn sm" data-act="new">+ Nuevo cliente</button></div>' +
      '<div class="row mt"><span class="muted">Bróker</span>' + filtrosHtml(list) +
      '<span class="muted">Referido</span>' + refSelectHtml(list) + '</div>' +
      '<div class="tablewrap mt" id="clLista">' + listaHtml(list) + '</div></div>' +
      resumenRefHtml(list);

    // ---- ficha / importación ----
    html += '<div class="grid2">';
    html += CS.edit && !CS.edit.id ? '<div class="card" id="clForm">' + formHtml(CS.edit) + '</div>' : '<div class="card"><h2>Ficha del cliente</h2><p class="muted">Tocá un cliente de la lista para desplegar su ficha debajo, o creá uno nuevo con el botón de arriba.</p></div>';
    html += '<div><div class="card"><h2>Importar planilla</h2><div class="sub">Subí el Excel de clientes (columnas <b>Cliente, Broker, Comitente, PH/PJ, Capital</b>). Las cuentas de la misma persona se agrupan en un cliente; las que ya existen actualizan su capital. Nada se guarda hasta que confirmes.</div>' +
      '<input type="file" id="clFile" accept=".xlsx,.xls,.csv"><div id="clPreview" class="mt"></div></div>';

    // ---- posibles duplicados ----
    var dups = CL.posiblesDuplicados(list);
    if (dups.length) {
      html += '<div class="card"><h3>Posibles duplicados</h3><p class="sub">Nombres parecidos que podrían ser la misma persona. Si lo son, unilos; si no, ignoralos.</p>' +
        dups.slice(0, 30).map(function (d) {
          return '<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--gris-4)"><div><b>' + h(d[0].name) + '</b> <small>(' + (d[0].accounts || []).map(function (a) { return alycLabel(a.alyc) + ' ' + a.comitente; }).join(', ') + ')</small><br><b>' + h(d[1].name) + '</b> <small>(' + (d[1].accounts || []).map(function (a) { return alycLabel(a.alyc) + ' ' + a.comitente; }).join(', ') + ')</small></div>' +
            '<button class="btn sm sec" data-act="merge" data-keep="' + h(d[0].id) + '" data-drop="' + h(d[1].id) + '">Unir</button></div>';
        }).join('') + '</div>';
    }
    // ---- cuentas sueltas ----
    if (CS.orphans.length) {
      html += '<div class="card flat"><h3>Cuentas sin cliente</h3><p class="sub">Quedaron del sistema anterior (por ejemplo cuentas de prueba). Podés borrarlas.</p>' +
        CS.orphans.map(function (a) { return '<div class="row between"><span>' + alycLabel(a.alyc) + ' ' + h(a.comitente) + ' · ' + h(a.clientName || '') + '</span><button class="btn sm danger" data-act="delorphan" data-id="' + h(a.id) + '">Borrar</button></div>'; }).join('') + '</div>';
    }
    html += '</div></div>';
    sec.innerHTML = html;

    // ---- eventos ----
    // Repintar sólo la lista deja el buscador intacto: no se pierde el foco ni la
    // posición del cursor mientras se escribe.
    function repintarLista() {
      var box = $('clLista'); if (!box) return;
      box.innerHTML = listaHtml(list);
      bindFilas();
      if (CS.edit && CS.edit.id) bindForm(sec, ctx); // la ficha abierta vive dentro de la tabla
    }
    // Elegir un referidor: repinta la lista y deja el selector y el resumen en sintonía.
    function aplicarRef(val) {
      CS.ref = val || '';
      var s = $('clRef'); if (s) s.value = CS.ref;
      sec.querySelectorAll('[data-refkey]').forEach(function (tr) { tr.classList.toggle('on', tr.dataset.refkey === CS.ref); });
      var verTodos = sec.querySelector('[data-act=refall]');
      if (verTodos) verTodos.classList.toggle('hidden', !CS.ref);
      repintarLista();
    }
    function bindFilas() {
      sec.querySelectorAll('tr[data-id]').forEach(function (tr) {
        tr.onclick = function (ev) {
          if (ev.target.closest('[data-ref]')) return; // el referido abre otra ficha, no ésta
          var eraNuevo = CS.edit && !CS.edit.id; // la tarjeta de "nuevo cliente" está fuera de la lista
          if (CS.edit && CS.edit.id === tr.dataset.id) CS.edit = null;
          else CS.edit = JSON.parse(JSON.stringify(list.filter(function (c) { return c.id === tr.dataset.id; })[0]));
          var foco = function () { var f = $('clForm'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
          if (eraNuevo) N.renderClientes(ctx).then(foco); else { repintarLista(); foco(); }
        };
      });
    }
    bindFilas();

    $('clQ').oninput = function () { CS.q = this.value; repintarLista(); };
    if ($('clRef')) $('clRef').onchange = function () { aplicarRef(this.value); };

    var pills = sec.querySelector('[data-role=alyc]');
    if (pills) pills.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      CS.alyc = b.dataset.alyc || '';
      pills.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', (x.dataset.alyc || '') === CS.alyc); });
      repintarLista();
    });

    $('clFile').onchange = function () { leerArchivo(this.files[0], ctx); };
    bindForm(sec, ctx);

    sec.addEventListener('click', async function (e) {
      // Encabezados de la tabla: primer clic ordena por esa columna, el segundo invierte.
      var th = e.target.closest('[data-sort]');
      if (th) {
        var col = th.dataset.sort; if (!COLS[col]) return;
        if (CS.sort.col === col) CS.sort.dir = CS.sort.dir === 'asc' ? 'desc' : 'asc';
        else CS.sort = { col: col, dir: COLS[col].num ? 'desc' : 'asc' };
        guardarSort(); repintarLista(); return;
      }
      // Un referido vinculado abre la ficha del referidor. Si los filtros lo dejan
      // fuera de la lista, se limpian (la ficha vive dentro de la fila del cliente).
      var lk = e.target.closest('[data-ref]');
      if (lk) {
        var o = CS.byId[lk.dataset.ref]; if (!o) return;
        var eraNuevo = CS.edit && !CS.edit.id, visible = filtrar(list).some(function (x) { return x.id === o.id; });
        if (!visible) { CS.q = ''; CS.alyc = ''; CS.ref = ''; }
        CS.edit = JSON.parse(JSON.stringify(o));
        var irAlForm = function () { var f = $('clForm'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
        if (visible && !eraNuevo) { repintarLista(); irAlForm(); }
        else N.renderClientes(ctx).then(irAlForm);
        return;
      }
      // Referidor del resumen: filtra la lista por él (y al tocarlo otra vez, la libera).
      var rk = e.target.closest('[data-refkey]');
      if (rk) { aplicarRef(CS.ref === rk.dataset.refkey ? '' : rk.dataset.refkey); $('clLista').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }

      var b = e.target.closest('[data-act]'); if (!b) return;
      var act = b.dataset.act;
      try {
        if (act === 'new') { CS.edit = { name: '', greeting: '', type: 'PH', accounts: [{ alyc: CS.alyc || 'IOL', comitente: '', capital: 0 }], isActive: true }; N.renderClientes(ctx).then(function () { var f = $('clForm'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); }
        else if (act === 'limpiar') { CS.q = ''; CS.alyc = ''; CS.ref = ''; N.renderClientes(ctx); }
        else if (act === 'refall') { aplicarRef(''); }
        else if (act === 'merge') {
          var keep = list.filter(function (c) { return c.id === b.dataset.keep; })[0], drop = list.filter(function (c) { return c.id === b.dataset.drop; })[0];
          if (!confirm('Unir "' + drop.name + '" dentro de "' + keep.name + '". Las cuentas pasan al primero. ¿Confirmás?')) return;
          busy(true); await db.mergeClients(keep, drop); CS.list = null; busy(false); N.renderClientes(ctx); toast('Clientes unidos');
        }
        else if (act === 'delorphan') { await firebase.firestore().collection('authorized_accounts').doc(b.dataset.id).delete(); CS.orphans = await db.listOrphanAccounts(); N.renderClientes(ctx); toast('Cuenta borrada'); }
        else if (act === 'import') { await confirmarImport(ctx); }
        else if (act === 'cancelimport') { CS.preview = null; N.renderClientes(ctx); }
      } catch (err) { busy(false); console.error(err); toast('Error: ' + (err.message || err), true); }
    });
    if (CS.preview) renderPreview(ctx);
  };

  // ---------- ficha ----------
  function formHtml(c) {
    if (!c) return '<h2>Ficha del cliente</h2><p class="muted">Elegí un cliente de la lista para ver o editar sus datos, o creá uno nuevo.</p>';
    var acc = (c.accounts || []).map(function (a, i) {
      return '<tr data-i="' + i + '"><td><select data-a="alyc" class="w-t">' + N.ALYCS.map(function (x) { return '<option value="' + x + '"' + (x === a.alyc ? ' selected' : '') + '>' + alycLabel(x) + '</option>'; }).join('') + '</select></td>' +
        '<td><input type="text" data-a="comitente" inputmode="numeric" class="w-m" value="' + h(a.comitente) + '"></td>' +
        '<td><input type="number" step="1" data-a="capital" class="w-m" value="' + h(a.capital || 0) + '"></td>' +
        '<td><button class="iconbtn" data-f="delacc" title="Quitar">✕</button></td></tr>';
    }).join('');
    return '<div class="row between"><h2>' + (c.id ? 'Ficha del cliente' : 'Nuevo cliente') + '</h2>' + (c.id ? '<button class="btn sm danger" data-f="delete">Borrar cliente</button>' : '') + '</div>' +
      '<label class="f"><span>Nombre completo (como figura en el bróker)</span><input type="text" data-c="name" value="' + h(c.name) + '"></label>' +
      '<div class="row"><label class="f grow"><span>Cómo saludarlo en la app ("Hola, …")</span><input type="text" data-c="greeting" value="' + h(c.greeting) + '"></label>' +
      '<label class="f"><span>Tipo</span><select data-c="type"><option value="PH"' + (c.type !== 'PJ' ? ' selected' : '') + '>Persona humana</option><option value="PJ"' + (c.type === 'PJ' ? ' selected' : '') + '>Persona jurídica</option></select></label></div>' +
      '<div class="row">' +
      '<label class="check"><input type="checkbox" data-c="isActive"' + (c.isActive !== false ? ' checked' : '') + '> Activo (puede entrar a la app)</label></div>' +
      '<label class="f"><span>Referido por (opcional · dato interno)</span>' +
      '<span class="acwrap"><input type="text" data-c="referredBy" id="clRefIn" autocomplete="off" placeholder="Nombre de quien lo trajo" value="' + h(c.referredBy || '') + '">' +
      '<span class="aclist" id="clRefAc"></span></span>' +
      '<small class="muted" id="clRefHint">' + refHint(c) + '</small></label>' +
      (c.cotitulares && c.cotitulares.length ? '<p class="muted">Cotitulares: ' + h(c.cotitulares.join(', ')) + '</p>' : '') +
      '<h3 class="mt">Cuentas comitente</h3><div class="tablewrap"><table><thead><tr><th>Bróker</th><th>Comitente</th><th>Capital (ARS)</th><th></th></tr></thead><tbody>' + acc + '</tbody></table></div>' +
      '<button class="btn sm sec" data-f="addacc">+ Agregar cuenta</button>' +
      '<h3 class="mt">Contacto</h3><div class="row"><label class="f grow"><span>DNI / CUIT</span><input type="text" data-c="dni" value="' + h(c.dni || '') + '"></label>' +
      '<label class="f grow"><span>Teléfono</span><input type="text" data-c="phone" value="' + h(c.phone || '') + '"></label>' +
      '<label class="f grow"><span>Email</span><input type="text" data-c="email" value="' + h(c.email || '') + '"></label></div>' +
      '<label class="f"><span>Notas internas</span><textarea data-c="notes">' + h(c.notes || '') + '</textarea></label>' +
      '<div class="row"><button class="btn" data-f="save">Guardar</button><button class="btn sec" data-f="cancel">Cerrar</button></div>';
  }
  function refHint(c) {
    var t = String(c.referredBy || '').trim(), o = c.referredByClientId ? CS.byId[c.referredByClientId] : null;
    if (o) return 'Vinculado a la ficha de <b>' + h(o.name) + '</b>: en la lista se puede tocar para abrirla.';
    if (t) return 'Se guarda como texto: no hay ningún cliente con ese nombre.';
    return 'Mientras escribís aparecen los clientes que coinciden. También podés anotar a alguien que no es cliente.';
  }

  // Autocompletado del campo "Referido por": sugiere clientes mientras se escribe
  // (sin acentos ni mayúsculas) y nunca se ofrece el cliente que estamos editando.
  function bindAutocompletar(inp, box, hint) {
    var sel = -1, opts = [];
    function candidatos() {
      var qn = norm(inp.value), propio = CL.nombreNormalizado(CS.edit.name || '');
      return (CS.list || []).filter(function (x) {
        if (CS.edit.id ? x.id === CS.edit.id : (propio && x.nameNormalized === propio)) return false;
        return !qn || norm(x.name).indexOf(qn) >= 0;
      }).slice(0, 8);
    }
    function marcar() { box.querySelectorAll('[data-pick]').forEach(function (b, i) { b.classList.toggle('sel', i === sel); }); }
    function cerrar() { box.classList.remove('on'); box.innerHTML = ''; sel = -1; }
    function pintar() {
      opts = candidatos();
      if (!opts.length) return cerrar();
      box.innerHTML = opts.map(function (x) { return '<button type="button" data-pick="' + h(x.id) + '">' + h(x.name) + '</button>'; }).join('');
      box.classList.add('on'); marcar();
    }
    function elegir(x) {
      if (!x) return;
      inp.value = x.name; CS.edit.referredBy = x.name; CS.edit.referredByClientId = x.id;
      if (hint) hint.innerHTML = refHint(CS.edit);
      cerrar();
    }
    inp.oninput = function () {
      CS.edit.referredBy = inp.value;
      // Si el texto dejó de coincidir con el cliente vinculado, se corta el vínculo.
      var o = CS.edit.referredByClientId ? CS.byId[CS.edit.referredByClientId] : null;
      if (o && norm(o.name) !== norm(inp.value)) CS.edit.referredByClientId = '';
      sel = -1;
      if (inp.value.trim()) pintar(); else cerrar(); // con el campo vacío no se sugiere nada
      if (hint) hint.innerHTML = refHint(CS.edit);
    };
    inp.onblur = function () { setTimeout(cerrar, 150); }; // da tiempo al clic de la sugerencia
    inp.onkeydown = function (e) {
      if (e.key === 'Escape') return cerrar();
      if (e.key === 'ArrowDown' && !box.classList.contains('on')) { e.preventDefault(); return pintar(); }
      if (!box.classList.contains('on')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, opts.length - 1); marcar(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, -1); marcar(); }
      else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); elegir(opts[sel]); }
    };
    box.onmousedown = function (e) { // mousedown para que el clic gane al blur del input
      var b = e.target.closest('[data-pick]'); if (!b) return;
      e.preventDefault(); elegir(CS.byId[b.dataset.pick]);
    };
  }

  function bindForm(sec, ctx) {
    var form = $('clForm'); if (!form || !CS.edit) return;
    if ($('clRefIn')) bindAutocompletar($('clRefIn'), $('clRefAc'), $('clRefHint'));
    form.addEventListener('input', function (e) {
      var t = e.target, c = CS.edit;
      if (t.dataset.c) { c[t.dataset.c] = t.type === 'checkbox' ? t.checked : t.value; }
      else if (t.dataset.a) { var i = Number(t.closest('tr').dataset.i); c.accounts[i][t.dataset.a] = t.dataset.a === 'capital' ? (num(t.value) || 0) : t.value; }
    });
    form.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      var c = CS.edit, f = b.dataset.f;
      try {
        if (f === 'addacc') { c.accounts.push({ alyc: 'IOL', comitente: '', capital: 0 }); N.renderClientes(ctx); }
        else if (f === 'delacc') { c.accounts.splice(Number(b.closest('tr').dataset.i), 1); N.renderClientes(ctx); }
        else if (f === 'cancel') { CS.edit = null; N.renderClientes(ctx); }
        else if (f === 'save') {
          if (!c.name.trim()) return ctx.toast('Falta el nombre', true);
          if (!c.accounts.some(function (a) { return String(a.comitente).replace(/\D/g, ''); })) return ctx.toast('Cargá al menos una cuenta comitente', true);
          if (!c.greeting.trim()) c.greeting = CL.saludoSugerido(c.name, c.accounts[0].alyc, c.type).saludo;
          c.nameNormalized = CL.nombreNormalizado(c.name);
          // Referido: nadie puede ser referido de sí mismo. Si el texto escrito a mano
          // coincide con un cliente, se vincula; si no, queda sólo el texto.
          c.referredBy = String(c.referredBy || '').trim();
          if (!c.referredBy) c.referredByClientId = '';
          else {
            var rk = CL.nombreNormalizado(c.referredBy);
            if (rk === c.nameNormalized) return ctx.toast('Un cliente no puede ser referido de sí mismo', true);
            if (!c.referredByClientId || c.referredByClientId === c.id) {
              var m = (CS.list || []).filter(function (x) { return x.id !== c.id && x.nameNormalized === rk; });
              c.referredByClientId = m.length === 1 ? m[0].id : '';
            }
          }
          ctx.busy(true); await db.saveClient(c); CS.list = null; CS.edit = null; ctx.busy(false); N.renderClientes(ctx); ctx.toast('Cliente guardado');
        }
        else if (f === 'delete') {
          if (!confirm('Borrar a "' + c.name + '" y sus ' + c.accounts.length + ' cuentas. No va a poder entrar a la app. ¿Confirmás?')) return;
          ctx.busy(true); await db.deleteClient(c); CS.list = null; CS.edit = null; ctx.busy(false); N.renderClientes(ctx); ctx.toast('Cliente borrado');
        }
      } catch (err) { ctx.busy(false); ctx.toast('Error: ' + (err.message || err), true); }
    });
  }

  // ---------- importación ----------
  function leerArchivo(file, ctx) {
    if (!file) return;
    if (typeof XLSX === 'undefined') return ctx.toast('No se pudo cargar el lector de Excel. Revisá la conexión y recargá.', true);
    var r = new FileReader();
    r.onload = function () {
      try {
        var wb = XLSX.read(r.result, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        var parsed = CL.parseFilas(rows);
        var grupos = CL.agrupar(parsed.ok);
        CS.preview = { archivo: file.name, hoja: wb.SheetNames[0], filas: parsed.ok.length, errores: parsed.errores, grupos: grupos };
        renderPreview(ctx);
      } catch (e) { console.error(e); ctx.toast('No pude leer el archivo: ' + e.message, true); }
    };
    r.readAsArrayBuffer(file);
  }
  function renderPreview(ctx) {
    var p = CS.preview, box = $('clPreview'); if (!p || !box) return;
    var existentes = {}; (CS.list || []).forEach(function (c) { existentes[c.nameNormalized] = c; (c.accounts || []).forEach(function (a) { existentes['acc_' + a.alyc + '_' + a.comitente] = c; }); });
    var nuevos = 0, actualiza = 0, multi = 0, revisar = 0;
    p.grupos.forEach(function (g) {
      var ex = existentes[g.nameNormalized] || g.accounts.map(function (a) { return existentes['acc_' + a.alyc + '_' + a.comitente]; }).filter(Boolean)[0];
      if (ex) actualiza++; else nuevos++;
      if (g.accounts.length > 1) multi++; if (g.greetingReview) revisar++;
    });
    box.innerHTML = '<div class="alert info"><b>' + h(p.archivo) + '</b> · hoja "' + h(p.hoja) + '" · ' + p.filas + ' cuentas válidas → <b>' + p.grupos.length + ' clientes</b> (' + nuevos + ' nuevos, ' + actualiza + ' ya existentes que se actualizan) · ' + multi + ' con más de una cuenta' +
      (p.errores.length ? '<br><span class="neg">' + p.errores.length + ' filas salteadas: ' + p.errores.slice(0, 5).map(function (e) { return 'fila ' + e.fila + ' (' + e.motivo + ')'; }).join(', ') + (p.errores.length > 5 ? '…' : '') + '</span>' : '') + '</div>' +
      '<div class="tablewrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>Cliente</th><th>Saludo</th><th>Cuentas</th></tr></thead><tbody>' +
      p.grupos.map(function (g) { return '<tr><td>' + h(g.name) + (g.cotitulares.length ? '<br><small>y/o ' + h(g.cotitulares.join(', ')) + '</small>' : '') + '</td><td>' + h(g.greeting) + '</td><td><small>' + g.accounts.map(function (a) { return alycLabel(a.alyc) + ' ' + a.comitente + ' · ' + fmtArs0(a.capital); }).join('<br>') + '</small></td></tr>'; }).join('') +
      '</tbody></table></div><div class="row mt"><button class="btn amarillo" data-act="import">Importar ' + p.grupos.length + ' clientes</button><button class="btn sec" data-act="cancelimport">Cancelar</button></div>';
  }
  async function confirmarImport(ctx) {
    var p = CS.preview; if (!p) return;
    if (!confirm('Importar ' + p.grupos.length + ' clientes con ' + p.filas + ' cuentas. Las cuentas quedan habilitadas para entrar a la app. ¿Confirmás?')) return;
    ctx.busy(true);
    try {
      var r = await db.importClients(p.grupos);
      CS.list = null; CS.preview = null; CS.orphans = [];
      ctx.busy(false); await N.renderClientes(ctx); ctx.toast(r.nuevos + ' clientes nuevos, ' + r.actualizados + ' actualizados');
    } catch (e) { ctx.busy(false); throw e; }
  }
})();
