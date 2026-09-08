/* ============================================================
   SEED · datos iniciales que el Panel puede sembrar en Firestore
   (portafolios, tenencias del documento §4 como BORRADOR, serie legacy §9,
   fichas educativas). Se usan una sola vez; después la fuente de verdad es la base.
   ============================================================ */
(function () {
  var N = window.NORTE = window.NORTE || {};

  N.SEED = {
    portfolios: [
      { slug: "conservador", name: "Conservador", riskLevel: 1, order: 1, inceptionDate: "2025-07-01",
        description: "Prioriza preservar el capital: mayoría de renta fija (bonos, Lecaps, ONs) con una porción chica de acciones de empresas grandes." },
      { slug: "moderado", name: "Moderado", riskLevel: 2, order: 2, inceptionDate: "2025-04-01",
        description: "Equilibrio entre renta fija y acciones. Busca crecer por encima de la inflación aceptando algo de vaivén en el camino." },
      { slug: "agresivo", name: "Agresivo", riskLevel: 3, order: 3, inceptionDate: "2025-05-01",
        description: "Mayoría de acciones y CEDEARs. Apunta al mayor crecimiento a largo plazo y tolera movimientos fuertes en el corto." }
    ],

    // Tenencias vigentes según el documento (03/09/2026). Se cargan como BORRADOR
    // con fecha 02/09/2026 para que el asesor las revise y publique.
    // NOTA: el Agresivo suma 105% en la planilla: el Panel bloquea la publicación hasta corregirlo.
    versions: {
      conservador: { effectiveFrom: "2026-09-02", cclAtBuy: 1586.38, mepAtBuy: 1528.13, rationale: "",
        holdings: [
          { ticker: "BRKB", weightPct: 20, buyPriceArs: 36700, beta: 0.10 },
          { ticker: "WMT", weightPct: 10, buyPriceArs: 9630, beta: 0.97 },
          { ticker: "AO28", weightPct: 20, buyPriceArs: 144650, beta: 0.10 },
          { ticker: "AL30", weightPct: 15, buyPriceArs: 85380, beta: 0.30 },
          { ticker: "TZXM7", weightPct: 15, buyPriceArs: 222.15, beta: 0.30 },
          { ticker: "TZX27", weightPct: 10, buyPriceArs: 399.25, beta: 0.58 },
          { ticker: "YM34O", weightPct: 10, buyPriceArs: 166560, beta: 0.10 }
        ] },
      moderado: { effectiveFrom: "2026-09-02", cclAtBuy: 1586.38, mepAtBuy: 1528.13, rationale: "",
        holdings: [
          { ticker: "MSFT", weightPct: 10, buyPriceArs: 26980, beta: 1.08 },
          { ticker: "MELI", weightPct: 15, buyPriceArs: 26540, beta: 1.13 },
          { ticker: "AMD", weightPct: 10, buyPriceArs: 72725, beta: 0.37 },
          { ticker: "YPF", weightPct: 15, buyPriceArs: 8335, beta: 0.78 },
          { ticker: "AL35", weightPct: 10, buyPriceArs: 116800, beta: 0.10 },
          { ticker: "PAMP", weightPct: 10, buyPriceArs: 5395, beta: 1.27 },
          { ticker: "AE38", weightPct: 10, buyPriceArs: 120590, beta: 0.44 },
          { ticker: "S30O6", weightPct: 20, buyPriceArs: 130.56, beta: 0.97 }
        ] },
      agresivo: { effectiveFrom: "2026-09-02", cclAtBuy: 1586.38, mepAtBuy: 1528.13, rationale: "",
        holdings: [
          { ticker: "EWZ", weightPct: 10, buyPriceArs: 30200, beta: 1.48 },
          { ticker: "NU", weightPct: 15, buyPriceArs: 12310, beta: 1.08 },
          { ticker: "NVDA", weightPct: 15, buyPriceArs: 15020, beta: 0.73 },
          { ticker: "GOOGL", weightPct: 10, buyPriceArs: 9385, beta: 1.05 },
          { ticker: "LOMA", weightPct: 10, buyPriceArs: 3195, beta: 0.83 },
          { ticker: "VIST", weightPct: 10, buyPriceArs: 39800, beta: 0.62 },
          { ticker: "CEPU", weightPct: 5, buyPriceArs: 2241, beta: 2.31 },
          { ticker: "GGAL", weightPct: 10, buyPriceArs: 7090, beta: 0.91 },
          { ticker: "GD41", weightPct: 10, buyPriceArs: 114110, beta: 0.54 },
          { ticker: "T30A7", weightPct: 10, buyPriceArs: 133.39, beta: 2.31 }
        ] }
    },

    // Serie legacy de la planilla (§9): se importa tal cual, isLegacy = true.
    // Diciembre 2025 / Enero 2026 fue una sola rotación partida en mitades iguales.
    legacy: {
      conservador: [
        ["2025-07", 6.89, -0.31], ["2025-08", 1.99, 2.98], ["2025-09", 9.50, -1.16], ["2025-10", 2.04, 3.82],
        ["2025-11", 2.80, 3.33], ["2025-12", 3.75, 5.32], ["2026-01", 3.75, 5.32], ["2026-02", 0.66, 3.81],
        ["2026-03", 0.78, 1.09], ["2026-04", 2.02, 1.94], ["2026-05", 0.98, 0.27], ["2026-06", 6.15, 1.23],
        ["2026-07", 1.61, 1.24], ["2026-08", -0.26, -1.00]
      ],
      moderado: [
        ["2025-04", -5.59, 1.73], ["2025-05", 7.52, 10.59], ["2025-06", 2.25, 1.14], ["2025-07", 7.55, -3.57],
        ["2025-08", 3.75, 2.96], ["2025-09", 11.33, 0.25], ["2025-10", 8.23, 10.53], ["2025-11", -2.96, -3.42],
        ["2025-12", -3.72, -3.06], ["2026-01", -3.72, -3.06], ["2026-02", -0.61, -0.15], ["2026-03", 1.97, 2.31],
        ["2026-04", 2.68, 2.75], ["2026-05", 5.30, 5.46], ["2026-06", -2.04, -6.79], ["2026-07", 5.97, 6.74],
        ["2026-08", 0.37, -0.05]
      ],
      agresivo: [
        ["2025-05", 8.61, 10.36], ["2025-06", 3.29, 1.28], ["2025-07", 2.75, -10.50], ["2025-08", -5.42, -1.87],
        ["2025-09", -5.85, -17.11], ["2025-10", 25.20, 27.10], ["2025-11", 5.00, 4.78], ["2025-12", -4.69, -4.71],
        ["2026-01", -4.69, -4.71], ["2026-02", -13.03, -8.92], ["2026-03", 3.49, 3.28], ["2026-04", 3.55, 4.03],
        ["2026-05", 6.56, 5.74], ["2026-06", 1.99, -2.21], ["2026-07", 3.97, 3.48], ["2026-08", -0.24, 0.24]
      ]
    },

    // Fichas educativas: una por tipo de instrumento. Texto corto, sin jerga sin definir.
    education: [
      { slug: "cedear", title: "¿Qué es un CEDEAR?", order: 1, isPublished: true,
        body: "Es un certificado que se compra en pesos en la bolsa argentina y representa acciones de una empresa que cotiza afuera (por ejemplo Microsoft o Coca-Cola).\n\nCada CEDEAR equivale a una fracción de la acción original: ese número se llama ratio. Su precio en pesos sigue al precio de la acción en dólares multiplicado por el dólar contado con liquidación (CCL). Por eso, aunque se compre en pesos, en la práctica es una inversión dolarizada.\n\nRiesgo: el de la empresa y el del tipo de cambio." },
      { slug: "accion", title: "¿Qué es una acción?", order: 2, isPublished: true,
        body: "Es una porción chiquita de una empresa. Al comprarla te convertís en socio: si a la empresa le va bien, la acción tiende a subir y puede pagar dividendos; si le va mal, baja.\n\nLas acciones argentinas (YPF, Galicia, Pampa, etc.) cotizan en pesos en la bolsa local.\n\nRiesgo: alto. Es el instrumento que más sube y más baja en el corto plazo, y el que históricamente más rinde a largo plazo." },
      { slug: "bono-soberano", title: "¿Qué es un bono soberano?", order: 3, isPublished: true,
        body: "Es un préstamo que le hacés al Estado argentino. A cambio, el Estado se compromete a devolverte el capital en cuotas y a pagarte intereses en fechas fijas, en dólares.\n\nLos Bonares (AL30, AL35, AO28...) y Globales (GD35, GD41...) son los más operados. Se compran en pesos o en dólares y su precio sube o baja según la confianza del mercado en que Argentina pague.\n\nRiesgo: medio a alto, depende sobre todo del riesgo país." },
      { slug: "bono-cer", title: "¿Qué es un bono CER?", order: 4, isPublished: true,
        body: "Es un bono del Estado que ajusta por inflación: su capital crece con el índice CER, que sigue al índice de precios (IPC), y además paga una tasa chica por encima.\n\nSirve para proteger los pesos de la inflación. Los Boncer (TZXM7, TZX27...) son ejemplos.\n\nRiesgo: medio. Cubre la inflación, pero su precio se mueve con las expectativas de tasas y con el riesgo del Estado." },
      { slug: "on", title: "¿Qué es una obligación negociable (ON)?", order: 5, isPublished: true,
        body: "Es un préstamo que le hacés a una empresa (YPF, Pampa, Telecom...) en lugar de al Estado. La empresa devuelve el capital y paga intereses en fechas fijas, en general en dólares.\n\nSuelen rendir más que un plazo fijo en dólares y menos que las acciones. Algunas operan poco: puede haber días sin precio.\n\nRiesgo: medio a bajo, depende de la solidez de la empresa." },
      { slug: "lecap", title: "¿Qué es una Lecap?", order: 6, isPublished: true,
        body: "Es una letra del Tesoro a tasa fija en pesos, de corto plazo (meses). Se compra a un precio y al vencimiento se cobra un valor mayor: la diferencia es el interés, que se conoce de antemano.\n\nEs la alternativa más parecida a un plazo fijo, pero con la ventaja de que se puede vender antes del vencimiento.\n\nRiesgo: bajo en pesos. No cubre la suba del dólar ni de la inflación si terminan siendo mayores que la tasa." },
      { slug: "boncap", title: "¿Qué es un Boncap?", order: 7, isPublished: true,
        body: "Es lo mismo que una Lecap pero a plazo más largo (más de un año): un bono del Tesoro a tasa fija en pesos que capitaliza los intereses y paga todo al vencimiento.\n\nAl ser más largo, su precio se mueve más cuando cambian las tasas de interés: si las tasas bajan, sube más que una Lecap; si suben, baja más.\n\nRiesgo: medio en pesos." },
      { slug: "etf", title: "¿Qué es un ETF?", order: 8, isPublished: true,
        body: "Es un fondo que cotiza como una acción y que replica un índice o un conjunto de empresas: por ejemplo, el EWZ sigue a las principales empresas de Brasil.\n\nEn Argentina se compran como CEDEARs, en pesos, y quedan dolarizados vía el dólar CCL. Con una sola compra diversificás en muchas empresas.\n\nRiesgo: el del mercado que replica." },
      { slug: "fci", title: "¿Qué es un fondo común de inversión (FCI)?", order: 9, isPublished: true,
        body: "Es una canasta de inversiones administrada por profesionales. Ponés tu dinero junto con el de otros inversores y el fondo lo invierte según su objetivo (plazo fijo, bonos, acciones, dólares).\n\nEl valor de tu parte se llama cuotaparte y se publica todos los días.\n\nRiesgo: depende del tipo de fondo, desde muy bajo (money market) hasta alto (acciones)." }
    ]
  };
})();
