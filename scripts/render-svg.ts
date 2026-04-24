// Render an SVG at its native viewBox dimensions to a PNG via headless
// Chromium. Handy for iterating on docs/assets/banner.svg — qlmanage forces
// 1:1 aspect ratio and squashes wide banners.
//
// Usage: bun scripts/render-svg.ts <in.svg> <out.png>

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const [,, svgPath, pngPath] = process.argv;
if (!svgPath || !pngPath) {
  console.error("usage: bun scripts/render-svg.ts <in.svg> <out.png>");
  process.exit(1);
}

const svg = await readFile(svgPath!, "utf8");
const m = svg.match(/viewBox="([\d\s.-]+)"/) ?? svg.match(/width="(\d+)"[^>]*height="(\d+)"/);
let w = 1200, h = 360;
if (m && m[1]?.includes(" ")) {
  const vb = m[1].split(/\s+/).map(Number);
  w = Number(vb[2]); h = Number(vb[3]);
} else if (m && m[2]) {
  w = Number(m[1]); h = Number(m[2]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: w, height: h } });
const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${svg}</body></html>`;
await page.setContent(html);
await page.screenshot({ path: pngPath!, omitBackground: false, clip: { x: 0, y: 0, width: w, height: h } });
await browser.close();
console.log(`rendered ${w}×${h} → ${pngPath}`);
