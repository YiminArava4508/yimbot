import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configFromEnv,
  configToEnvRecord,
  isOff,
  isPositiveInt,
  isPositiveNumber,
  parseCommaList,
} from "./settings-model.ts";

test("isOff recognizes only the documented off values", () => {
  for (const v of ["false", "off", "no", "0", "FALSE", "Off"]) assert.equal(isOff(v), true);
  for (const v of ["true", "on", "yes", "1", ""]) assert.equal(isOff(v), false);
});

test("isPositiveInt and isPositiveNumber guard their boundaries", () => {
  assert.equal(isPositiveInt("1"), true);
  assert.equal(isPositiveInt("0"), false);
  assert.equal(isPositiveInt("2.5"), false);
  assert.equal(isPositiveInt("x"), false);
  assert.equal(isPositiveNumber("0.5"), true);
  assert.equal(isPositiveNumber("0"), false);
  assert.equal(isPositiveNumber("x"), false);
});

test("parseCommaList trims and drops empties", () => {
  assert.deepEqual(parseCommaList(" a , b ,, c "), ["a", "b", "c"]);
  assert.deepEqual(parseCommaList(""), []);
});

test("configFromEnv falls back to every daemon default when nothing is set", () => {
  const c = configFromEnv({});
  assert.equal(c.apiKey, "");
  assert.equal(c.teamName, "Engineering");
  assert.equal(c.deployStateName, "In Progress");
  assert.equal(c.reviewStateName, "In Review");
  assert.equal(c.todoStateName, "Todo");
  assert.equal(c.heartbeatIntervalMinutes, 3);
  assert.equal(c.planModel, "opus");
  assert.equal(c.implModel, "sonnet");
  assert.equal(c.autoClaim, true);
  assert.deepEqual(c.riskLabels, ["migration", "infra", "security", "breaking"]);
  assert.equal(c.maxInProgress, 3);
  assert.equal(c.autoCleanup, true);
  assert.equal(c.autoContinue, true);
  assert.equal(c.maxContinuations, 5);
  assert.equal(c.acJudgeModel, "");
  assert.equal(c.labelFilter, "");
});

test("configFromEnv honors the legacy variable names the daemon still reads", () => {
  assert.equal(configFromEnv({ TRIGGER_STATE_NAME: "Doing" }).deployStateName, "Doing");
  assert.equal(configFromEnv({ POLL_INTERVAL_MINUTES: "7" }).heartbeatIntervalMinutes, 7);
  assert.equal(configFromEnv({ AUTO_PICK: "false" }).autoClaim, false);
  assert.equal(
    configFromEnv({ DEPLOY_STATE_NAME: "New", TRIGGER_STATE_NAME: "Old" }).deployStateName,
    "New",
  );
});

test("configFromEnv is the inverse of configToEnvRecord", () => {
  const config = {
    apiKey: "lin_api_x",
    teamName: "Platform",
    deployStateName: "In Progress",
    reviewStateName: "In Review",
    todoStateName: "Todo",
    heartbeatIntervalMinutes: 4,
    codebasePath: "/home/u/Work/repo",
    planModel: "opus",
    implModel: "sonnet",
    autoClaim: false,
    riskLabels: ["infra", "security"],
    maxInProgress: 2,
    autoCleanup: false,
    autoContinue: false,
    maxContinuations: 9,
    acJudgeModel: "sonnet",
    labelFilter: "!bot",
  };
  assert.deepEqual(configFromEnv(configToEnvRecord(config)), config);
});
