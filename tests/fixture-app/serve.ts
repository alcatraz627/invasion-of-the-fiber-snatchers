/** Builds and serves the fixture app on an ephemeral port. Used by the e2e
 *  suite (import { startFixture }) and runnable standalone for manual poking:
 *  bun tests/fixture-app/serve.ts */

const PAGE = (js: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>fs fixture</title></head>
<body><div id="root"></div><script type="module">${js.replace(/<\/script>/g, "<\\/script>")}</script></body></html>`;

// A real backend endpoint the app fetches, so WP6's network verbs (mock,
// throttle, wait --call, watch network) have genuine HTTP traffic to shape and
// observe — the rest of the fixture drives TanStack over an in-page timer.
const API_PARTS = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  name: `API Part ${i}`,
  status: i % 3 === 0 ? "failed" : "ok",
}));

function apiParts(url: URL): Response {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const rows = q ? API_PARTS.filter((p) => p.name.toLowerCase().includes(q)) : API_PARTS;
  return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
}

export async function startFixture(): Promise<{ url: string; stop: () => void }> {
  const entry = new URL("./app.tsx", import.meta.url).pathname;
  const result = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
  const out = result.outputs[0];
  if (!result.success || !out) throw new Error(`fixture build failed: ${result.logs.join("\n")}`);
  const js = await out.text();
  const html = PAGE(js);

  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/parts") return apiParts(url);
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const { url } = await startFixture();
  console.log(`fixture serving at ${url} (ctrl-c to stop)`);
}
