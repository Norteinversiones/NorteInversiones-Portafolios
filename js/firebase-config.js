/* ============================================================
   FIREBASE CONFIG · proyecto "portafolios-sugeridos".
   Es seguro exponer esta config en el front: la seguridad real está en
   firestore.rules (escritura sólo para los mails admin).
   ============================================================ */
window.NORTE = window.NORTE || {};

NORTE.firebaseConfig = {
  apiKey: "AIzaSyCKkgUK7710Lk_QRi-yw7-23LwmOGlg8l0",
  authDomain: "portafolios-sugeridos.firebaseapp.com",
  projectId: "portafolios-sugeridos",
  storageBucket: "portafolios-sugeridos.firebasestorage.app",
  messagingSenderId: "403060351837",
  appId: "1:403060351837:web:866f279dfcbfd7c5a4feb4"
};

// Mails autorizados para el Panel. DEBEN coincidir con firestore.rules.
NORTE.adminEmails = ["norteahorro@gmail.com"];

// ALyCs con las que operan los clientes (id de cuenta = ALYC_COMITENTE).
NORTE.ALYCS = ["IOL", "COCOS", "BALANZ"];

// Tipos de instrumento (lista cerrada, extensible desde acá).
NORTE.TIPOS = {
  CEDEAR: "CEDEAR", ACCION: "Acción", BONO_SOBERANO: "Bono soberano", BONO_CER: "Bono CER",
  ON: "Obligación negociable", LECAP: "Lecap", BONCAP: "Boncap", ETF: "ETF", FCI: "Fondo común"
};
