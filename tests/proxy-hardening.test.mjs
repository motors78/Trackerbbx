import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/api/proxy.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const SECRET = "123456:SECRET-TELEGRAM-TOKEN";
const ENV = { ODDS_API_KEY: "odds-key", GROQ_API_KEY: "groq-key", FOOTBALL_DATA_TOKEN: "fd-token", TELEGRAM_BOT_TOKEN: SECRET, TELEGRAM_CHAT_ID: "42" };

let ipCounter = 0;
const freshIp = () => `203.0.113.${(++ipCounter) % 250}-${Math.floor(ipCounter / 250)}`; // IP unico per test (rate limit per IP)

function call(path, { method = "GET", body, headers = {}, env = ENV, ip = freshIp(), json = true } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (json && !init.headers["content-type"]) init.headers["content-type"] = "application/json";
  }
  return onRequest({ request: new Request(`https://tracker.example${path}`, init), env });
}

const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return handler(String(url), options, calls.length); };
  return calls;
}

// Stream che produce chunk all'infinito: permette di verificare quanti byte vengono realmente letti.
function endlessStream(chunkSize = 500_000) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) { state.pulled++; controller.enqueue(new Uint8Array(chunkSize).fill(0x20)); },
    cancel() { state.cancelled = true; }
  }, { highWaterMark: 0 }); // nessun pre-caricamento: pull() scatta solo su una lettura reale
  return { stream, state };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
  finally { globalThis.fetch = realFetch; globalThis.setTimeout = realSetTimeout; }
}

const validAlert = { homeTeam: "Palermo", awayTeam: "Bari", market: "1", bookOdds: 2.1, edge: 0.07 };
const postAlert = (body = validAlert, options = {}) => call("/api/proxy?action=telegram", { method: "POST", body, ...options });

// ===================== TELEGRAM =====================
await test("telegram: invio confermato (HTTP 200 + ok:true) -> 200 { ok: true }", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true, result: { message_id: 1 } }));
  const response = await postAlert();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${SECRET}/sendMessage`);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.chat_id, "42");
  assert.equal(sent.text, "Tracker: Palermo - Bari\nEsito: 1 | Quota: 2.10 | Edge: 0.07");
});

await test("telegram: HTTP 200 ma ok:false -> NON confermato (502)", async () => {
  mockFetch(() => jsonResponse({ ok: false, description: "boom" }, 200));
  const response = await postAlert();
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.notEqual(body.ok, true);
  assert.match(body.error, /non ha confermato/);
});

await test("telegram: errore HTTP di Telegram (400/401/500) -> 502 senza esporre il token", async () => {
  for (const status of [400, 401, 403, 500]) {
    mockFetch(() => jsonResponse({ ok: false, error_code: status, description: `Unauthorized ${SECRET}` }, status));
    const response = await postAlert();
    const text = await response.text();
    assert.equal(response.status, 502, `status ${status}`);
    assert.ok(!text.includes(SECRET), "il token non deve comparire nella risposta");
    assert.ok(!text.includes("Unauthorized"), "il testo upstream non viene inoltrato");
  }
});

await test("telegram: 429 di Telegram -> 429 con Retry-After", async () => {
  mockFetch(() => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429));
  const response = await postAlert();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
});

await test("telegram: errore di rete -> 502 senza esporre il token", async () => {
  mockFetch(() => { throw new TypeError(`fetch failed: https://api.telegram.org/bot${SECRET}/sendMessage`); });
  const response = await postAlert();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(SECRET));
});

await test("telegram: risposta non JSON (pagina HTML) -> 502, non un successo", async () => {
  mockFetch(() => new Response("<html>Bad gateway</html>", { status: 200 }));
  const response = await postAlert();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /non valida/);
});

await test("telegram: non configurato -> 503 e nessuna chiamata upstream", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  const response = await postAlert(validAlert, { env: {} });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

await test("telegram: input non validi -> 400/415 e nessuna chiamata upstream", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  const bad = [
    {}, { ...validAlert, homeTeam: "" }, { ...validAlert, homeTeam: "x".repeat(81) }, { ...validAlert, market: 5 },
    { ...validAlert, bookOdds: "abc" }, { ...validAlert, bookOdds: null }, { ...validAlert, bookOdds: -1 }, { ...validAlert, bookOdds: 1e9 },
    { ...validAlert, edge: "abc" }, { ...validAlert, awayTeam: 7 }
  ];
  for (const body of bad) assert.equal((await postAlert(body)).status, 400, JSON.stringify(body));
  assert.equal((await postAlert("non json")).status, 400);
  assert.equal((await postAlert("[]")).status, 400);
  assert.equal((await postAlert("null")).status, 400);
  assert.equal((await postAlert(JSON.stringify(validAlert), { json: false, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await postAlert("x".repeat(5_000))).status, 413);
  assert.equal((await call("/api/proxy?action=telegram", { method: "GET" })).status, 405);
  assert.equal(calls.length, 0);
});

await test("telegram: awayTeam vuoto e edge assente restano accettati (compatibilita' client)", async () => {
  mockFetch(() => jsonResponse({ ok: true }));
  const response = await postAlert({ homeTeam: "Palermo", awayTeam: "", market: "X", bookOdds: 0 });
  assert.equal(response.status, 200);
});

await test("telegram: i caratteri di controllo non possono iniettare righe nel messaggio", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  await postAlert({ ...validAlert, market: "1\nEsito: finto <b>x</b>\r\n" });
  const text = JSON.parse(calls[0].options.body).text;
  assert.equal(text.split("\n").length, 2);
  assert.ok(!/[<>]/.test(text));
});

// ===================== SICUREZZA =====================
await test("sicurezza: richieste cross-site rifiutate (403) prima di qualsiasi chiamata", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  assert.equal((await postAlert(validAlert, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await postAlert(validAlert, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call("/api/proxy?action=odds&league=soccer_epl", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await postAlert(validAlert, { headers: { origin: "https://tracker.example", "sec-fetch-site": "same-origin" } })).status, 200);
});

await test("sicurezza: rate limit per IP (9a richiesta telegram -> 429, altri IP non toccati)", async () => {
  mockFetch(() => jsonResponse({ ok: true }));
  const ip = freshIp();
  for (let i = 0; i < 8; i++) assert.equal((await postAlert(validAlert, { ip })).status, 200, `richiesta ${i + 1}`);
  const blocked = await postAlert(validAlert, { ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal((await postAlert(validAlert)).status, 200);
});

await test("sicurezza: con migliaia di IP diversi il servizio non si blocca per tutti", async () => {
  for (let i = 0; i < 10_050; i++) await call("/api/proxy?action=imparato-tecnica", { env: {}, ip: `198.51.100.${i}-flood` });
  assert.equal((await call("/api/proxy?action=imparato-tecnica", { env: {}, ip: "192.0.2.77-legit" })).status, 503); // 503 = secret mancante, NON 429
});

await test("sicurezza: nessun parametro url arbitrario, azione sconosciuta -> 404", async () => {
  const calls = mockFetch(() => jsonResponse({}));
  assert.equal((await call("/api/proxy?url=https://example.com")).status, 404);
  assert.equal((await call("/api/proxy?action=../../etc")).status, 404);
  assert.equal(calls.length, 0);
});

// ===================== RISPOSTE UPSTREAM =====================
const odds = () => call("/api/proxy?action=odds&league=soccer_epl");

await test("upstream: risposta troppo grande, lettura interrotta durante lo streaming (non dopo)", async () => {
  const { stream, state } = endlessStream(500_000);
  mockFetch(() => new Response(stream, { status: 200 }));
  const response = await odds();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /troppo grande/);
  assert.ok(state.cancelled, "lo stream upstream deve essere annullato");
  assert.ok(state.pulled <= 6, `letti ${state.pulled} chunk da 500 kB: deve fermarsi poco oltre 2 MB`);
});

await test("upstream: content-length dichiarato oltre il limite -> 502 senza leggere il body", async () => {
  const { stream, state } = endlessStream();
  mockFetch(() => new Response(stream, { status: 200, headers: { "content-length": "5000000" } }));
  const response = await odds();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /troppo grande/);
  assert.equal(state.pulled, 0);
  assert.ok(state.cancelled);
});

await test("upstream: limite esatto 2.000.000 byte accettato, 2.000.001 rifiutato", async () => {
  const payload = size => `["${"a".repeat(size - 4)}"]`;
  mockFetch(() => new Response(payload(2_000_000), { status: 200 }));
  assert.equal((await odds()).status, 200);
  mockFetch(() => new Response(payload(2_000_001), { status: 200 }));
  assert.equal((await odds()).status, 502);
});

await test("upstream: il limite conta i byte, non i caratteri (UTF-8 multibyte)", async () => {
  mockFetch(() => new Response(`["${"è".repeat(1_100_000)}"]`, { status: 200 })); // ~2,2 MB in byte, ~1,1 M caratteri
  const response = await odds();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /troppo grande/);
});

await test("upstream: JSON non valido / vuoto / UTF-8 corrotto -> 502 'non valida'", async () => {
  for (const body of ["{non json", "", "<html></html>", new Uint8Array([0x5b, 0x22, 0xff, 0xfe, 0x22, 0x5d])]) {
    mockFetch(() => new Response(body, { status: 200 }));
    const response = await odds();
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /non valida/);
  }
});

await test("upstream: JSON valido ma con forma inattesa -> 502 (odds non-array, AI non-oggetto)", async () => {
  mockFetch(() => jsonResponse({ not: "an array" }));
  const response = await odds();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Formato quote inatteso/);
  mockFetch(() => jsonResponse([1, 2]));
  const ai = await call("/api/proxy?action=ai", { method: "POST", body: { messages: [{ role: "user", content: "ciao" }] } });
  assert.equal(ai.status, 502);
});

await test("upstream: timeout sulla connessione -> 504", async () => {
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 12_000 ? 20 : ms, ...args);
  mockFetch(() => new Promise(() => {})); // non risponde mai
  const response = await odds();
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /Timeout/);
});

await test("upstream: timeout durante la lettura del body (stream bloccato) -> 504", async () => {
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 12_000 ? 20 : ms, ...args);
  let cancelled = false;
  const stalled = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("[1,")); }, cancel() { cancelled = true; } });
  mockFetch(() => new Response(stalled, { status: 200 }));
  const response = await odds();
  assert.equal(response.status, 504);
  assert.ok(cancelled);
});

await test("upstream: errori del provider mappati (401/403/500 -> 502, 429 -> 429)", async () => {
  for (const [upstream, expected] of [[401, 502], [403, 502], [500, 502], [429, 429]]) {
    mockFetch(() => jsonResponse({ message: "x" }, upstream));
    assert.equal((await odds()).status, expected, `upstream ${upstream}`);
  }
});

await test("upstream: quote valide -> 200 con header di quota e senza esporre la chiave", async () => {
  const calls = mockFetch(() => jsonResponse([{ id: "m1" }], 200, { "x-requests-remaining": "400", "x-requests-used": "100" }));
  const response = await odds();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: "m1" }]);
  assert.equal(response.headers.get("x-requests-remaining"), "400");
  assert.ok(calls[0].url.startsWith("https://api.the-odds-api.com/v4/sports/soccer_epl/odds/"));
});

await test("football/imparato-tecnica: risultati e campionato forzato SB", async () => {
  const calls = mockFetch(() => jsonResponse({ matches: [{ id: 1 }] }));
  const response = await call("/api/proxy?action=imparato-tecnica");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).matches, [{ id: 1 }]);
  assert.match(calls[0].url, /competitions\/SB\/matches/);
  mockFetch(() => jsonResponse(null)); // JSON "null" non deve causare eccezioni non gestite
  assert.equal((await call("/api/proxy?action=football&competition=SA")).status, 200);
  assert.equal((await call("/api/proxy?action=football&competition=XX")).status, 400);
});

// ===================== AI =====================
const postAI = (body, options = {}) => call("/api/proxy?action=ai", { method: "POST", body, ...options });

await test("ai: richiesta valida inoltrata con soli campi consentiti, risposta passata al client", async () => {
  const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
  const response = await postAI({ model: "modello-non-ammesso", messages: [{ role: "user", content: "ciao", name: "x", tool_calls: [1] }], max_tokens: 99999, temperature: 5 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "ok");
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.model, "llama-3.3-70b-versatile");
  assert.equal(sent.max_tokens, 2000);
  assert.equal(sent.temperature, 1);
  assert.deepEqual(sent.messages, [{ role: "user", content: "ciao" }]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer groq-key");
});

await test("ai: input non validi -> 400/415 e nessuna chiamata upstream", async () => {
  const calls = mockFetch(() => jsonResponse({}));
  const ok = { role: "user", content: "x" };
  for (const body of [{}, { messages: [] }, { messages: "x" }, { messages: Array(9).fill(ok) }, { messages: [{ role: "tool", content: "x" }] },
    { messages: [{ content: "x" }] }, { messages: [{ role: "user", content: 5 }] }, { messages: [{ role: "user", content: "x".repeat(20_001) }] }, { messages: [null] }]) {
    assert.equal((await postAI(body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await postAI(JSON.stringify({ messages: [ok] }), { json: false, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await postAI("x".repeat(41_000))).status, 413);
  assert.equal(calls.length, 0);
});

await test("ai: errore del provider mappato, 429 mantenuto", async () => {
  mockFetch(() => jsonResponse({ error: { message: "bad key" } }, 401));
  const bad = await postAI({ messages: [{ role: "user", content: "x" }] });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).error.message, "bad key");
  mockFetch(() => jsonResponse({ error: { message: "slow down" } }, 429));
  assert.equal((await postAI({ messages: [{ role: "user", content: "x" }] })).status, 429);
});

// ===================== REPORT =====================
let failed = 0;
for (const { name, ok, error } of results) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) { failed++; console.error(error); }
}
console.log(`\n${results.length - failed}/${results.length} test superati`);
if (failed) process.exitCode = 1;
