/* ============================================================
   PANEL · pestaña CLIENTES (gestor de clientes de Norte)
   Un cliente = una persona/empresa con una o más cuentas comitente.
   Las cuentas alimentan el índice de login de la app (authorized_accounts).
   Importación: subir el Excel/CSV directamente desde acá (SheetJS por CDN).
   ============================================================ */
(function () {
  'use strict';
  var N = window.NORTE, E = N.engine, db = N.db, CL = N.clientes;
  var CS = { list: null, q: '', edit: null, preview: null, orphans: [], soloRevisar: false };

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function num(v) { var n = Number(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  function fmtArs0(v) { return '$' + E.fmtNum(v, 0); }
  function alycLabel(a) { return a === 'COCOS' ? 'Cocos' : a === 'BALANZ' ? 'Balanz' : a; }

  N.renderClientes = async function (ctx) {
    var sec = ctx.freshSection('tab-clientes'), toast = ctx.toast, busy = ctx.busy;
    sec.innerHTML = '<p class="muted">Cargando clientes…</p>';
    if (!CS.list) { CS.list = await db.listClients(); CS.orphans = await db.listOrphanAccounts(); }
    var list = CS.list;

    // ---- totales ----
    var tot = { IOL: 0, COCOS: 0, BALANZ: 0, all: 0 }, cnt = { IOL: 0, COCOS: 0, BALANZ: 0 }, cuentas = 0;
    list.forEach(function (c) { (c.accounts || []).forEach(function (a) { tot[a.alyc] = (tot[a.alyc] || 0) + (Number(a.capital) || 0); cnt[a.alyc] = (cnt[a.alyc] || 0) + 1; tot.all += Number(a.capital) || 0; cuentas++; }); });

    var q = CS.q.toLowerCase();
    var visibles = list.filter(function (c) {
      if (CS.soloRevisar && !c.greetingReview) return false;
      if (!q) return true;
      return (c.name || '').toLowerCase().indexOf(q) >= 0 || (c.greeting || '').toLowerCase().indexOf(q) >= 0 || (c.accounts || []).some(function (a) { return String(a.comitente).indexOf(q) >= 0; });
    });

    var html = '<div class="card"><div class="row between"><h2>Clientes</h2><div class="row"><span class="tag ok">' + list.length + ' clientes</span><span class="tag">' + cuentas + ' cuentas</span>' + '</div></div>' +
      '<div class="kpis mb">' + ['IOL', 'BALANZ', 'COCOS'].map(function (a) { return '<div class="kpi"><div class="l">Capital ' + alycLabel(a) + '</div><div class="v">' + fmtArs0(tot[a]) + '</div><small class="muted">' + (cnt[a] || 0) + ' cuentas</small></div>'; }).join('') +
      '<div class="kpi"><div class="l">Capital total</div><div class="v">' + fmtArs0(tot.all) + '</div><small class="muted">' + cuentas + ' cuentas · ' + list.length + ' clientes</small></div></div>' +
      '<div class="row"><input type="search" id="clQ" class="grow" placeholder="Buscar por nombre, saludo o comitente" value="' + h(CS.q) + '">' +

      '<button class="btn sm" data-act="new">+ Nuevo cliente</button></div>' +
      '<div class="tablewrap mt"><table><thead><tr><th>Cliente</th><th>Saludo</th><th>Cuentas</th><th class="num">Capital</th><th></th></tr></thead><tbody>' +
      visibles.slice(0, 400).map(function (c) {
        return '<tr data-id="' + h(c.id) + '" style="cursor:pointer"><td><b>' + h(c.name) + '</b>' + (c.type === 'PJ' ? ' <span class="tag">PJ</span>' : '') + (c.isActive === false ? ' <span class="tag bad">inactivo</span>' : '') + (c.cotitulares && c.cotitulares.length ? '<br><small>y/o ' + h(c.cotitulares.join(', ')) + '</small>' : '') + '</td>' +
          '<td>' + h(c.greeting) + '</td>' +
          '<td><small>' + (c.accounts || []).map(function (a) { return alycLabel(a.alyc) + ' ' + a.comitente; }).join('<br>') + '</small></td>' +
          '<td class="num">' + fmtArs0(CL.capitalTotal(c)) + '</td><td>' + (CS.edit && CS.edit.id === c.id ? '▾' : '›') + '</td></tr>' +
          (CS.edit && CS.edit.id === c.id ? '<tr class="editrow"><td colspan="5"><div class="card flat" id="clForm">' + formHtml(CS.edit) + '</div></td></tr>' : '');
      }).join('') + '</tbody></table>' + (visibles.length > 400 ? '<p class="muted">Se muestran 400 de ' + visibles.length + '.</p>' : '') + (!list.length ? '<p class="muted">Todavía no hay clientes. Subí la planilla en el cuadro de la derecha.</p>' : '') + '</div></div>';

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
    $('clQ').oninput = function () { CS.q = this.value; N.renderClientes(ctx); };

    sec.querySelectorAll('tr[data-id]').forEach(function (tr) { tr.onclick = function () { if (CS.edit && CS.edit.id === tr.dataset.id) { CS.edit = null; } else { CS.edit = JSON.parse(JSON.stringify(list.filter(function (c) { return c.id === tr.dataset.id; })[0])); } N.renderClientes(ctx).then(function () { var f = $('clForm'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }); }; });
    $('clFile').onchange = function () { leerArchivo(this.files[0], ctx); };
    bindForm(sec, ctx);

    sec.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var act = b.dataset.act;
      try {
        if (act === 'new') { CS.edit = { name: '', greeting: '', type: 'PH', accounts: [{ alyc: 'IOL', comitente: '', capital: 0 }], isActive: true }; N.renderClientes(ctx).then(function () { var f = $('clForm'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); }
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
      (c.cotitulares && c.cotitulares.length ? '<p class="muted">Cotitulares: ' + h(c.cotitulares.join(', ')) + '</p>' : '') +
      '<h3 class="mt">Cuentas comitente</h3><div class="tablewrap"><table><thead><tr><th>Bróker</th><th>Comitente</th><th>Capital (ARS)</th><th></th></tr></thead><tbody>' + acc + '</tbody></table></div>' +
      '<button class="btn sm sec" data-f="addacc">+ Agregar cuenta</button>' +
      '<h3 class="mt">Contacto</h3><div class="row"><label class="f grow"><span>DNI / CUIT</span><input type="text" data-c="dni" value="' + h(c.dni || '') + '"></label>' +
      '<label class="f grow"><span>Teléfono</span><input type="text" data-c="phone" value="' + h(c.phone || '') + '"></label>' +
      '<label class="f grow"><span>Email</span><input type="text" data-c="email" value="' + h(c.email || '') + '"></label></div>' +
      '<label class="f"><span>Notas internas</span><textarea data-c="notes">' + h(c.notes || '') + '</textarea></label>' +
      '<div class="row"><button class="btn" data-f="save">Guardar</button><button class="btn sec" data-f="cancel">Cerrar</button></div>';
  }
  function bindForm(sec, ctx) {
    var form = $('clForm'); if (!form || !CS.edit) return;
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
