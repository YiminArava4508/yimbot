import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPassthroughLines, serializeEnvFile, type YimbotConfig } from "./settings-model.ts";
import { finishWizard, nextStep, prevStep, stepHeader, validateKey, WIZARD_STEPS } from "./setup-wizard.ts";

const config: YimbotConfig = {
  apiKey: "lin_api_secret123",
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
  claimsPerHeartbeat: 1,
  autoCleanup: true,
  autoContinue: true,
  maxContinuations: 5,
  acJudgeModel: "",
  labelFilter: "",
  maxEstimate: "",
  autoRefine: true,
  refineUsers: "",
  refineLabelFilter: "",
  maxRefining: 1,
  splitTickets: true,
};

function fakeFx(overrides: Partial<Parameters<typeof finishWizard>[1]> = {}) {
  const calls: string[] = [];
  const written: string[] = [];
  const backups: string[] = [];
  const fx = {
    readEnv: () => null as string | null,
    writeEnv: (c: string) => {
      calls.push("write");
      written.push(c);
    },
    backupEnv: (c: string) => {
      calls.push("backup");
      backups.push(c);
    },
    installLinks: () => {
      calls.push("links");
      return ["[ok] linked"];
    },
    setProcessEnv: () => {
      calls.push("env");
    },
    ...overrides,
  };
  return { fx, calls, written, backups };
}

test("step order with null at both ends", () => {
  assert.deepEqual(WIZARD_STEPS, ["prereqs", "key", "configure", "confirm"]);
  assert.equal(prevStep("prereqs"), null);
  assert.equal(nextStep("prereqs"), "key");
  assert.equal(nextStep("configure"), "confirm");
  assert.equal(prevStep("confirm"), "configure");
  assert.equal(nextStep("confirm"), null);
});

test("stepHeader numbers the steps", () => {
  assert.equal(stepHeader("key"), "Step 2 of 4: Linear key");
});

test("validateKey rejects a blank key", async () => {
  assert.deepEqual(await validateKey("  "), { ok: false, error: "Required" });
});

test("validateKey returns the trimmed key and viewer name", async () => {
  const seen: string[] = [];
  const res = await validateKey("  lin_api_x \n", async (k) => {
    seen.push(k);
    return { name: "Yimin" };
  });
  assert.deepEqual(res, { ok: true, apiKey: "lin_api_x", viewerName: "Yimin" });
  assert.deepEqual(seen, ["lin_api_x"]);
});

test("validateKey reports a rejected fetch without throwing or leaking the key", async () => {
  const res = await validateKey("lin_api_bad", async () => {
    throw new Error("401 for lin_api_bad");
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /401/);
    assert.ok(!res.error.includes("lin_api_bad"));
  }
});

test("finishWizard backs up the old env before writing and keeps passthrough lines", () => {
  const old = "LINEAR_API_KEY=old\nCUSTOM_FLAG=1\n";
  const { fx, calls, written, backups } = fakeFx({ readEnv: () => old });
  const res = finishWizard(config, fx);
  assert.deepEqual(res, { ok: true, linkResults: ["[ok] linked"] });
  assert.deepEqual(backups, [old]);
  assert.ok(calls.indexOf("backup") < calls.indexOf("write"));
  assert.ok(calls.indexOf("write") < calls.indexOf("env"));
  assert.equal(written[0], serializeEnvFile(config, extractPassthroughLines(old)));
  assert.match(written[0], /CUSTOM_FLAG=1/);
});

test("finishWizard skips the backup when there is no env", () => {
  const { fx, calls } = fakeFx();
  assert.equal(finishWizard(config, fx).ok, true);
  assert.ok(!calls.includes("backup"));
});

test("finishWizard returns the failure and skips process env when the write throws", () => {
  const { fx, calls } = fakeFx({
    writeEnv: () => {
      throw new Error("EACCES writing lin_api_secret123");
    },
  });
  const res = finishWizard(config, fx);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /EACCES/);
    assert.ok(!res.error.includes("lin_api_secret123"));
  }
  assert.ok(!calls.includes("env"));
  assert.ok(!calls.includes("links"));
});

test("finishWizard fails without touching process env when the backup throws", () => {
  const { fx, calls } = fakeFx({
    readEnv: () => "A=1\n",
    backupEnv: () => {
      throw new Error("disk full");
    },
  });
  const res = finishWizard(config, fx);
  assert.equal(res.ok, false);
  assert.ok(!calls.includes("write"));
  assert.ok(!calls.includes("env"));
});
