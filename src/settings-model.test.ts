import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configFromEnv,
  configToEnvRecord,
  isOff,
  isPositiveInt,
  isPositiveNumber,
  parseCommaList,
  settingRows,
  newDraft,
  setEdit,
  dirtyKeys,
  draftRows,
  validateDraft,
  commitDraft,
  type YimbotConfig,
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

const sample: YimbotConfig = {
  apiKey: "lin_api_secret1234",
  teamName: "Engineering",
  deployStateName: "In Progress",
  reviewStateName: "In Review",
  todoStateName: "Todo",
  heartbeatIntervalMinutes: 3,
  codebasePath: "/home/u/Work/repo",
  planModel: "opus",
  implModel: "sonnet",
  autoClaim: true,
  riskLabels: ["migration", "infra"],
  maxInProgress: 4,
  autoCleanup: true,
  autoContinue: true,
  maxContinuations: 5,
  acJudgeModel: "",
  labelFilter: "!bot",
};

test("settingRows lists every setting once, in display order", () => {
  const rows = settingRows(sample, "Yimin Arava");
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.envKey), ["LINEAR_API_KEY", "ASSIGNEE", "LINEAR_TEAM_NAME"]);
  const keys = new Set(rows.map((r) => r.envKey));
  assert.equal(keys.size, 18);
  for (const k of Object.keys(configToEnvRecord(sample))) assert.equal(keys.has(k), true);
});

test("settingRows masks the api key and shows the assignee read-only", () => {
  const rows = settingRows(sample, "Yimin Arava");
  const key = rows.find((r) => r.envKey === "LINEAR_API_KEY")!;
  assert.equal(key.editor, "secret");
  assert.equal(key.display.includes("secret1234"), false);
  assert.match(key.display, /^lin_.*1234$/);
  const who = rows.find((r) => r.envKey === "ASSIGNEE")!;
  assert.equal(who.editor, "readonly");
  assert.equal(who.display, "Yimin Arava (this API key)");
});

test("settingRows masks short keys with only stars, never revealing input characters", () => {
  const display = (apiKey: string) =>
    settingRows({ ...sample, apiKey }, "x").find((r) => r.envKey === "LINEAR_API_KEY")!.display;
  assert.equal(display(""), "(not set)");
  const short4 = display("abcd");
  assert.equal(short4.includes("a"), false);
  assert.equal(short4.includes("b"), false);
  assert.equal(short4.includes("c"), false);
  assert.equal(short4.includes("d"), false);
  const short8 = display("abcdefgh");
  for (const c of "abcdefgh") assert.equal(short8.includes(c), false);
  const short9 = display("abcdefghi");
  for (const c of "abcdefghi") assert.equal(short9.includes(c), false);
  const long = display("abcdefghijklmnopqrst");
  assert.match(long, /^abcd.*qrst$/);
  assert.equal(long.includes("e"), false);
});

test("settingRows renders the label filter's three modes in words", () => {
  const display = (labelFilter: string) =>
    settingRows({ ...sample, labelFilter }, "x").find((r) => r.envKey === "LABEL_FILTER")!.display;
  assert.equal(display(""), "every ticket");
  assert.equal(display("bot"), 'only tickets labelled "bot"');
  assert.equal(display("!bot"), 'every ticket except those labelled "bot"');
});

test("settingRows renders toggles and lists readably", () => {
  const rows = settingRows({ ...sample, autoClaim: false }, "x");
  assert.equal(rows.find((r) => r.envKey === "AUTO_CLAIM")!.display, "off");
  assert.equal(rows.find((r) => r.envKey === "RISK_LABELS")!.display, "migration, infra");
  assert.equal(settingRows(sample, "x").find((r) => r.envKey === "AC_JUDGE_MODEL")!.display, "(claude default)");
});

test("a draft tracks only what changed and commits to a config", () => {
  let draft = newDraft(sample);
  assert.deepEqual(dirtyKeys(draft), []);
  draft = setEdit(draft, "MAX_IN_PROGRESS", "2");
  draft = setEdit(draft, "LABEL_FILTER", "bot");
  assert.deepEqual(dirtyKeys(draft).sort(), ["LABEL_FILTER", "MAX_IN_PROGRESS"]);
  const committed = commitDraft(draft);
  assert.equal(committed.maxInProgress, 2);
  assert.equal(committed.labelFilter, "bot");
  assert.equal(committed.teamName, sample.teamName);
});

test("an edit back to the current value is not dirty", () => {
  const draft = setEdit(newDraft(sample), "MAX_IN_PROGRESS", "4");
  assert.deepEqual(dirtyKeys(draft), []);
});

test("draftRows shows pending values, not the committed ones", () => {
  const draft = setEdit(newDraft(sample), "MAX_IN_PROGRESS", "9");
  const row = draftRows(draft, "x").find((r) => r.envKey === "MAX_IN_PROGRESS")!;
  assert.equal(row.display, "9");
});

test("validateDraft reports one message per invalid row and nothing when clean", () => {
  assert.deepEqual(validateDraft(newDraft(sample)), {});
  const bad = setEdit(
    setEdit(setEdit(newDraft(sample), "MAX_IN_PROGRESS", "0"), "HEARTBEAT_INTERVAL_MINUTES", "x"),
    "PLAN_MODEL",
    "  ",
  );
  const errors = validateDraft(bad);
  assert.deepEqual(Object.keys(errors).sort(), [
    "HEARTBEAT_INTERVAL_MINUTES",
    "MAX_IN_PROGRESS",
    "PLAN_MODEL",
  ]);
  assert.match(errors.MAX_IN_PROGRESS, /positive integer/i);
});

test("validateDraft rejects a codebase path that is not a git repository", () => {
  const errors = validateDraft(setEdit(newDraft(sample), "CODEBASE_PATH", "/definitely/not/here"));
  assert.match(errors.CODEBASE_PATH, /git repository/i);
});

test("commitDraft throws rather than committing an invalid draft", () => {
  assert.throws(() => commitDraft(setEdit(newDraft(sample), "MAX_IN_PROGRESS", "0")));
});
