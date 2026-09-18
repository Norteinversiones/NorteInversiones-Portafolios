/* ============================================================
   CHARTS · gráficos SVG livianos (sin librerías) para la app cliente.
   Paleta: negro, amarillo, grises; verde/rojo sólo para resultados.
   Todos devuelven un string SVG responsive (viewBox + width 100%).
   ============================================================ */
(function () {
  var N = window.NORTE = window.NORTE || {};
  var POS = '#1E8E3E', NEG = '#D93025', NEGRO = '#111111', AMARILLO = '#FFD600', GRIS = '#9A9A9A', GRIS_C = '#E6E6E6';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function niceStep(range, ticks) {
    var raw = range / Math.max(1, ticks), p = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / p;
    var s = r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1;
    return s * p;
  }
  function fmtTick(v) { return (Math.round(v * 10) / 10).toString().replace('.', ',') + '%'; }

  // ---- Barras mensuales: items [{label, value, legacy, current}] ----
  function bars(opts) {
    var items = opts.items || [], W = 720, H = opts.height || 250, padL = 44, padR = 8, padT = 24, padB = 34;
    if (!items.length) return '<p class="muted">Sin datos todavía.</p>';
    var vals = items.map(function (i) { return Number(i.value) || 0; });
    var max = Math.max(0, Math.max.apply(null, vals)), min = Math.min(0, Math.min.apply(null, vals));
    if (max === min) { max = 1; min = -1; }
    var step = niceStep(max - min, 4);
    max = Math.ceil(max / step) * step; min = Math.floor(min / step) * step;
    var ih = H - padT - padB, iw = W - padL - padR;
    var y = function (v) { return padT + (max - v) / (max - min) * ih; };
    var n = items.length, slot = iw / n, bw = Math.min(28, slot * 0.7);
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Rendimiento mensual">';
    for (var t = min; t <= max + 1e-9; t += step) {
      out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="' + (Math.abs(t) < 1e-9 ? NEGRO : GRIS_C) + '" stroke-width="' + (Math.abs(t) < 1e-9 ? 1.2 : 1) + '"/>';
      out += '<text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" font-size="11" text-anchor="end" fill="' + GRIS + '">' + fmtTick(t) + '</text>';
    }
    var labelEvery = n > 18 ? 3 : n > 9 ? 2 : 1;
    items.forEach(function (it, i) {
      var v = vals[i], x = padL + i * slot + (slot - bw) / 2;
      var top = Math.min(y(0), y(v)), h = Math.abs(y(v) - y(0));
      var fill = v >= 0 ? POS : NEG;
      // Cada barra es un grupo: al tocarla (o pasar el mouse) se muestra el % del mes.
      out += '<g class="bar' + (it.current ? ' on' : '') + '" tabindex="0" role="button" aria-label="' + esc(it.title || it.label) + ': ' + fmtTick(v) + '">' +
        '<rect x="' + (padL + i * slot) + '" y="' + padT + '" width="' + slot + '" height="' + ih + '" fill="transparent"/>' +
        '<rect x="' + x + '" y="' + top + '" width="' + bw + '" height="' + Math.max(1, h) + '" rx="3" fill="' + fill + '"' + (it.legacy ? ' opacity="0.45"' : '') + (it.current ? ' stroke="' + AMARILLO + '" stroke-width="2"' : '') + '/>' +
        '<text class="val" x="' + (x + bw / 2) + '" y="' + (v >= 0 ? top - 5 : top + h + 12) + '" font-size="11" font-weight="600" text-anchor="middle" fill="' + NEGRO + '">' + fmtTick(v) + '</text></g>';
      if (i % labelEvery === 0 || i === n - 1) out += '<text x="' + (x + bw / 2) + '" y="' + (H - padB + 16) + '" font-size="11" text-anchor="middle" fill="' + GRIS + '">' + esc(it.label) + '</text>';
    });
    return out + '</svg>';
  }

  // ---- Líneas: series [{name, color, points:[number|null]}], labels [] ----
  function lines(opts) {
    var series = opts.series || [], labels = opts.labels || [], W = 720, H = opts.height || 240, padL = 48, padR = 10, padT = 14, padB = 30;
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { if (p != null) all.push(p); }); });
    if (!all.length) return '<p class="muted">Sin datos todavía.</p>';
    var max = Math.max(0, Math.max.apply(null, all)), min = Math.min(0, Math.min.apply(null, all));
    if (max === min) { max += 1; min -= 1; }
    var step = niceStep(max - min, 4);
    max = Math.ceil(max / step) * step; min = Math.floor(min / step) * step;
    var ih = H - padT - padB, iw = W - padL - padR, n = labels.length;
    var x = function (i) { return n > 1 ? padL + i / (n - 1) * iw : padL + iw / 2; };
    var y = function (v) { return padT + (max - v) / (max - min) * ih; };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Acumulado">';
    for (var t = min; t <= max + 1e-9; t += step) {
      out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="' + (Math.abs(t) < 1e-9 ? NEGRO : GRIS_C) + '"/>';
      out += '<text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" font-size="11" text-anchor="end" fill="' + GRIS + '">' + fmtTick(t) + '</text>';
    }
    var labelEvery = n > 18 ? 3 : n > 9 ? 2 : 1;
    labels.forEach(function (l, i) { if (i % labelEvery === 0 || i === n - 1) out += '<text x="' + x(i) + '" y="' + (H - padB + 16) + '" font-size="11" text-anchor="middle" fill="' + GRIS + '">' + esc(l) + '</text>'; });
    series.forEach(function (s) {
      var d = '', started = false;
      s.points.forEach(function (p, i) { if (p == null) { started = false; return; } d += (started ? ' L' : ' M') + x(i).toFixed(1) + ' ' + y(p).toFixed(1); started = true; });
      out += '<path d="' + d.trim() + '" fill="none" stroke="' + (s.color || NEGRO) + '" stroke-width="' + (s.width || 2.5) + '" stroke-linejoin="round" stroke-linecap="round"' + (s.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
      var last = -1; s.points.forEach(function (p, i) { if (p != null) last = i; });
      if (last >= 0) out += '<circle cx="' + x(last) + '" cy="' + y(s.points[last]) + '" r="4" fill="' + (s.color || NEGRO) + '"/>';
    });
    return out + '</svg>';
  }

  // ---- Donut: slices [{label, value}] ----
  var DONUT_COLORS = ['#111111', '#FFD600', '#6B6B6B', '#B8B8B8', '#3D3D3D', '#E0C200', '#8F8F8F', '#D9D9D9', '#262626'];
  function donut(opts) {
    var slices = (opts.slices || []).filter(function (s) { return s.value > 0; });
    var total = slices.reduce(function (a, s) { return a + s.value; }, 0);
    if (!total) return '';
    var R = 60, r = 38, cx = 70, cy = 70, a0 = -Math.PI / 2;
    var out = '<svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Composición">';
    slices.forEach(function (s, i) {
      var a1 = a0 + s.value / total * 2 * Math.PI;
      var large = a1 - a0 > Math.PI ? 1 : 0;
      var p = function (a, rad) { return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
      if (slices.length === 1) {
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none" stroke="' + DONUT_COLORS[0] + '" stroke-width="' + (R - r) + '"/>';
      } else {
        out += '<path d="M' + p(a0, R) + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + p(a1, R) + ' L' + p(a1, r) + ' A' + r + ' ' + r + ' 0 ' + large + ' 0 ' + p(a0, r) + ' Z" fill="' + DONUT_COLORS[i % DONUT_COLORS.length] + '"><title>' + esc(s.label) + ' ' + fmtTick(s.value) + '</title></path>';
      }
      a0 = a1;
    });
    out += '</svg>';
    var legend = '<ul class="legend">' + slices.map(function (s, i) {
      return '<li><span class="sw" style="background:' + DONUT_COLORS[i % DONUT_COLORS.length] + '"></span>' + esc(s.label) + ' <b>' + fmtTick(s.value) + '</b></li>';
    }).join('') + '</ul>';
    return '<div class="donutwrap">' + out + legend + '</div>';
  }

  // ---- Sparkline: mini línea sin ejes. values [] (% acumulado), color de identificación ----
  function sparkline(values, color, opts) {
    opts = opts || {};
    var vals = (values || []).filter(function (v) { return v != null && !isNaN(v); });
    if (vals.length < 2) return '';
    var W = opts.width || 160, H = opts.height || 40, pad = 3;
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (max === min) { max += 0.5; min -= 0.5; }
    var n = vals.length;
    var x = function (i) { return pad + i / (n - 1) * (W - 2 * pad); };
    var y = function (v) { return pad + (max - v) / (max - min) * (H - 2 * pad); };
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    var area = d + ' L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' L' + x(0).toFixed(1) + ' ' + (H - pad) + ' Z';
    var out = '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" preserveAspectRatio="none" role="img" aria-label="Evolución de los últimos 30 días">';
    if (min < 0 && max > 0) out += '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" stroke="' + GRIS_C + '" stroke-width="1" stroke-dasharray="3 3"/>';
    out += '<path d="' + area + '" fill="' + (color || NEGRO) + '" opacity="0.10"/>';
    out += '<path d="' + d + '" fill="none" stroke="' + (color || NEGRO) + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    out += '<circle cx="' + x(n - 1).toFixed(1) + '" cy="' + y(vals[n - 1]).toFixed(1) + '" r="2.6" fill="' + (color || NEGRO) + '"/>';
    return out + '</svg>';
  }

  N.charts = { bars: bars, lines: lines, donut: donut, sparkline: sparkline, COLORS: { pos: POS, neg: NEG, negro: NEGRO, amarillo: AMARILLO, gris: GRIS } };
})();
