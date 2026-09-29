const LEAGUES = new Set([
  "soccer_italy_serie_a", "soccer_italy_serie_b", "soccer_epl", "soccer_spain_la_liga",
  "soccer_germany_bundesliga", "soccer_france_ligue_one", "soccer_uefa_champs_league",
  "soccer_netherlands_eredivisie", "soccer_brazil_campeonato", "soccer_england_championship",
  "soccer_portugal_primeira_liga", "soccer_uefa_european_championship", "soccer_fifa_world_cup"
]);
const COMPETITIONS = new Set(["SB", "SA", "PL", "PD", "BL1", "FL1", "CL", "DED", "BSA", "ELC", "PPL", "EC", "WC"]);
const REQUESTS = new Map();
const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function respond(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...BASE_HEADERS, ...headers } });
}

function rateLimited(request, action) {
  const now = Date.now();
  for (const [key, bucket] of REQUESTS) if (bucket.resetAt <= now) REQUESTS.delete(key);
  if (REQUESTS.size > 10_000) return true;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const id = `${action}:${ip}`;
  const bucket = REQUESTS.get(id) || { count: 0, resetAt: now + 60_000 };
  bucket.count++;
  REQUESTS.set(id, bucket);
  return bucket.count > (action === "ai" || action === "telegram" ? 8 : 30);
}

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

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (text.length > 2_000_000) throw new HttpError(502, "Risposta upstream troppo grande");
    let data;
    try { data = JSON.parse(text); }
    catch { throw new HttpError(502, "Risposta upstream non valida"); }
    return { response, data };
  } finally { clearTimeout(timeout); }
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
        if (!response.ok) throw new HttpError(response.status, "Provider quote non disponibile");
        if (!Array.isArray(data)) throw new HttpError(502, "Formato quote inatteso");
        return { data, remaining: response.headers.get("x-requests-remaining") || "", used: response.headers.get("x-requests-used") || "" };
      });
      return respond(value.data, 200, { "X-Cache": hit ? "HIT" : "MISS", "x-requests-remaining": value.remaining, "x-requests-used": value.used });
    }

    if (action === "ai") {
      if (request.method !== "POST") return respond({ error: "Metodo non consentito" }, 405);
      if (!env.GROQ_API_KEY) return respond({ error: "AI non configurata: impostare GROQ_API_KEY in Cloudflare Pages" }, 503);
      const text = await readLimited(request, 40_000);
      let body;
      try { body = JSON.parse(text || "{}"); } catch { return respond({ error: "JSON non valido" }, 400); }
      if (!Array.isArray(body.messages) || body.messages.length > 8 || body.messages.some(message => !message || typeof message.content !== "string" || message.content.length > 20_000)) return respond({ error: "Messaggi non validi" }, 400);
      const model = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"].includes(body.model) ? body.model : "llama-3.3-70b-versatile";
      const maxTokens = Number(body.max_tokens);
      const temperature = Number(body.temperature);
      const { response, data } = await fetchJSON("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ model, messages: body.messages, max_tokens: Number.isFinite(maxTokens) ? Math.max(1, Math.min(maxTokens, 2000)) : 1200, temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(temperature, 1)) : 0.2 })
      });
      return respond(data, response.status);
    }

    if (action === "telegram") {
      if (request.method !== "POST") return respond({ error: "Metodo non consentito" }, 405);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return respond({ error: "Avvisi Telegram non configurati" }, 503);
      const text = await readLimited(request, 4_000);
      let body;
      try { body = JSON.parse(text || "{}"); } catch { return respond({ error: "JSON non valido" }, 400); }
      if (typeof body.homeTeam !== "string" || typeof body.awayTeam !== "string" || typeof body.market !== "string" || body.homeTeam.length > 80 || body.awayTeam.length > 80 || body.market.length > 80 || !Number.isFinite(Number(body.bookOdds))) return respond({ error: "Dati avviso non validi" }, 400);
      const safe = value => String(value).replace(/[<>]/g, "");
      const message = `Tracker: ${safe(body.homeTeam)} - ${safe(body.awayTeam)}\nEsito: ${safe(body.market)} | Quota: ${Number(body.bookOdds).toFixed(2)} | Edge: ${Number(body.edge || 0).toFixed(2)}`;
      const { response } = await fetchJSON(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message })
      });
      return respond({ ok: response.ok }, response.status);
    }

    const competition = action === "imparato-tecnica" ? "SB" : url.searchParams.get("competition");
    if (!COMPETITIONS.has(competition)) return respond({ error: "Competizione non valida" }, 400);
    if (!env.FOOTBALL_DATA_TOKEN) return respond({ error: "Statistiche non configurate: impostare FOOTBALL_DATA_TOKEN in Cloudflare Pages" }, 503);
    const { value, hit } = await cachedJSON(request, `football:${competition}`, 900, async () => {
      const result = await fetchJSON(`https://api.football-data.org/v4/competitions/${competition}/matches?status=FINISHED`, { headers: { "X-Auth-Token": env.FOOTBALL_DATA_TOKEN } });
      if (!result.response.ok) throw new HttpError(result.response.status, "Provider risultati non disponibile");
      return Array.isArray(result.data.matches) ? result.data.matches : [];
    });
    return respond({ matches: value, cached: hit }, 200, { "X-Cache": hit ? "HIT" : "MISS" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    const message = error instanceof HttpError ? error.message : "Errore temporaneo nel servizio esterno";
    return respond({ error: message }, status);
  }
}
