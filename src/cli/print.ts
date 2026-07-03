/** Renders a Response for the agent reader: outcome first, digest one-liner,
 *  candidates as pick-one lines, hint as the suggested next command. */

import type { Response } from "../protocol/types.ts";

export function printResponse(res: Response, json = false): number {
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (res.ok) {
    if (res.data !== undefined) {
      const s = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
      console.log(s);
    } else {
      console.log("ok");
    }
  } else if (res.error) {
    console.log(`✗ ${res.error.code}: ${res.error.message}`);
    if (res.error.candidates?.length) {
      console.log("candidates:");
      for (const c of res.error.candidates) {
        const comp = c.component ? `  <${c.component}>` : "";
        const conf = c.confidence ? `  ${(c.confidence * 100).toFixed(0)}%` : "";
        console.log(`  ${c.ref}  [${c.role}] ${c.text}${comp}${conf}`);
      }
    }
    if (res.error.hint) console.log(`→ ${res.error.hint}`);
  }

  if (res.digest) {
    const d = res.digest;
    const parts = [`mutations:${d.mutations}`];
    if (d.url) parts.push(`url:${d.url.to}`);
    if (d.queries) parts.push(`queries:${d.queries}`);
    if (d.errors?.length) parts.push(`errors:${d.errors.length}!`);
    console.log(`Δ ${parts.join("  ")}`);
    if (d.errors?.length) for (const e of d.errors) console.log(`  ! ${e}`);
  }

  return res.ok ? 0 : 1;
}
