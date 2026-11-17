import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./test-temp.ts";
import {
  ensureReadsUnblocked,
  projectSettingsPaths,
  readBlockKeysOn,
  stripReadBlock,
  userSettingsPath,
} from "./read-block.ts";

test("readBlockKeysOn ignores a non-object permissions value", () => {
  for (const permissions of ["on", true, null, ["blockReadsOutsideWorkingDirectories"]]) {
    assert.deepEqual(readBlockKeysOn(JSON.stringify({ permissions })), []);
  }
});

test("userSettingsPath follows CLAUDE_CONFIG_DIR", () => {
  assert.equal(userSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }), "/cfg/settings.json");
  assert.match(userSettingsPath({}), /\.claude\/settings\.json$/);
});

test("projectSettingsPaths lists the repo's shared and local settings", () => {
  assert.deepEqual(projectSettingsPaths("/repo"), ["/repo/.claude/settings.json", "/repo/.claude/settings.local.json"]);
});

test("ensureReadsUnblocked warns on unparseable user settings and leaves them alone", () => {
  const dir = tempDir("read-block-");
  const user = join(dir, "settings.json");
  writeFileSync(user, "{ // comment\n}");
  const lines = ensureReadsUnblocked({ user, warnOnly: [], now: () => 1 });
  assert.equal(readFileSync(user, "utf8"), "{ // comment\n}");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[warn\] .*isn't valid JSON/);
});

test("ensureReadsUnblocked edits through a symlink and keeps the link", () => {
  const dir = tempDir("read-block-");
  const real = join(dir, "dotfiles-settings.json");
  const user = join(dir, "settings.json");
  writeFileSync(real, JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } }));
  symlinkSync(real, user);

  ensureReadsUnblocked({ user, warnOnly: [], now: () => 7 });

  assert.ok(lstatSync(user).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { permissions: {} });
  assert.ok(existsSync(`${user}.bak.7`));
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".yimbot-tmp")));
});

test("stripReadBlock removes both read-block keys and keeps the rest", () => {
  const input = JSON.stringify({
    model: "opus",
    permissions: {
      allow: ["Bash(ls:*)"],
      blockReadsOutsideWorkingDirectories: true,
      blockFileToolReadsOutsideWorkingDirectories: true,
    },
  });
  const result = stripReadBlock(input);
  assert.ok(result);
  assert.deepEqual(result.removed, [
    "blockReadsOutsideWorkingDirectories",
    "blockFileToolReadsOutsideWorkingDirectories",
  ]);
  assert.deepEqual(JSON.parse(result.text), { model: "opus", permissions: { allow: ["Bash(ls:*)"] } });
  assert.ok(result.text.endsWith("\n"));
});

test("stripReadBlock returns null when no read-block key is on", () => {
  assert.equal(stripReadBlock(JSON.stringify({ permissions: { allow: [] } })), null);
  assert.equal(stripReadBlock(JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: false } })), null);
  assert.equal(stripReadBlock("{}"), null);
});

test("stripReadBlock returns null for unparseable JSON", () => {
  assert.equal(stripReadBlock("{ not json"), null);
});

test("readBlockKeysOn lists only keys set to true", () => {
  const text = JSON.stringify({
    permissions: { blockReadsOutsideWorkingDirectories: true, blockFileToolReadsOutsideWorkingDirectories: false },
  });
  assert.deepEqual(readBlockKeysOn(text), ["blockReadsOutsideWorkingDirectories"]);
  assert.deepEqual(readBlockKeysOn("garbage"), []);
});

test("ensureReadsUnblocked strips user settings and writes a backup", () => {
  const dir = tempDir("read-block-");
  const user = join(dir, "settings.json");
  const original = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } });
  writeFileSync(user, original);

  const lines = ensureReadsUnblocked({ user, warnOnly: [], now: () => 42 });

  assert.deepEqual(JSON.parse(readFileSync(user, "utf8")), { permissions: {} });
  assert.equal(readFileSync(`${user}.bak.42`, "utf8"), original);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[ok\] removed blockReadsOutsideWorkingDirectories/);
});

test("ensureReadsUnblocked leaves clean or missing user settings alone", () => {
  const dir = tempDir("read-block-");
  const user = join(dir, "settings.json");
  assert.deepEqual(ensureReadsUnblocked({ user, warnOnly: [], now: () => 1 }), []);
  writeFileSync(user, "{}");
  assert.deepEqual(ensureReadsUnblocked({ user, warnOnly: [], now: () => 1 }), []);
  assert.equal(existsSync(`${user}.bak.1`), false);
});

test("ensureReadsUnblocked warns about managed settings without editing them", () => {
  const dir = tempDir("read-block-");
  const managed = join(dir, "managed-settings.json");
  const text = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } });
  writeFileSync(managed, text);

  const lines = ensureReadsUnblocked({ user: join(dir, "absent.json"), warnOnly: [managed], now: () => 1 });

  assert.equal(readFileSync(managed, "utf8"), text);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[warn\] .*managed-settings.json sets blockReadsOutsideWorkingDirectories/);
});
