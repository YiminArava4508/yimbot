import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configFromEnv } from "./settings-model.ts";
import { firstRunFinish, fixCommandEnv, linearSettingsDeps, reconfigureFinish } from "./setup-boot.ts";

test("fixCommandEnv drops the Linear key and keeps the rest", () => {
  const env = fixCommandEnv({ LINEAR_API_KEY: "lin_api_secret", PATH: "/usr/bin", HOME: "/home/u" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/u" });
});

test("fixCommandEnv skips unset values", () => {
  assert.deepEqual(fixCommandEnv({ PATH: "/bin", EMPTY: undefined }), { PATH: "/bin" });
});

const fakeApi = (seen: string[]) => ({
  fetchViewer: async (k: string) => {
    seen.push(k);
    return { name: "Ada" };
  },
  fetchTeams: async (k: string) => {
    seen.push(k);
    return [{ id: "t1", name: "Engineering" }];
  },
  fetchTeamStates: async (k: string, id: string) => {
    seen.push(k);
    return id === "t1" ? [{ name: "Todo" }, { name: "Done" }] : [];
  },
  fetchTeamLabels: async (k: string, id: string) => {
    seen.push(k);
    return id === "t1" ? ["infra"] : [];
  },
});

test("linearSettingsDeps queries Linear with the key it is given", async () => {
  const seen: string[] = [];
  const deps = linearSettingsDeps(() => "lin_api_given", fakeApi(seen));
  assert.equal(await deps.assignee(), "Ada");
  assert.deepEqual(await deps.teams(), ["Engineering"]);
  assert.deepEqual(await deps.states("engineering"), ["Todo", "Done"]);
  assert.deepEqual(await deps.labels("ENGINEERING"), ["infra"]);
  assert.deepEqual(await deps.states("Nope"), []);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((k) => k === "lin_api_given"));
});

test("firstRunFinish writes .env at mode 0600 and moves the old one to .env.bak", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-boot-"));
  const path = join(dir, ".env");
  writeFileSync(path, "LINEAR_API_KEY=old\nCUSTOM=keep\n", { mode: 0o600 });
  const config = { ...configFromEnv({}), apiKey: "lin_api_new", codebasePath: dir };
  const applied: Record<string, string> = {};
  const result = firstRunFinish(config, {
    path,
    installLinks: () => ["[ok] linked"],
    setProcessEnv: (r) => Object.assign(applied, r),
  });
  assert.deepEqual(result, { ok: true, linkResults: ["[ok] linked"] });
  assert.equal(readFileSync(`${path}.bak`, "utf8"), "LINEAR_API_KEY=old\nCUSTOM=keep\n");
  const written = readFileSync(path, "utf8");
  assert.match(written, /LINEAR_API_KEY=lin_api_new/);
  assert.match(written, /CUSTOM=keep/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(applied.LINEAR_API_KEY, "lin_api_new");
});

test("firstRunFinish leaves no backup when there was no .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-boot-"));
  const path = join(dir, ".env");
  const config = { ...configFromEnv({}), apiKey: "lin_api_new", codebasePath: dir };
  const result = firstRunFinish(config, { path, installLinks: () => [], setProcessEnv: () => {} });
  assert.equal(result.ok, true);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(`${path}.bak`));
});

test("reconfigureFinish writes nothing so the board's apply path owns the .env write", () => {
  assert.deepEqual(reconfigureFinish(), { ok: true, linkResults: [] });
});
