import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  configToEnvRecord,
  expandTilde,
  isConfigured,
  isGitRepo,
  serializeEnvFile,
  type YimbotConfig,
} from "./setup.ts";

const sample: YimbotConfig = {
  apiKey: "lin_api_secret",
  teamName: "Engineering",
  triggerStateName: "In Progress",
  reviewStateName: "In Review",
  todoStateName: "Todo",
  heartbeatIntervalMinutes: 3,
  codebasePath: "/home/ymbo/Work/gemini",
  resumeOnReview: false,
  autoPick: false,
  maxReview: 3,
  riskLabels: ["migration", "infra"],
};

test("isConfigured requires a non-empty API key", () => {
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured({ LINEAR_API_KEY: "" }), false);
  assert.equal(isConfigured({ LINEAR_API_KEY: "   " }), false);
  assert.equal(isConfigured({ LINEAR_API_KEY: "lin_api_x" }), true);
});

test("expandTilde expands a leading ~ only", () => {
  assert.equal(expandTilde("~"), homedir());
  assert.equal(expandTilde("~/Work/gemini"), join(homedir(), "Work/gemini"));
  assert.equal(expandTilde("/abs/path"), "/abs/path");
  assert.equal(expandTilde("relative"), "relative");
  assert.equal(expandTilde("/has/~/inside"), "/has/~/inside");
});

test("isGitRepo is true for a real repo, false otherwise", () => {
  // The yimbot repo root is a git repo (tests run with cwd = project root).
  assert.equal(isGitRepo(process.cwd()), true);
  const notARepo = mkdtempSync(join(tmpdir(), "yimbot-nogit-"));
  assert.equal(isGitRepo(notARepo), false);
  assert.equal(isGitRepo(join(notARepo, "does-not-exist")), false);
  // A freshly-init'd repo reads as a repo.
  const repo = mkdtempSync(join(tmpdir(), "yimbot-git-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  assert.equal(isGitRepo(repo), true);
});

test("configToEnvRecord maps every setting to its env key", () => {
  const r = configToEnvRecord(sample);
  assert.equal(r.LINEAR_API_KEY, "lin_api_secret");
  assert.equal(r.LINEAR_TEAM_NAME, "Engineering");
  assert.equal(r.TRIGGER_STATE_NAME, "In Progress");
  assert.equal(r.REVIEW_STATE_NAME, "In Review");
  assert.equal(r.TODO_STATE_NAME, "Todo");
  assert.equal(r.HEARTBEAT_INTERVAL_MINUTES, "3");
  assert.equal(r.CODEBASE_PATH, "/home/ymbo/Work/gemini");
  assert.equal(r.RESUME_ON_REVIEW, "false");
  assert.equal(r.AUTO_PICK, "false");
  assert.equal(r.MAX_REVIEW, "3");
  assert.equal(r.RISK_LABELS, "migration,infra");
});

test("serializeEnvFile emits parseable KEY=value lines with the picker section", () => {
  const text = serializeEnvFile(sample);
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    kv[line.slice(0, i)] = line.slice(i + 1);
  }
  assert.equal(kv.LINEAR_API_KEY, "lin_api_secret");
  assert.equal(kv.REVIEW_STATE_NAME, "In Review");
  assert.equal(kv.AUTO_PICK, "false");
  assert.equal(kv.RISK_LABELS, "migration,infra");
  assert.ok(text.includes("# --- Autonomous ticket picker ---"));
});

test("serializeEnvFile round-trips empty risk labels", () => {
  const text = serializeEnvFile({ ...sample, riskLabels: [], autoPick: true });
  assert.match(text, /^RISK_LABELS=$/m);
  assert.match(text, /^AUTO_PICK=true$/m);
});
