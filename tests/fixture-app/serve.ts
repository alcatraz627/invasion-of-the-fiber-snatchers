/** Builds and serves the fixture app on an ephemeral port. Used by the e2e
 *  suite (import { startFixture }) and runnable standalone for manual poking:
 *  bun tests/fixture-app/serve.ts */

const PAGE = (js: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>fs fixture</title></head>
<body><div id="root"></div><script type="module">${js.replace(/<\/script>/g, "<\\/script>")}</script></body></html>`;

export async function startFixture(): Promise<{ url: string; stop: () => void }> {
  const entry = new URL("./app.tsx", import.meta.url).pathname;
  const result = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
  const out = result.outputs[0];
  if (!result.success || !out) throw new Error(`fixture build failed: ${result.logs.join("\n")}`);
  const js = await out.text();
  const html = PAGE(js);

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const { url } = await startFixture();
  console.log(`fixture serving at ${url} (ctrl-c to stop)`);
}
