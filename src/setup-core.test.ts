import assert from "node:assert/strict";
import { test } from "node:test";
import { fixCommandFor, needsSetup, PREREQUISITES, setupMode } from "./setup-core.ts";

const binaries = ["git", "tmux", "gh", "node", "pnpm", "claude"];
const allOk = { commandExists: () => true, isGitRepo: () => true };
const validEnv = { LINEAR_API_KEY: "lin_api_x", CODEBASE_PATH: "/repo" };

test("needsSetup reports a blank LINEAR_API_KEY", async () => {
  const r = await needsSetup({ ...validEnv, LINEAR_API_KEY: "  " }, allOk);
  assert.equal(r.needed, true);
  assert.ok(r.reasons.some((x) => x.includes("LINEAR_API_KEY")));
});

test("needsSetup reports an unset CODEBASE_PATH", async () => {
  const r = await needsSetup({ LINEAR_API_KEY: "k" }, allOk);
  assert.equal(r.needed, true);
  assert.ok(r.reasons.some((x) => x.includes("CODEBASE_PATH")));
});

test("needsSetup reports a CODEBASE_PATH that is not a git repo", async () => {
  const r = await needsSetup(validEnv, { ...allOk, isGitRepo: () => false });
  assert.equal(r.needed, true);
  assert.ok(r.reasons.some((x) => x.includes("CODEBASE_PATH")));
});

test("needsSetup reports one reason per missing required binary, naming its label", async () => {
  const r = await needsSetup(validEnv, { ...allOk, commandExists: (name) => name !== "tmux" && name !== "claude" });
  assert.equal(r.needed, true);
  assert.deepEqual(r.reasons, ["Missing prerequisite: tmux", "Missing prerequisite: Claude Code CLI (claude)"]);
});

test("needsSetup is false when everything is in place", async () => {
  const r = await needsSetup(validEnv, allOk);
  assert.deepEqual(r, { needed: false, reasons: [] });
});

test("needsSetup probes only the required binaries, never auth, plugins or recommended checks", async () => {
  const probed: string[] = [];
  await needsSetup(validEnv, {
    ...allOk,
    commandExists: (name) => {
      probed.push(name);
      return true;
    },
  });
  assert.deepEqual(probed, binaries);
  const required = PREREQUISITES.filter((pr) => pr.severity === "required").map((pr) => pr.key);
  for (const key of ["gh-auth", "claude-auth", "superpowers"]) assert.ok(required.includes(key));
});

test("setupMode is none when setup is not needed, even without a TTY", () => {
  assert.equal(setupMode({ isTTY: true, term: "xterm-256color", needed: false }), "none");
  assert.equal(setupMode({ isTTY: false, term: undefined, needed: false }), "none");
});

test("setupMode falls back to the CLI prompts without a TTY", () => {
  assert.equal(setupMode({ isTTY: false, term: "xterm-256color", needed: true }), "cli");
});

test("setupMode falls back to the CLI prompts on a dumb terminal", () => {
  assert.equal(setupMode({ isTTY: true, term: "dumb", needed: true }), "cli");
});

test("setupMode opens the TUI wizard on a usable terminal", () => {
  assert.equal(setupMode({ isTTY: true, term: "xterm-256color", needed: true }), "tui");
  assert.equal(setupMode({ isTTY: true, term: undefined, needed: true }), "tui");
});

const prereq = (key: string) => {
  const pr = PREREQUISITES.find((p) => p.key === key);
  if (!pr) throw new Error(key);
  return pr;
};

test("fixCommandFor logs in to gh and installs package tools through the package manager", () => {
  assert.deepEqual(fixCommandFor(prereq("gh-auth"), null), ["gh", "auth", "login"]);
  assert.deepEqual(fixCommandFor(prereq("tmux"), "pacman"), ["sudo", "pacman", "-S", "--needed", "tmux"]);
  assert.equal(fixCommandFor(prereq("tmux"), null), null);
});

test("fixCommandFor runs the Claude Code login for claude-auth", () => {
  assert.deepEqual(fixCommandFor(prereq("claude-auth"), null), ["claude", "auth", "login"]);
});

test("fixCommandFor installs superpowers from the official marketplace, adding it when missing", () => {
  assert.deepEqual(fixCommandFor(prereq("superpowers"), null), [
    "claude",
    "plugin",
    "install",
    "superpowers",
    "--marketplace",
    "anthropics/claude-plugins-official",
  ]);
});
