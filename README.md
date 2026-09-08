# Norte Inversiones · App de portafolios sugeridos

App web instalable (PWA) para que los clientes vean los tres portafolios sugeridos
(Conservador / Moderado / Agresivo) con rendimiento en vivo, y panel para que
Ramiro y Luciano carguen la rotación de cada mes.

Todo gratuito: Firebase (plan Spark) para datos y login; GitHub para el código,
la publicación de la web y la captura diaria de precios.

## Estructura

| Carpeta / archivo | Qué es |
|---|---|
| `ingest/` | Script de captura de precios (corre en GitHub Actions todos los días hábiles) |
| `.github/workflows/precios.yml` | Horarios de la captura |
| `firestore.rules` | Reglas de seguridad de la base (se pegan en la consola de Firebase) |
| `index.html`, `js/`, `css/` | La app (cliente + panel). Próximas etapas |

## Puesta en marcha (una sola vez)

### 1. Clave de la cuenta de servicio de Firebase
La captura de precios necesita permiso para escribir en la base. Lo hacés vos:

1. Consola de Firebase → proyecto **portafolios-sugeridos** → ⚙ *Configuración del proyecto* → pestaña **Cuentas de servicio**.
2. Botón **Generar nueva clave privada** → se descarga un archivo `.json`.
3. En GitHub, en este repositorio: **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: abrí el `.json` con el Bloc de notas, copiá TODO el contenido y pegalo.
4. Borrá el `.json` de tu PC o guardalo en un lugar seguro. **Nunca lo subas al repositorio.**

### 2. Reglas de Firestore
Consola de Firebase → **Firestore Database → Reglas** → pegar el contenido de `firestore.rules` → **Publicar**.

### 3. Probar la captura a mano
GitHub → pestaña **Actions** → *Precios* → **Run workflow** → modo `eod` → Run.
En un minuto tiene que aparecer en Firestore la colección `quotes` con un documento de la fecha de hoy.

### 4. Publicar la web (cuando exista la app)
GitHub → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main` / `/ (root)` → Save.
La app queda en `https://<usuario>.github.io/<repositorio>/`.

## Horarios de captura (hora Argentina)

| Cuándo | Qué hace |
|---|---|
| Lunes a viernes, cada 10 min de 11:00 a 17:50 | Intradía: actualiza `quotes/live` |
| Lunes a viernes 19:15 y 20:45 | Cierre del día: crea `quotes/AAAA-MM-DD` (histórico) |

Feriados: si los precios son idénticos al último cierre, el día se guarda marcado como
*sin rueda* y no entra en el histórico.

## Importante
- GitHub apaga las tareas programadas si el repositorio no tiene actividad (commits) durante
  60 días. Avisa por mail; se reactivan con un clic en la pestaña Actions.
- El panel de salud de la ingesta (dentro de la app) muestra la última corrida y los tickers
  sin precio.
