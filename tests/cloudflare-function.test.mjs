import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/api/proxy.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const makeContext = (url, method = "GET", env = {}) => ({ request: new Request(`https://tracker.example${url}`, { method }), env });

const methodResponse = await onRequest(makeContext("/api/proxy?action=odds", "PUT"));
assert.equal(methodResponse.status, 405);
assert.equal(methodResponse.headers.get("access-control-allow-origin"), null);

const missingAction = await onRequest(makeContext("/api/proxy"));
assert.equal(missingAction.status, 404);

const invalidLeague = await onRequest(makeContext("/api/proxy?action=odds&league=https://example.com", "GET", { ODDS_API_KEY: "test" }));
assert.equal(invalidLeague.status, 400);

const missingSecret = await onRequest(makeContext("/api/proxy?action=imparato-tecnica"));
assert.equal(missingSecret.status, 503);
assert.match((await missingSecret.json()).error, /FOOTBALL_DATA_TOKEN/);

console.log("Cloudflare Pages Function smoke tests passed");
