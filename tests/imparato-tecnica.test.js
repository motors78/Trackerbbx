const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const nodes = Object.fromEntries(["imparato-status", "imparato-table", "btn-imparato-refresh", "imparato-updated"].map(id => [id, { style: {}, textContent: "", innerHTML: "", disabled: false }]));
const data = [
  ["Palermo", "Como", 1, 1, 1, "2026-08-10"],
  ["Palermo", "Bari", 2, 0, 2, "2026-08-17"],
  ["Bari", "Palermo", 0, 0, 3, "2026-08-24"],
  ["Palermo", "Catanzaro", 1, 0, 4, "2026-08-31"]
].map(([home, away, h, a, day, date], i) => ({
  utcDate: `${date}T18:00:00Z`, matchday: day,
  homeTeam: { id: home, name: home }, awayTeam: { id: away, name: away },
  score: { fullTime: { home: h, away: a } }, id: i
}));
const context = {
  window: {},
  document: { getElementById: id => nodes[id] },
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: async () => ({ ok: true, json: async () => ({ matches: data }) }),
  Date, Math, String, Number, Array, JSON
};
vm.runInNewContext(fs.readFileSync("frontend/imparato-tecnica.js", "utf8"), context);

(async () => {
  await context.window.caricaImparatoTecnica();
  const html = nodes["imparato-table"].innerHTML;
  assert.match(html, /Palermo/);
  assert.match(html, /24\/08\/2026/);
  assert.match(html, /1\.00× la media personale/);
  assert.match(html, /39\/100/);
  assert.match(html, /50% \(2\/4\)/);
  console.log("ImparatoTecnica integration test passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
