/** Journal redaction (seed #29): a fill on a secret-looking field is journaled
 *  with its value replaced. Driven through the real Journal (write -> read back),
 *  no browser needed. */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readJournal } from "../../src/pipeline/journal.ts";

const dirs: string[] = [];
function tmpJournalDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fs-journal-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function appendAndRead(entry: Parameters<Journal["append"]>[0]) {
  const dir = tmpJournalDir();
  const j = new Journal(dir);
  j.append(entry);
  await j.close();
  return (await readJournal(dir)).at(-1);
}

describe("fill value redaction", () => {
  test("redacts when the resolved label reads like a secret", async () => {
    const e = await appendAndRead({
      cmd: "fill",
      args: { target: { kind: "intent", text: "Password" }, value: "hunter2" },
      target: { ref: "e1.a", role: "textbox", text: "Password" },
      ok: true,
      durMs: 1,
    });
    expect((e!.args as { value: string }).value).toBe("[redacted]");
  });

  test("redacts when the selector targets type=password", async () => {
    const e = await appendAndRead({
      cmd: "fill",
      args: { target: { kind: "css", selector: 'input[type="password"]' }, value: "s3cr3t" },
      ok: true,
      durMs: 1,
    });
    expect((e!.args as { value: string }).value).toBe("[redacted]");
  });

  test("redacts token / secret / api-key labels", async () => {
    for (const label of ["API Token", "client secret", "api_key"]) {
      const e = await appendAndRead({
        cmd: "fill",
        args: { target: { kind: "intent", text: label }, value: "abc123" },
        target: { ref: "e1.a", role: "textbox", text: label },
        ok: true,
        durMs: 1,
      });
      expect((e!.args as { value: string }).value).toBe("[redacted]");
    }
  });

  test("leaves an ordinary field's value intact", async () => {
    const e = await appendAndRead({
      cmd: "fill",
      args: { target: { kind: "intent", text: "Search" }, value: "widgets" },
      target: { ref: "e1.a", role: "textbox", text: "Search" },
      ok: true,
      durMs: 1,
    });
    expect((e!.args as { value: string }).value).toBe("widgets");
  });

  test("only fill is redacted — a click on a 'password' control keeps its args", async () => {
    const e = await appendAndRead({
      cmd: "click",
      args: { target: { kind: "intent", text: "Show password" } },
      target: { ref: "e1.a", role: "button", text: "Show password" },
      ok: true,
      durMs: 1,
    });
    expect(e!.args).toMatchObject({ target: { text: "Show password" } });
  });
});
