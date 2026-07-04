/** Store unit tests: repo-key identity, remote normalization, and filesystem
 *  round-trips against a tmp root (never the real ~/.claude). */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, normalizeRemote, repoKeyFrom, openStore } from "../../src/macros/store.ts";

const roots: string[] = [];
function tmpStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "fs-store-"));
  roots.push(root);
  return new Store(root);
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("repo identity", () => {
  test("ssh and https forms of one repo normalize to the same identity", () => {
    const ssh = normalizeRemote("git@github.com:alcatraz627/invasion-of-the-fiber-snatchers.git");
    const https = normalizeRemote("https://github.com/alcatraz627/invasion-of-the-fiber-snatchers.git");
    expect(ssh).toBe(https);
    expect(repoKeyFrom(`remote:${ssh}`)).toBe(repoKeyFrom(`remote:${https}`));
  });

  test("different repos get different keys", () => {
    expect(repoKeyFrom("remote:github.com/a/b")).not.toBe(repoKeyFrom("remote:github.com/a/c"));
  });

  test("key is short and filesystem-safe", () => {
    const key = repoKeyFrom("remote:github.com/a/b");
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("store round-trip", () => {
  test("write / read / exists / list / remove a macro", () => {
    const s = tmpStore();
    expect(s.list("macros")).toEqual([]);
    expect(s.entryExists("macros", "open-modal")).toBe(false);

    const path = s.write("macros", "open-modal", "name: open-modal\nsteps: []\n");
    expect(path).toContain("/macros/open-modal.yaml");
    expect(s.entryExists("macros", "open-modal")).toBe(true);
    expect(s.read("macros", "open-modal")).toContain("open-modal");
    expect(s.list("macros")).toEqual(["open-modal"]);

    s.remove("macros", "open-modal");
    expect(s.entryExists("macros", "open-modal")).toBe(false);
  });

  test("kinds are isolated and each has its own extension", () => {
    const s = tmpStore();
    s.write("macros", "a", "x");
    s.write("probes", "a", "y");
    s.write("sessions", "a", "z");
    expect(s.pathFor("macros", "a").endsWith(".yaml")).toBe(true);
    expect(s.pathFor("probes", "a").endsWith(".js")).toBe(true);
    expect(s.pathFor("sessions", "a").endsWith(".json")).toBe(true);
    expect(s.list("macros")).toEqual(["a"]);
    expect(s.list("probes")).toEqual(["a"]);
  });

  test("unsafe names are rejected (no path traversal)", () => {
    const s = tmpStore();
    expect(() => s.write("macros", "../evil", "x")).toThrow(/invalid name/);
    expect(() => s.write("macros", "a/b", "x")).toThrow(/invalid name/);
    expect(() => s.write("macros", "", "x")).toThrow(/invalid name/);
  });

  test("openStore honors an explicit root override", () => {
    const s = tmpStore();
    const s2 = openStore(s.root);
    s.write("macros", "shared", "x");
    expect(s2.list("macros")).toEqual(["shared"]);
  });
});
