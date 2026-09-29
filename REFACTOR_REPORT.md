# Refactor report

## Copia e stato

La cartella `Trackerbbx_REFACTOR` è stata clonata da `https://github.com/motors78/Trackerbbx.git`; il repository remoto originale non è stato modificato. Le modifiche di questa attività sono solo in questa copia.

## Rilievi

- `index.html` conteneva circa 110 KB tra markup, CSS e JavaScript.
- `netlify/functions/proxy.js` accettava un URL arbitrario via query, supportava HTTP e HTTPS, inoltrava senza limiti/rate limiting/cache, e restituiva CORS `*`. Il ramo AI inoltrava un body JSON senza validazione e restituiva anch'esso CORS `*`.
- Il frontend conteneva una chiave The Odds API in chiaro e inviava URL esterni tramite il Worker Cloudflare, `corsproxy.io` e `allorigins.win`.
- Lo stesso `index.html` conteneva logica API, UI, statistiche e storage. Le chiavi localStorage sono `scommesse_serieB_v2`, `odds_history` e `alertedMatches_v1`.
- Erano presenti funzioni definite più di una volta (`hideChartTooltip`) e riferimenti al Worker per football, AI e Telegram. Ho rimosso la definizione duplicata; non ho eliminato funzioni di prodotto basandomi solo sul conteggio dei riferimenti.
- Non sono presenti sorgenti locali del Worker Cloudflare, package manifest, build, dipendenze o suite test preesistenti.

## Interventi effettuati

- Spostati CSS e JavaScript applicativi in `frontend/styles.css` e `frontend/app.js`.
- Aggiunta scheda `ImparatoTecnica`, con modulo frontend dedicato e analisi per squadra basata sui risultati conclusi Serie B restituiti da football-data.org.
- Aggiunto gateway Cloudflare Pages Function (`functions/api/proxy.js`) con endpoint nominati: quote con campionato allowlistato, AI con input/dimensione/modello limitati, competizioni football allowlistate, Serie B dedicata, Telegram con campi validati. Il client non sceglie più URL upstream.
- Spostato l'accesso alle chiavi su `context.env` di Cloudflare Pages. Aggiunti rate limit in memoria best-effort, Cache API Cloudflare per quote e risultati, timeout e limite dimensione risposte upstream, validazione e nessun header CORS wildcard.
- Rimossi `netlify.toml` e `netlify/functions/proxy.js`; aggiunti `wrangler.jsonc`, `_routes.json` e `_headers`.
- Rimossi dal frontend i fallback a proxy CORS pubblici e le chiamate dirette al Worker; le chiamate applicative usano `/api/proxy` same-origin.
- Protetta la lettura localStorage da JSON malformato e applicato escaping alle principali superfici HTML con dati locali, provider e AI.
- Documentata l'architettura Pages, le variabili segrete e il deploy; aggiunti test d'integrazione per ImparatoTecnica e smoke test della Pages Function.
- `node --test` non è eseguibile nel sandbox perché il test runner tenta di creare un processo figlio (errore `spawn EPERM`); lo stesso test viene eseguito direttamente con `node tests/imparato-tecnica.test.js`.

## Coefficiente e limiti statistici

Il coefficiente usa il rapporto tra partite consecutive senza pareggio e intervallo medio storico tra pareggi osservato nei risultati ricevuti; applica `100 × (1 − exp(−rapporto/2))`, limitato a 0–100. Frequenza, partite senza X e ritardi vengono esposti come descrizioni dei dati. Il valore non è una probabilità. Non è stato implementato un backtest: serve uno storico con snapshot per giornata per garantire l'assenza di leakage temporale.

## Rischi/attività manuali

- **Revocare la chiave The Odds API precedentemente esposta** nel frontend/repository e impostarne una nuova come secret `ODDS_API_KEY` in Cloudflare Pages. La rimozione dal file corrente non rimuove la chiave dalla cronologia Git.
- Collegare la copia a Cloudflare Pages e configurare i secrets `ODDS_API_KEY`, `GROQ_API_KEY`, `FOOTBALL_DATA_TOKEN`; `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` sono opzionali. I valori non sono inclusi qui.
- Il Worker remoto non era disponibile localmente e resta separato dal nuovo deploy Pages. Verificare nel dashboard Cloudflare che le vecchie route pubbliche `?url=` e `?groq=1` siano disabilitate o rimosse se non usate da altri client.
- La cache API è locale al data center che l'ha popolata; non è un archivio globale condiviso. Il rate limit in memoria è best-effort per isolate: configurare una regola Rate Limiting WAF su `/api/proxy`, con limiti più stretti per richieste AI e Telegram.
- I risultati API live non sono verificabili senza credenziali. Il provider può limitare la disponibilità della competizione `SB` in base al piano.

## File

- Nuovi: `frontend/app.js`, `frontend/styles.css`, `frontend/imparato-tecnica.js`, `functions/api/proxy.js`, `_routes.json`, `_headers`, `wrangler.jsonc`, `tests/imparato-tecnica.test.js`, `tests/cloudflare-function.test.mjs`, `README.md`, `REFACTOR_REPORT.md`.
- Modificati: `index.html`, `manifest.json`.
- Rimossi: `netlify/functions/proxy.js`, `netlify.toml`.
