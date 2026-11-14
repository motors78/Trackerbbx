const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function makeEnv(fetchImpl) {
  const calls = [];
  const logs = [];
  const context = {
    window: {},
    document: { getElementById: () => ({ options: [{ text: "Serie B 🇮🇹" }], selectedIndex: 0 }) },
    calcStats: () => ({ bankroll: 100 }),
    fetch: async (url, options) => { calls.push({ url, options }); return fetchImpl(calls.length, url, options); },
    console: { log: () => {}, error: (...args) => logs.push(args) }
  };
  vm.runInNewContext(fs.readFileSync("frontend/telegram-alert.js", "utf8"), context);
  return { send: context.window.inviaAlertTelegram, calls, logs };
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError("not json"); return body; } });
const pick = { partita: "Palermo vs Bari", esito: "1", descrizione_esito: "Palermo vince", quota_consigliata: 2.1, edge: 7, prob_stimata: 52, kelly_puntata: 5 };

const tests = [
  ["invio riuscito: registrato, il duplicato viene saltato", async () => {
    const env = makeEnv(() => reply(200, { ok: true }));
    assert.equal(await env.send(pick), true);
    assert.equal(await env.send(pick), false);
    assert.equal(env.calls.length, 1);
    const sent = JSON.parse(env.calls[0].options.body);
    assert.equal(env.calls[0].url, "/api/proxy?action=telegram");
    assert.deepEqual([sent.homeTeam, sent.awayTeam, sent.market, sent.bookOdds, sent.edge, sent.kellyStake, sent.league], ["Palermo", "Bari", "Palermo vince", 2.1, 0.07, 0.05, "Serie B 🇮🇹"]);
  }],
  ["errore del server (502/429/500): NON registrato, nuovo tentativo consentito", async () => {
    for (const status of [502, 429, 500, 503]) {
      const env = makeEnv(n => n === 1 ? reply(status, { error: "Telegram non ha confermato l'invio" }) : reply(200, { ok: true }));
      assert.equal(await env.send(pick), false, `status ${status}`);
      assert.equal(env.logs.length, 1);
      assert.equal(await env.send(pick), true, "il secondo tentativo deve partire");
      assert.equal(env.calls.length, 2);
      assert.equal(await env.send(pick), false, "dopo il successo il duplicato viene saltato");
      assert.equal(env.calls.length, 2);
    }
  }],
  ["HTTP 200 senza ok:true: NON considerato inviato", async () => {
    for (const body of [{ ok: false }, {}, null, { ok: "true" }]) {
      const env = makeEnv(n => n === 1 ? reply(200, body) : reply(200, { ok: true }));
      assert.equal(await env.send(pick), false, JSON.stringify(body));
      assert.equal(await env.send(pick), true);
    }
  }],
  ["risposta non JSON: NON registrato", async () => {
    const env = makeEnv(n => n === 1 ? reply(200, undefined) : reply(200, { ok: true }));
    assert.equal(await env.send(pick), false);
    assert.equal(await env.send(pick), true);
  }],
  ["errore di rete (fetch rifiuta): NON registrato, nuovo tentativo consentito", async () => {
    const env = makeEnv(n => { if (n === 1) throw new TypeError("Failed to fetch"); return reply(200, { ok: true }); });
    assert.equal(await env.send(pick), false);
    assert.equal(await env.send(pick), true);
    assert.equal(env.calls.length, 2);
  }],
  ["richieste concorrenti per lo stesso pick: un solo invio", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const env = makeEnv(async () => { await gate; return reply(200, { ok: true }); });
    const first = env.send(pick), second = env.send(pick);
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, false]);
    assert.equal(env.calls.length, 1);
  }],
  ["pick diversi sono indipendenti e bankroll 0 non produce Infinity", async () => {
    const env = makeEnv(() => reply(200, { ok: true }));
    assert.equal(await env.send(pick), true);
    assert.equal(await env.send({ ...pick, esito: "X" }), true);
    assert.equal(env.calls.length, 2);
    const zero = { calls: [] }; // ambiente con bankroll 0
    const ctx = { window: {}, document: { getElementById: () => null }, calcStats: () => ({ bankroll: 0 }), fetch: async (u, o) => { zero.calls.push({ o }); return reply(200, { ok: true }); }, console: { log() {}, error() {} } };
    vm.runInNewContext(fs.readFileSync("frontend/telegram-alert.js", "utf8"), ctx);
    await ctx.window.inviaAlertTelegram(pick);
    assert.equal(JSON.parse(zero.calls[0].o.body).kellyStake, 0);
  }]
];

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failed++; console.log(`FAIL ${name}`); console.error(error); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} test superati`);
  if (failed) process.exitCode = 1;
})();
