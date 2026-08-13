import assert from "node:assert/strict";
import { test } from "node:test";
import { applySettings, type ApplyEffects } from "./settings-apply.ts";
import { configToEnvRecord, serializeEnvFile, type YimbotConfig } from "./settings-model.ts";

const prev: YimbotConfig = {
  apiKey: "lin_api_old",
  teamName: "Engineering",
  deployStateName: "In Progress",
  reviewStateName: "In Review",
  todoStateName: "Todo",
  heartbeatIntervalMinutes: 3,
  codebasePath: "/home/u/Work/repo",
  planModel: "opus",
  implModel: "sonnet",
  autoClaim: true,
  riskLabels: ["infra"],
  maxInProgress: 3,
  autoCleanup: true,
  autoContinue: true,
  maxContinuations: 5,
  acJudgeModel: "",
  labelFilter: "!bot",
};
const next: YimbotConfig = { ...prev, maxInProgress: 1, labelFilter: "bot" };

function harness(restartResults: (Error | null)[]) {
  const writes: string[] = [];
  const envs: Record<string, string>[] = [];
  let restarts = 0;
  const effects: ApplyEffects = {
    readEnv: () => "OLD FILE CONTENTS",
    writeEnv: (contents) => void writes.push(contents),
    setProcessEnv: (record) => void envs.push(record),
    restart: async () => {
      const outcome = restartResults[restarts] ?? null;
      restarts++;
      if (outcome) throw outcome;
    },
  };
  return { effects, writes, envs, restarts: () => restarts };
}

test("a successful apply writes the file, sets the env, and restarts once", async () => {
  const h = harness([null]);
  const result = await applySettings(next, prev, h.effects);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.writes, [serializeEnvFile(next)]);
  assert.deepEqual(h.envs, [configToEnvRecord(next)]);
  assert.equal(h.restarts(), 1);
});

test("a failed restart rolls the file and env back and restarts on the old config", async () => {
  const h = harness([new Error("CODEBASE_PATH is not a git repository"), null]);
  const result = await applySettings(next, prev, h.effects);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not a git repository/);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(h.writes, [serializeEnvFile(next), "OLD FILE CONTENTS"]);
  assert.deepEqual(h.envs, [configToEnvRecord(next), configToEnvRecord(prev)]);
  assert.equal(h.restarts(), 2);
});

test("when the rollback restart also fails the daemon is reported down", async () => {
  const h = harness([new Error("linear unreachable"), new Error("still unreachable")]);
  const result = await applySettings(next, prev, h.effects);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rolledBack, false);
  assert.match(result.error, /linear unreachable/);
});

test("a first run with no existing .env rolls back by writing the old config out", async () => {
  const h = harness([new Error("nope"), null]);
  h.effects.readEnv = () => null;
  const result = await applySettings(next, prev, h.effects);
  assert.equal(result.ok, false);
  assert.deepEqual(h.writes, [serializeEnvFile(next), serializeEnvFile(prev)]);
});

test("a rejection with a plain object preserves recognizable properties in the error", async () => {
  const plainObjectError = { code: "ECONNREFUSED", errno: -111, message: "connection refused" };
  const h = harness([plainObjectError as unknown as Error | null, null]);
  const result = await applySettings(next, prev, h.effects);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /ECONNREFUSED/);
  assert.equal(result.rolledBack, true);
});

test("a rejection with a string passes through unchanged", async () => {
  const stringError = "daemon shutdown in progress";
  const h = harness([stringError as unknown as Error | null, null]);
  const result = await applySettings(next, prev, h.effects);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, stringError);
  assert.equal(result.rolledBack, true);
});
