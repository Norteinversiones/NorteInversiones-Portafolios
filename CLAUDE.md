# CLAUDE.md · App de portafolios sugeridos · Norte Inversiones

Guía para cualquier sesión de Claude (o Claude Code) que trabaje en esta app.
**Leela entera antes de cambiar nada.** Última actualización: 11/11/2026.

---

## 1. Quién la usa y cómo trabajar con ellos

- Dueños: **Ramiro** (fundador) y **Luciano** (socio), contadores y asesores financieros (Agente Productor CNV, matrícula N.° 2060).
- **No son programadores.** Explicá todo en español rioplatense, sin jerga, paso a paso. Cuando haya que tocar algo a mano (consola de Firebase, GitHub), decí exactamente dónde hacer clic.
- Los dos entran al Panel con la **misma cuenta de Google**: `norteahorro@gmail.com`. No hace falta agregar otro admin.
- Clientes: inversores minoristas, muchos sin conocimientos. Todo lo que ve el cliente tiene que ser claro y simple.
- Antes de un cambio grande o riesgoso: **guardar un respaldo** (zip en `App portafolios\Respaldos\`) y avisar.

## 2. Qué es la app

Una web instalable (PWA) con dos partes:

| Parte | Archivo | Quién la usa | Cómo se entra |
|---|---|---|---|
| App de clientes | `index.html` + `js/app.js` | clientes | número de comitente + bróker (IOL, Cocos, Balanz) |
| Panel | `admin.html` + `js/admin.js` | Ramiro y Luciano | Google (`norteahorro@gmail.com`) |

- Muestra los **3 portafolios sugeridos** (Conservador, Moderado, Agresivo), su composición, rendimiento en vivo, histórico, rotaciones, simulador y comparación.
- El Panel carga y publica la **rotación mensual**, administra el catálogo de instrumentos, los clientes (gestor tipo CRM) y la salud del robot de precios.

## 3. Dónde vive cada cosa

- **Código:** GitHub `Norteinversiones/NorteInversiones-Portafolios` (repositorio **público**: nunca subir claves, datos de clientes ni documentos internos).
- **Web publicada:** GitHub Pages → `https://norteinversiones.github.io/NorteInversiones-Portafolios/` (Panel en `/admin.html`). Se publica sola con cada push a `main`, en 1-2 minutos.
- **Base de datos y login:** Firebase, proyecto `portafolios-sugeridos` (plan gratuito Spark).
- **Robot de precios:** GitHub Actions (`.github/workflows/precios.yml` + `ingest/capture.js`). Usa el secreto `FIREBASE_SERVICE_ACCOUNT`.
- **Carpeta local:** `C:\Users\Usuario\Desktop\Norte Ahorro e Inversiones\Claude NORTE\Apss\App portafolios\NUEVA APP` (copia de trabajo del repositorio; `docs-privados/` y `CONTEXTO-APP-PORTAFOLIOS-v2.md` no se suben, están en `.gitignore`).
- ⚠️ **La carpeta local y GitHub pueden estar desfasadas.** Antes de trabajar, confirmá cuál es la versión más nueva (`git log`) y sincronizá. Nunca pises cambios de GitHub con archivos locales viejos.

### Archivos principales

| Archivo | Qué hace |
|---|---|
| `js/engine.js` | **Motor de cálculo.** Todo rendimiento se calcula acá (y solo acá). Funciona en navegador y en Node. |
| `js/db.js` | Lectura/escritura en Firestore. No calcula nada. |
| `js/recompute.js` | Recalcula y guarda rendimientos de un portafolio (lo dispara el Panel). |
| `js/app.js`, `css/client.css` | App de clientes. |
| `js/admin.js`, `js/admin-clientes.js`, `js/clientes.js` | Panel (rotación, histórico, catálogo, clientes, ingesta). |
| `js/charts.js` | Gráficos SVG propios (barras, líneas, dona, sparkline). |
| `js/ticker.js` | Cinta de cotizaciones de la app de clientes. |
| `js/seed.js` | Datos de arranque (portafolios y tenencias iniciales). |
| `js/firebase-config.js` | Config pública de Firebase, mails admin, ALyCs y tipos de instrumento. |
| `ingest/capture.js` | Robot: captura precios, cinta de mercado y recalcula portafolios. |
| `firestore.rules` | Reglas de seguridad. **Se pegan a mano en la consola de Firebase** (ver §7). |
| `sw.js` | Service worker (caché de la PWA). |
| `tests/engine.test.js` | Pruebas del motor (`node tests/engine.test.js`). |

## 4. Reglas de diseño del código (respetarlas siempre)

1. **JavaScript simple, sin bundler ni frameworks**: archivos `.js` cargados por `<script>`, cada uno envuelto en `(function () { ... })()`, estilo ES5 (`var`, `function`). Firebase por CDN (SDK *compat* 10.12.2).
2. **Ningún cálculo de rendimiento fuera de `engine.js`.** La app, el Panel y el robot usan el mismo motor. Si agregás lógica de rendimiento, va en `engine.js` con su prueba en `tests/engine.test.js`.
3. Textos, nombres de variables nuevas y comentarios **en español**.
4. Todo HTML que muestre datos pasa por `h()` (escapa caracteres) para evitar inyección.
5. **Cada vez que cambies JS o CSS:** subí el número `?v=AAAAMMDDHHMM` en **todos** los `<script>`/`<link>` de `index.html` y `admin.html`, y la `VERSION` de `sw.js`. Si no, los navegadores pueden mezclar versiones.
6. Identidad visual: **solo blanco, negro y amarillo** (`#FFD600`). Verde y rojo **solo** para resultados positivos/negativos. Tipografías: Fraunces (títulos) e Inter (texto). Mobile-first.
7. Siempre que muestres rendimientos al cliente, acompañar con el aviso legal existente (no es recomendación personalizada, rendimientos pasados, delay de cotizaciones).

## 5. Reglas de negocio de los rendimientos

- **Acumulado siempre compuesto** (nunca suma aritmética).
- **Mes calendario:** el rendimiento mensual se reinicia el primer día de cada mes, haya o no rotación. Si hay rotación a mitad de mes, se encadenan los tramos (segmentos).
- Primer tramo de una rotación: desde los **precios de compra** cargados en la rotación. Tramos siguientes: desde el **cierre del día anterior**.
- **Meses cerrados son inmutables**: no se recalculan salvo "Recalcular todo" (pide confirmación).
- **USD:** precio ARS ÷ CCL del día.
- **Histórico legacy:** los meses anteriores a la app vienen de la SuperPlanilla (marcados `isLegacy`), medidos rotación a rotación. Desde la primera rotación cargada en la app, se mide por mes calendario. Sin backfill.
- Un instrumento sin precio en un día se arrastra desde el último precio disponible (sin interpolar).
- Versiones: `draft` (borrador, solo admin) → `published` → `replaced` (por una corrección con la misma fecha). Solo las publicadas cuentan.
- **Cupones y amortizaciones** (desde 11/11/2026, ver §8.4): suman al rendimiento si el activo está en cartera en la fecha de pago.

## 6. Datos en Firestore

| Colección | Contenido | Quién lee |
|---|---|---|
| `instruments/{TICKER}` | catálogo; en renta fija incluye `payments: [{date, interest, amort, currency}]` | todos |
| `quotes/{AAAA-MM-DD}`, `quotes/live` | cierres diarios e intradía (`prices`, `fx.ccl`, `fx.mep`) | todos |
| `market/ticker` | cinta (S&P, Nasdaq, Merval, oro, WTI, MEP, riesgo país) | todos |
| `portfolios/{slug}` | conservador / moderado / agresivo + `stats` (resumen calculado) | clientes con sesión, admin |
| `portfolios/{slug}/versions/{id}` | una por rotación (tenencias, precios de compra, CCL, rationale) | publicadas: clientes con sesión; todas: admin |
| `portfolios/{slug}/monthly_returns/{AAAA-MM}` | rendimiento de cada mes (incluye `couponArs/Usd`, `payments`) | clientes con sesión, admin |
| `authorized_accounts/{ALYC_COMITENTE}` | índice de login: **solo saludo, nunca nombre completo** | un doc por id, con sesión anónima |
| `sessions/{uid}` | con qué comitente entró cada sesión y cuándo (`at` = último ingreso) | la propia sesión, admin |
| `clients/{id}` | gestor de clientes (nombre, cuentas, capital, contacto, referido) | solo admin |
| `education/{slug}` | fichas educativas (hoy desactivadas en la app) | publicadas: clientes con sesión |
| `jobs/ingesta` | salud del robot | admin |

## 7. Seguridad (no romper)

- **Login de clientes:** la app inicia una **sesión anónima de Firebase** (proveedor "Anónimo" habilitado en Authentication) y escribe `sessions/{uid}` con su `ALYC_COMITENTE`. Las reglas solo dejan leer portafolios si esa sesión apunta a una cuenta **autorizada y activa**. Si se desactiva un cliente en el gestor, pierde acceso al instante.
- La app de clientes usa una instancia de Firebase propia (`db.init('cliente')`) para no mezclar su sesión con el login de Google del Panel.
- `authorized_accounts` es consultable desde afuera por id: **nunca guardar ahí el nombre completo** ni datos personales. El Panel limpia automáticamente `clientName` al abrirse.
- Escritura: solo `norteahorro@gmail.com` con email verificado. El robot escribe con cuenta de servicio (no pasa por las reglas).
- **Las reglas no se publican con GitHub.** Si cambiás `firestore.rules`, el usuario tiene que pegarlas en Firebase → Firestore Database → Reglas → Publicar. Orden seguro: primero subir el código (compatible con reglas viejas y nuevas), probar, y recién después pegar las reglas. Las reglas anteriores están en el respaldo.

## 8. Cambios incorporados el 11/11/2026

Respaldo previo: `App portafolios\Respaldos\respaldo-app-portafolios-2026-11-11.zip` (estado al commit `5f79e01`).

### 8.1 Seguridad (`a75e798`)
- `authorized_accounts` deja de guardar el nombre completo (solo el saludo). Limpieza automática al abrir el Panel.
- Portafolios, versiones, mensuales y fichas: solo para clientes con sesión válida o admin. Precios, catálogo y cinta siguen abiertos.
- Nueva colección `sessions`. Proveedor Anónimo habilitado. Reglas nuevas publicadas en Firebase.

### 8.2 Mensaje de rotación para WhatsApp (`457226b`)
- Panel → Rotación → tarjeta **"Mensaje para el grupo"**: se genera solo al publicar o con "Generar mensaje"; editable, botones Copiar y Abrir en WhatsApp.
- Compara la versión vigente de cada portafolio contra la publicada anterior. Si un portafolio no rotó en los últimos 10 días respecto de la rotación más reciente, sale "Sin cambios en esta rotación".
- Formato (definido por Ramiro, respetarlo):
  ```
  A continuación, las rotaciones de cada cartera.

  🟢 CONSERVADOR

  ➡️ Sale AL30 (15%)
  ➡️ Entra RSP (15%)

  ( - ) Reduce AO28 (10% → 5%)
  (+) Aumenta YM34O (5%)

  💵 Cobro de cupón YM34O (+0,35% al rendimiento de la cartera)

  <rationale de la rotación>
  ```
  🟢 Conservador, 🟡 Moderado, 🔴 Agresivo. Bloques separados por dos líneas en blanco. "Aumenta" muestra cuánto sube; "Reduce" muestra de cuánto a cuánto.
- Funciones del motor: `diffHoldings(prev, cur)` y `rotationMessage(items)`.

### 8.3 App de clientes: qué cambió + calculadora (`690165f`)
- **Qué cambió:** en Rotaciones (cada rotación: Qué cambió → Por qué → Composición completa), en Tenencias (tarjeta de la última rotación) y aviso amarillo en el inicio durante 10 días (cerrable; se guarda en `localStorage` `norte_rot_vista`).
- **Calculadora por monto** en Tenencias: reparte el monto según los pesos, a precios actuales. Renta fija (bonos, ONs, Lecaps, Boncaps) en **nominales asumiendo precio cada 100 VN**; CEDEARs/acciones/ETFs en unidades enteras; FCI solo monto. Muestra el sobrante por redondeo. Monto recordado en `localStorage` `norte_monto`. En modo US$ convierte al CCL.
- ⚠️ Pendiente de validar con datos reales que todos los precios de renta fija vengan cada 100 VN.

### 8.4 Rendimiento por cobro de cupón y amortización (`d27fa36`)
- Se cargan a mano en **Panel → Catálogo → (bono/ON/letra) → Cobros**: fecha de pago, renta, amortización, moneda. Montos **cada 100 nominales** (misma unidad que el precio).
- Motor: `quoteBook(quotes, live, paymentsOf(instruments))`. En cada tramo, rendimiento = Σ peso × ((precio final + cobros) / precio inicial − 1). Pagos en USD se pasan a pesos con el CCL del día de pago.
- Ventana de cobro por fecha calendario `(inicio, fin]`: quien compra el día del pago **no** lo cobra; la cartera que sale ese día sí. No se cuenta dos veces entre meses. Un pago con fecha posterior al último precio todavía no cuenta.
- El efectivo cobrado no se reinvierte hasta el próximo corte (fin de mes o rotación).
- Se informa por separado qué parte es cupón: `couponArs/couponUsd` y `payments` en segmentos, meses y `stats.current`; `couponPctArs/Usd` en tenencias.
- Dónde se ve: inicio, detalle (frase explicativa), Tenencias ("cupón +x%"), Rotaciones e Histórico (lista de cobros), Simulador y mensaje de WhatsApp (líneas 💵).
- Al guardar cobros en el Catálogo se recalculan los portafolios (sin tocar meses cerrados). Para un pago de un mes ya cerrado: **"Recalcular todo"** en Rotación.
- El robot (`ingest/capture.js`) usa el mismo cálculo.

### 8.5 Caché de la app (`dd98182`)
- Bug corregido: el service worker servía primero lo guardado e ignoraba el `?v=`, y mezclaba versiones ("E.paymentsOf is not a function").
- Ahora es **red primero** (la caché solo se usa sin conexión).
- Autocorrección en `app.js` y `admin.js`: si `engine.js` cargado no tiene `paymentsOf`, limpian caché y service worker y recargan **una vez** (flag en `sessionStorage`). Si en el futuro agregás funciones nuevas al motor que la app necesite sí o sí, actualizá esa verificación.

## 9. Cómo probar antes de publicar

1. `node tests/engine.test.js` → tiene que dar todas OK (hoy: 32/32). También corren solas en GitHub (workflow "Pruebas") en cada push.
2. `for f in js/*.js ingest/*.js tests/*.js; do node --check "$f"; done`
3. Para pantallas: servir la carpeta y abrirla con Playwright simulando Firebase (no hay emulador disponible); revisar a ancho de celular (390 px).
4. Lo que dependa de datos reales o de la cuenta de Google: pedirle al usuario que lo pruebe y decirle exactamente qué mirar.

## 10. Robot de precios (GitHub Actions)

| Cuándo (hora Argentina, lun-vie) | Qué hace |
|---|---|
| Cada 10 min, 11:00-17:50 | intradía → `quotes/live` |
| 19:15 y 20:45 | cierre → `quotes/AAAA-MM-DD` + recálculo de portafolios |
| Cada 30 min, 10:00-18:30, y 20:00 | cinta de mercado → `market/ticker` |

Fuentes: data912 (precios ARS de acciones, CEDEARs, bonos, letras, ONs), dolarapi (CCL, MEP), Yahoo Finance (índices, oro, petróleo), argentinadatos (riesgo país). Feriados: si los precios son idénticos al último cierre, se marca "sin rueda".
⚠️ GitHub apaga las tareas programadas si el repositorio pasa 60 días sin commits (avisa por mail; se reactivan en la pestaña Actions).

## 11. Pendientes acordados (orden sugerido)

Clientes:
- Simulador en plata ("si ponías $X hoy tendrías $Y") y recordar la fecha de compra.
- Referencias en Comparar: inflación, plazo fijo, Merval, S&P en CCL.
- Métricas de riesgo simples: peor/mejor mes, % de meses positivos, caída máxima.
- Reactivar las fichas educativas (hoy `#/aprender` redirige al inicio; la etiqueta de tipo no abre nada).
- Botón de WhatsApp "Quiero armar esta cartera".

Panel:
- Registro de uso (último ingreso por cliente; el dato ya se guarda en `sessions.at`).
- Perfil de riesgo en la ficha del cliente.
- Tablero de capital (total, por bróker, por referidor, evolución).
- Vista previa antes de publicar una rotación.
- Pesos actuales vs. originales (deriva por precio).
- Alerta si falla el robot de precios.
- Informe mensual en PDF.

Visual:
- Colores de portafolios: el rojo del Agresivo se confunde con pérdida y el amarillo del Moderado se ve poco en líneas; usar negro/amarillo/gris o trazos distintos y dejar verde/rojo solo para resultados.
- Dona de composición → barras horizontales con %.
- Barra inferior: sacar "Salir" (pasarlo al encabezado) y usar el lugar para Aprender/Novedades.
- Íconos SVG en vez de caracteres (◆ ≡ ⏻).
- Mejor aprovechamiento en escritorio (hoy ancho máx. 760 px).
- Modo oscuro; esqueletos de carga en vez de "Cargando…".

Notificaciones push (rotaciones y cierre diario con emojis): en pausa por decisión de los dueños.
