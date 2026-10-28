import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { basemapSettingsFromEnv, createBasemapHandler } from "./proxy.js";

// Node fetch puts the whole configured URL (userinfo + query) into some error
// messages. Every config loader must log through safeErrorText.
const SYN = {
  pass: "SYNTHpass9f3a1c",
  key: "SYNTHkey7d2e5b",
  token: "SYNTHtok41c0aaXYZ",
};
const base = (host) =>
  `http://user:${SYN.pass}@${host}:9?api_key=${SYN.key}&access_token=${SYN.token}`;

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      }),
    );
  });

const failingFetch = async (input) => {
  throw new TypeError(`fetch failed: could not reach ${String(input)}`);
};

const forms = (s) => [s, s.slice(0, 8), s.slice(-6), encodeURIComponent(s), Buffer.from(s).toString("base64")];

async function run(envExtra) {
  const logs = [];
  const handler = createBasemapHandler(
    basemapSettingsFromEnv({
      GEV_BASEMAP: "1",
      GEV_BASEMAP_NAIP: "1",
      GEV_BASEMAP_OVERLAYS: "1",
      GEV_BASEMAP_HIRES_URLS: base("hires.invalid"),
      GEV_BASEMAP_NAIP_URLS: base("naip.invalid"),
      ...envExtra,
    }),
    { fetchImpl: failingFetch, log: (...a) => logs.push(a.map(String).join(" ")) },
  );
  const s = await listen((req, res) => handler(req, res, () => res.end("next")));
  try {
    const bodies = [];
    for (const path of ["/basemap/config.json", "/basemap/health.json"]) {
      const r = await fetch(`${s.url}${path}`);
      bodies.push(await r.text());
    }
    return { logs, bodies };
  } finally {
    await s.close();
  }
}

function assertClean({ logs, bodies }) {
  const haystack = [...logs, ...bodies].join("\n");
  for (const secret of Object.values(SYN))
    for (const f of forms(secret))
      assert.ok(!haystack.includes(f), `leaked ${f.length} chars of a synthetic secret`);
}

const LOADERS = [
  ["terrain", { GEV_BASEMAP_TERRAIN_URLS: base("terrain.invalid") }, "terrain config unavailable"],
  [
    "imagery",
    {
      GEV_BASEMAP_IMAGERY_URLS: base("imagery.invalid"),
      GEV_BASEMAP_IMAGERY_CONFIG: base("imagery-cfg.invalid") + "/config.json",
    },
    "imagery config unavailable",
  ],
  ["buildings", { GEV_BASEMAP_BUILDINGS_URLS: base("buildings.invalid") }, "buildings config unavailable"],
  ["naip", { GEV_BASEMAP_NAIP_CONFIG: base("naip-cfg.invalid") + "/naip/config.json" }, "naip config unavailable"],
  ["health", { GEV_BASEMAP_HEALTH_URLS: base("health.invalid") + "/health.json" }, "health unavailable"],
];

for (const [name, envExtra, marker] of LOADERS) {
  test(`${name} loader failure log carries no URL credentials`, async () => {
    const result = await run(envExtra);
    assert.ok(
      result.logs.some((l) => l.includes(marker)),
      `${marker} was logged (got: ${result.logs.join(" | ")})`,
    );
    assertClean(result);
  });
}

test("handler catch-all log carries no URL credentials", async () => {
  const logs = [];
  const handler = createBasemapHandler(
    basemapSettingsFromEnv({ GEV_BASEMAP: "1" }),
    {
      fetchImpl: failingFetch,
      // Anything that throws outside the loaders lands in the handler catch.
      now: () => {
        throw new TypeError(`clock failed for ${base("clock.invalid")}`);
      },
      log: (...a) => logs.push(a.map(String).join(" ")),
    },
  );
  const s = await listen((req, res) => handler(req, res, () => res.end("next")));
  try {
    const r = await fetch(`${s.url}/basemap/config.json`);
    assert.equal(r.status, 500);
    const bodies = [await r.text()];
    assert.ok(
      logs.some((l) => l.includes("handler error")),
      `handler error was logged (got: ${logs.join(" | ")})`,
    );
    assertClean({ logs, bodies });
  } finally {
    await s.close();
  }
});
