/* ============================================================
   CLIENTES · lógica pura (sin DOM, sin Firestore) para el gestor de clientes.
   - normalizar nombres para agrupar cuentas de la misma persona
   - deducir el nombre para saludar según el formato de cada bróker
   - parsear filas de la planilla (Cliente, Broker, Comitente, PH/PJ, Capital)
   - agrupar filas en clientes
   ============================================================ */
(function () {
  var N = window.NORTE = window.NORTE || {};

  function sinAcentos(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function limpiar(s) { return sinAcentos(s).toUpperCase().replace(/[.,;:"'()]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function titulo(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-'])([a-záéíóúüñ])/g, function (m, a, b) { return a + b.toUpperCase(); })
      .replace(/\b(De|Del|La|Las|Los|Y|E|Sa|Srl|Sas)\b/g, function (m) { return m === 'Sa' ? 'SA' : m === 'Srl' ? 'SRL' : m === 'Sas' ? 'SAS' : m.toLowerCase(); });
  }

  // Separa cotitulares ("A Y/O B", "CERA - B") → { titular, cotitulares[], esCera }
  function partesNombre(nombre) {
    var s = String(nombre || '').trim(), esCera = false;
    if (/^CERA\s*-\s*/i.test(s)) { esCera = true; s = s.replace(/^CERA\s*-\s*/i, ''); }
    var partes = s.split(/\s+y\/o\s+|\s+Y\/O\s+/i).map(function (x) { return x.trim(); }).filter(Boolean);
    return { titular: partes[0] || s, cotitulares: partes.slice(1), esCera: esCera };
  }

  // Clave para agrupar: tokens del titular, sin acentos ni puntuación, ordenados.
  function nombreNormalizado(nombre) {
    var t = limpiar(partesNombre(nombre).titular).split(' ').filter(Boolean).sort();
    return t.join(' ');
  }

  // Nombre de pila según cómo exporta cada bróker:
  //   COCOS  "APELLIDO, NOMBRES"  → primera palabra después de la coma
  //   IOL    "Nombre Apellido"    → primera palabra
  //   BALANZ "APELLIDO NOMBRES"   → segunda palabra (dudoso con apellidos compuestos → revisar)
  function saludoSugerido(nombre, alyc, tipo) {
    var p = partesNombre(nombre), t = p.titular, revisar = false, pila = '';
    if (tipo === 'PJ') return { saludo: titulo(t), revisar: false };
    if (t.indexOf(',') >= 0) {
      pila = t.split(',')[1].trim().split(/\s+/)[0] || '';
    } else {
      var toks = t.split(/\s+/).filter(Boolean);
      if (alyc === 'BALANZ') { pila = toks[1] || toks[0] || ''; if (toks.length >= 4 || toks.length < 2) revisar = true; }
      else if (alyc === 'IOL') { pila = toks[0] || ''; }
      else { pila = toks[0] || ''; revisar = true; }
    }
    if (p.cotitulares.length || p.esCera) revisar = true;
    if (!pila) revisar = true;
    return { saludo: titulo(pila), revisar: revisar };
  }

  function alycNorm(b) {
    var s = limpiar(b);
    if (/IOL|INVERTIR/.test(s)) return 'IOL';
    if (/COCOS/.test(s)) return 'COCOS';
    if (/BALANZ/.test(s)) return 'BALANZ';
    return s;
  }
  function capitalNum(v) {
    if (typeof v === 'number') return v;
    var s = String(v || '').replace(/[^\d,.-]/g, '');
    if (!s) return 0;
    // "$1,168,730,000" (miles con coma) o "1.168.730" (miles con punto) o "1234,5"
    if (/,\d{3}(,|$)/.test(s)) s = s.replace(/,/g, '');
    else if (/\.\d{3}(\.|$)/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    var n = Number(s); return isNaN(n) ? 0 : n;
  }

  // Filas crudas (arrays) de la planilla → [{nombre, alyc, comitente, tipo, capital}] + errores.
  // Detecta el encabezado por nombre de columna; si no hay, asume el orden Cliente, Broker, Comitente, PH/PJ, Capital.
  function parseFilas(rows) {
    var ok = [], errores = [], idx = { nombre: 0, alyc: 1, comitente: 2, tipo: 3, capital: 4 }, start = 0;
    if (rows.length) {
      var head = rows[0].map(function (c) { return limpiar(c); });
      var found = false;
      head.forEach(function (c, i) {
        if (/^CLIENTE|^NOMBRE/.test(c)) { idx.nombre = i; found = true; }
        else if (/BROKER|ALYC/.test(c)) { idx.alyc = i; found = true; }
        else if (/COMITENTE|CUENTA/.test(c)) { idx.comitente = i; found = true; }
        else if (/PH|PJ|TIPO/.test(c)) { idx.tipo = i; }
        else if (/CAPITAL|MONTO/.test(c)) { idx.capital = i; }
      });
      if (found) start = 1;
    }
    for (var r = start; r < rows.length; r++) {
      var row = rows[r] || [];
      var nombre = String(row[idx.nombre] || '').trim(), alyc = alycNorm(row[idx.alyc]), com = String(row[idx.comitente] || '').replace(/\D/g, '');
      if (!nombre && !com) continue;
      if (!nombre || !com || N.ALYCS.indexOf(alyc) < 0) { errores.push({ fila: r + 1, nombre: nombre, alyc: alyc, comitente: com, motivo: !nombre ? 'sin nombre' : !com ? 'sin comitente' : 'bróker desconocido: ' + (row[idx.alyc] || '—') }); continue; }
      var tipo = /PJ|JURID/i.test(String(row[idx.tipo] || '')) ? 'PJ' : 'PH';
      ok.push({ nombre: nombre, alyc: alyc, comitente: com, tipo: tipo, capital: capitalNum(row[idx.capital]) });
    }
    return { ok: ok, errores: errores };
  }

  // Agrupa filas por nombre normalizado → clientes con sus cuentas.
  function agrupar(filas) {
    var map = {}, orden = [];
    filas.forEach(function (f) {
      var key = nombreNormalizado(f.nombre);
      if (!map[key]) {
        var p = partesNombre(f.nombre), sg = saludoSugerido(f.nombre, f.alyc, f.tipo);
        map[key] = { nameNormalized: key, name: f.nombre, greeting: sg.saludo, greetingReview: sg.revisar, type: f.tipo,
          cotitulares: p.cotitulares, accounts: [], nombresOrigen: [] };
        orden.push(key);
      }
      var c = map[key];
      if (c.nombresOrigen.indexOf(f.nombre) < 0) c.nombresOrigen.push(f.nombre);
      if (!c.accounts.some(function (a) { return a.alyc === f.alyc && a.comitente === f.comitente; })) {
        c.accounts.push({ alyc: f.alyc, comitente: f.comitente, capital: f.capital });
      }
    });
    return orden.map(function (k) { return map[k]; });
  }

  // Pares de clientes que podrían ser la misma persona (un nombre contenido en el otro).
  function posiblesDuplicados(clientes) {
    var out = [];
    for (var i = 0; i < clientes.length; i++) for (var j = i + 1; j < clientes.length; j++) {
      var a = clientes[i].nameNormalized.split(' '), b = clientes[j].nameNormalized.split(' ');
      if (a.length < 2 || b.length < 2 || a.join(' ') === b.join(' ')) continue;
      var chico = a.length <= b.length ? a : b, grande = a.length <= b.length ? b : a;
      var comunes = chico.filter(function (t) { return grande.indexOf(t) >= 0; }).length;
      if (comunes >= 2 && comunes === chico.length) out.push([clientes[i], clientes[j]]);
    }
    return out;
  }

  function capitalTotal(c) { return (c.accounts || []).reduce(function (s, a) { return s + (Number(a.capital) || 0); }, 0); }

  N.clientes = { nombreNormalizado: nombreNormalizado, saludoSugerido: saludoSugerido, partesNombre: partesNombre, titulo: titulo,
    alycNorm: alycNorm, capitalNum: capitalNum, parseFilas: parseFilas, agrupar: agrupar, posiblesDuplicados: posiblesDuplicados, capitalTotal: capitalTotal };
})();
