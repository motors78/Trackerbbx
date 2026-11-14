const LEAGUES = new Set([
  "soccer_italy_serie_a", "soccer_italy_serie_b", "soccer_epl", "soccer_spain_la_liga",
  "soccer_germany_bundesliga", "soccer_france_ligue_one", "soccer_uefa_champs_league",
  "soccer_netherlands_eredivisie", "soccer_brazil_campeonato", "soccer_england_championship",
  "soccer_portugal_primeira_liga", "soccer_uefa_european_championship", "soccer_fifa_world_cup"
]);
const COMPETITIONS = new Set(["SB", "SA", "PL", "PD", "BL1", "FL1", "CL", "DED", "BSA", "ELC", "PPL", "EC", "WC"]);
const REQUESTS = new Map();
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 10_000;
const MAX_UPSTREAM_BYTES = 2_000_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const AI_ROLES = new Set(["system", "user", "assistant"]);
const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};
let lastRateSweep = 0;

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

function respond(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...BASE_HEADERS, ...headers } });
}

// Best-effort, per-isolate. Con il limite di bucket raggiunto elimina i piu' vecchi invece di
// bloccare tutti gli utenti (prima superati 10.000 bucket ogni richiesta riceveva 429).
function rateLimited(request, action) {
  const now = Date.now();
  if (now - lastRateSweep > 30_000 || REQUESTS.size >= MAX_RATE_BUCKETS) {
    for (const [key, bucket] of REQUESTS) if (bucket.resetAt <= now) REQUESTS.delete(key);
    lastRateSweep = now;
  }
  while (REQUESTS.size >= MAX_RATE_BUCKETS) REQUESTS.delete(REQUESTS.keys().next().value);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const id = `${action}:${ip}`;
  let bucket = REQUESTS.get(id);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
  bucket.count++;
  REQUESTS.set(id, bucket);
  return bucket.count > (action === "ai" || action === "telegram" ? 8 : 30);
}

// Rifiuta richieste cross-site dei browser (es. form/fetch "simple request" da un altro sito che
// consumerebbero quota Groq/Telegram). Client non-browser (curl, test) non inviano questi header.
function isCrossSite(request, url) {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return true;
  return request.headers.get("sec-fetch-site") === "cross-site";
}

// Upstream 429 resta 429; qualsiasi altro errore del provider diventa 502, cosi' un 401/403 del
// provider (chiave errata) non viene scambiato dal client per un problema di autenticazione sua.
function upstreamStatus(status) { return status === 429 ? 429 : 502; }

async function readLimited(request, limit) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > limit) throw new HttpError(413, "Richiesta troppo grande");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "Richiesta troppo grande");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buffer);
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new HttpError(504, "Timeout del provider"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new HttpError(504, "Timeout del provider"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Legge il body upstream a blocchi e interrompe appena supera `limit`: la risposta non viene mai
// caricata per intero in memoria. Il timeout (signal) copre anche la lettura del body.
async function readUpstreamText(response, limit, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel(); } catch { /* gia' chiuso */ }
    throw new HttpError(502, "Risposta upstream troppo grande");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new HttpError(502, "Risposta upstream troppo grande");
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new HttpError(502, "Risposta upstream non valida"); }
}

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await abortable(fetch(url, { ...options, signal: controller.signal }), controller.signal);
    const text = await readUpstreamText(response, MAX_UPSTREAM_BYTES, controller.signal);
    let data;
    try { data = JSON.parse(text); }
    catch { throw new HttpError(502, "Risposta upstream non valida"); }
    return { response, data };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") throw new HttpError(504, "Timeout del provider");
    throw new HttpError(502, "Provider non raggiungibile");
  } finally { clearTimeout(timeout); }
}

async function readJSONBody(request, limit) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Content-Type deve essere application/json");
  let body;
  try { body = JSON.parse(await readLimited(request, limit)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "JSON non valido"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Corpo della richiesta non valido");
  return body;
}

async function cachedJSON(request, key, ttl, createValue) {
  const cacheKey = new Request(new URL(`/__tracker_cache/${encodeURIComponent(key)}`, new URL(request.url).origin));
  let cache;
  try { cache = caches.default; } catch { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return { value: await hit.json(), hit: true };
    } catch { /* Cache API is an optimization; continue to the provider. */ }
  }
  const value = await createValue();
  if (cache) {
    try {
      await cache.put(cacheKey, new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` }
      }));
    } catch { /* Continue if the zone cache is unavailable. */ }
  }
  return { value, hit: false };
}

export async function onRequest({ request, env }) {
  if (!["GET", "POST"].includes(request.method)) return respond({ error: "Metodo non consentito" }, 405, { Allow: "GET, POST" });
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  if (!action || !["odds", "ai", "football", "imparato-tecnica", "telegram"].includes(action)) return respond({ error: "Endpoint non disponibile" }, 404);
  if (isCrossSite(request, url)) return respond({ error: "Origine non consentita" }, 403);
  if (rateLimited(request, action)) return respond({ error: "Troppe richieste. Riprova tra poco." }, 429, { "Retry-After": "60" });

  try {
    if (action === "odds") {
      if (request.method !== "GET") return respond({ error: "Metodo non consentito" }, 405);
      const league = url.searchParams.get("league");
      if (!LEAGUES.has(league)) return respond({ error: "Campionato non valido" }, 400);
      if (!env.ODDS_API_KEY) return respond({ error: "Quote non configurate: impostare ODDS_API_KEY in Cloudflare Pages" }, 503);
      const { value, hit } = await cachedJSON(request, `odds:${league}`, 60, async () => {
        const upstreamURL = new URL(`https://api.the-odds-api.com/v4/sports/${league}/odds/`);
        upstreamURL.search = new URLSearchParams({ apiKey: env.ODDS_API_KEY, regions: "eu", markets: "h2h", oddsFormat: "decimal", bookmakers: "bet365,unibet,williamhill,pinnacle,betfair" });
        const { response, data } = await fetchJSON(upstreamURL);
        if (!response.ok) throw new HttpError(upstreamStatus(response.status), "Provider quote non disponibile");
        if (!Array.isArray(data)) throw new HttpError(502, "Formato quote inatteso");
        return { data, remaining: response.headers.get("x-requests-remaining") || "", used: response.headers.get("x-requests-used") || "" };
      });
      return respond(value.data, 200, { "X-Cache": hit ? "HIT" : "MISS", "x-requests-remaining": value.remaining, "x-requests-used": value.used });
    }

    if (action === "ai") {
      if (request.method !== "POST") return respond({ error: "Metodo non consentito" }, 405);
      if (!env.GROQ_API_KEY) return respond({ error: "AI non configurata: impostare GROQ_API_KEY in Cloudflare Pages" }, 503);
      const body = await readJSONBody(request, 40_000);
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 8 || body.messages.some(message => !message || !AI_ROLES.has(message.role) || typeof message.content !== "string" || message.content.length > 20_000)) return respond({ error: "Messaggi non validi" }, 400);
      const messages = body.messages.map(({ role, content }) => ({ role, content }));
      const model = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"].includes(body.model) ? body.model : "llama-3.3-70b-versatile";
      const maxTokens = Number(body.max_tokens);
      const temperature = Number(body.temperature);
      const { response, data } = await fetchJSON("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ model, messages, max_tokens: Number.isFinite(maxTokens) ? Math.max(1, Math.min(maxTokens, 2000)) : 1200, temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(temperature, 1)) : 0.2 })
      });
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(502, "Risposta AI non valida");
      return respond(data, response.ok ? 200 : upstreamStatus(response.status));
    }

    if (action === "telegram") {
      if (request.method !== "POST") return respond({ error: "Metodo non consentito" }, 405);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return respond({ error: "Avvisi Telegram non configurati" }, 503);
      const body = await readJSONBody(request, 4_000);
      const isText = (value, { allowEmpty = false } = {}) => typeof value === "string" && value.length <= 80 && (allowEmpty || value.trim().length > 0);
      const isNumber = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
      const bookOdds = Number(body.bookOdds);
      const edge = body.edge === undefined || body.edge === null ? 0 : Number(body.edge);
      if (!isText(body.homeTeam) || !isText(body.awayTeam, { allowEmpty: true }) || !isText(body.market) || !isNumber(body.bookOdds) || bookOdds < 0 || bookOdds > 1000 || !Number.isFinite(edge) || Math.abs(edge) > 1000) return respond({ error: "Dati avviso non validi" }, 400);
      const safe = value => String(value).replace(/[<>\u0000-\u001f\u007f]/g, " ").trim();
      const message = `Tracker: ${safe(body.homeTeam)} - ${safe(body.awayTeam)}\nEsito: ${safe(body.market)} | Quota: ${bookOdds.toFixed(2)} | Edge: ${edge.toFixed(2)}`;
      const { response, data } = await fetchJSON(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message })
      });
      // Telegram risponde { ok: true, result } solo se il messaggio e' stato accettato: HTTP 200 da solo non basta.
      if (!response.ok || !data || data.ok !== true) {
        if (response.status === 429) {
          const retry = Number(data?.parameters?.retry_after);
          throw new HttpError(429, "Telegram: troppe richieste, riprova tra poco", Number.isFinite(retry) && retry > 0 ? { "Retry-After": String(Math.ceil(retry)) } : {});
        }
        throw new HttpError(502, "Telegram non ha confermato l'invio");
      }
      return respond({ ok: true });
    }

    const competition = action === "imparato-tecnica" ? "SB" : url.searchParams.get("competition");
    if (!COMPETITIONS.has(competition)) return respond({ error: "Competizione non valida" }, 400);
    if (!env.FOOTBALL_DATA_TOKEN) return respond({ error: "Statistiche non configurate: impostare FOOTBALL_DATA_TOKEN in Cloudflare Pages" }, 503);
    const { value, hit } = await cachedJSON(request, `football:${competition}`, 900, async () => {
      const result = await fetchJSON(`https://api.football-data.org/v4/competitions/${competition}/matches?status=FINISHED`, { headers: { "X-Auth-Token": env.FOOTBALL_DATA_TOKEN } });
      if (!result.response.ok) throw new HttpError(upstreamStatus(result.response.status), "Provider risultati non disponibile");
      return Array.isArray(result.data?.matches) ? result.data.matches : [];
    });
    return respond({ matches: value, cached: hit }, 200, { "X-Cache": hit ? "HIT" : "MISS" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    const message = error instanceof HttpError ? error.message : "Errore temporaneo nel servizio esterno";
    return respond({ error: message }, status, error instanceof HttpError ? error.headers : {});
  }
}
