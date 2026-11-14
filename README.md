# Trackerbbx — refactor per Cloudflare Pages

Copia indipendente del repository `motors78/Trackerbbx`, predisposta per Cloudflare Pages e Pages Functions. Il frontend mantiene i dati personali nel browser; le chiamate ai provider passano da una funzione same-origin e da destinazioni upstream definite nel codice.

## Avvio e pubblicazione

- Doppio click su `index.html` apre l'interfaccia locale. API e risultati live richiedono il sito pubblicato o il dev server Pages.
- Collega questa cartella a un progetto Cloudflare Pages tramite Git. Usa la root del repository come directory del progetto, nessun comando di build e `.` come directory di output. `wrangler.jsonc` contiene già `pages_build_output_dir`.
- La struttura `functions/api/proxy.js` crea la route `/api/proxy`; `_routes.json` limita l'esecuzione delle Functions a quell'endpoint così le risorse statiche restano statiche.
- Per lo sviluppo locale, usa `npx wrangler pages dev .`. Aggiungi i secret al progetto Pages o in un file locale `.dev.vars` (mai versionato).

La documentazione Cloudflare descrive il routing Pages Functions dal percorso dei file e la selezione delle route tramite `_routes.json`: [routing ufficiale](https://developers.cloudflare.com/pages/functions/routing/).

## Struttura

- `index.html`: markup e schede.
- `frontend/app.js`: tracker, dashboard e analisi esistenti.
- `frontend/imparato-tecnica.js`: calcolo e tabella dei ritardi Serie B.
- `frontend/styles.css`: tema Gotham nero/oro e componenti UI.
- `functions/api/proxy.js`: gateway allowlistato Cloudflare Pages.
- `_headers`, `_routes.json`, `wrangler.jsonc`: header statici, routing API e configurazione Pages.
- `frontend/telegram-alert.js`: invio avvisi Telegram dal browser (registra l'avviso solo se il server conferma).
- `tests/imparato-tecnica.test.js`: test funzionale browserless.
- `tests/proxy-hardening.test.mjs`, `tests/telegram-alert.test.js`: test di Telegram, limiti/timeout upstream, validazione input, rate limit.

## Secret Cloudflare

Nel dashboard: Workers & Pages → progetto Pages → Settings → Variables and Secrets. Inserisci i valori come **Secrets**, separatamente per Production e Preview se entrambi vengono usati:

- `ODDS_API_KEY`: quote The Odds API.
- `GROQ_API_KEY`: analisi AI Groq.
- `FOOTBALL_DATA_TOKEN`: risultati football-data.org, inclusa la competizione `SB`.
- `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`: avvisi Telegram, opzionali.

Non inserire chiavi in `wrangler.jsonc`, nei file frontend o in `.dev.vars.example`. La chiave quote trovata nella versione iniziale va revocata: eliminarla dal file corrente non annulla la precedente esposizione.

## Endpoint e protezioni

Tutte le chiamate usano `/api/proxy?action=...` sullo stesso dominio. Sono ammesse solo le azioni `odds` (campionato allowlistato), `ai` (payload limitato e modello allowlistato), `football` (codici competizione ammessi), `imparato-tecnica` (solo Serie B) e `telegram` (campi validati). L'URL esterno è deciso dal server: non esiste un parametro `url` arbitrario. La funzione controlla metodo, input e dimensione dei payload, applica timeout, limite alla risposta upstream e rate limit per IP best-effort. Non abilita CORS cross-origin.

Quote e risultati sono memorizzati con Cloudflare Cache API rispettivamente per 60 e 900 secondi. Cache API è locale al data center che ha popolato la cache e non replica automaticamente i contenuti nel resto della rete; la cache migliora le richieste ripetute nello stesso PoP ma non è storage globale ([documentazione Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)). Il rate limit in memoria è best-effort per isolate: configura anche una regola Cloudflare WAF Rate Limiting per `/api/proxy` e limiti più stretti per `action=ai` e `action=telegram`.

## ImparatoTecnica

La scheda analizza risultati conclusi della competizione `SB`; mostra ultimo pareggio, partite senza pareggio, giornate se fornite, vittorie/sconfitte dall'ultimo X e frequenza dei pareggi. Il coefficiente 0–100 trasforma il rapporto tra ritardo attuale e intervallo medio personale tra pareggi nella finestra disponibile con `100 × (1 − exp(−rapporto/2))`. È un indicatore descrittivo, non una probabilità né una previsione. Se non esistono intervalli storici sufficienti mostra `n/d`. Il backtest temporale non è implementato.

## Storage browser

Restano locali le chiavi `scommesse_serieB_v2`, `odds_history` e `alertedMatches_v1`, oltre alla cache pubblica `imparato_tecnica_cache_v1`. Non viene introdotto un database.

## Worker Cloudflare preesistente

Il sorgente del Worker `tracker-proxy.becchinigiuseppe.workers.dev` non era nel repository. Questa copia non dipende più da quel Worker: il backend è `functions/api/proxy.js`. Il Worker remoto resta indipendente e non viene cambiato dal deploy Pages; controlla nel dashboard Cloudflare che le vecchie route pubbliche `?url=` e `?groq=1` vengano disabilitate o rimosse se non servono ad altri client.

## Test e limiti

Eseguire `node tests/imparato-tecnica.test.js`, `node tests/cloudflare-function.test.mjs`, `node tests/proxy-hardening.test.mjs`, `node tests/telegram-alert.test.js`, `node --check frontend/app.js` e `node --check frontend/imparato-tecnica.js`. Il test Cloudflare importa il sorgente ESM e verifica route, metodo, input, CORS e risposta senza secret. I provider live richiedono i secret configurati. Le richieste API non sono disponibili aprendo direttamente il file HTML.

## Hardening API (branch `fix/api-backend-hardening`)

- **Telegram**: l'avviso è considerato inviato solo con HTTP 2xx **e** `{ ok: true }` nel body di Telegram. Altrimenti `/api/proxy?action=telegram` risponde 502 (429 con `Retry-After` se Telegram limita) e il client non registra l'avviso, quindi può riprovare. Il token del bot non compare mai nelle risposte.
- **`fetchJSON()`**: il body upstream è letto a blocchi e interrotto non appena supera 2 MB (o se `content-length` dichiara di più); il timeout di 12 s copre anche la lettura del body. Errori distinti: 504 timeout, 502 risposta troppo grande / non valida (JSON o UTF-8) / provider non raggiungibile. Gli errori del provider diventano 502 (429 resta 429).
- **Input**: le POST richiedono `Content-Type: application/json` (415 altrimenti) e un oggetto JSON; messaggi AI con ruolo in `system|user|assistant` e solo `role`/`content` inoltrati; campi Telegram validati (tipo, lunghezza, intervallo numerico) e senza caratteri di controllo.
- **Cross-site**: le richieste del browser con `Origin` diversa o `Sec-Fetch-Site: cross-site` ricevono 403 prima di consumare quota o rate limit.
- **Rate limit**: superati 10.000 bucket vengono eliminati i più vecchi invece di rispondere 429 a tutti.

### Limiti noti (nessuna configurazione nuova introdotta)

- `/api/proxy` resta pubblico: chi conosce l'URL può chiamare direttamente `ai` e `telegram` (con rate limit per IP, ma senza autenticazione). Per chiuderlo servono un'autenticazione (es. Cloudflare Access sul dominio o un secret condiviso) e/o una regola WAF Rate Limiting: sono modifiche di configurazione che richiedono una tua decisione.
- Il rate limit in memoria è per isolate e non sostituisce la regola WAF consigliata sopra.
- La Cache API è locale al data center: nessun comportamento di cache è stato modificato.
