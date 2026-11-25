import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_MASTER_ACCESS, YIMBOT_REPO, hasWriteAccess, isOn, isYimbotRepo, masterAuthors, masterMergeEnabled, masterStatus, selfImproveAllowed, type MasterAccess } from "./master.ts";

const writeAccess: MasterAccess = { login: "me", permission: "WRITE", canEdit: true };

test("hasWriteAccess accepts WRITE, MAINTAIN and ADMIN only", () => {
  for (const p of ["WRITE", "MAINTAIN", "ADMIN"]) assert.equal(hasWriteAccess(p), true);
  for (const p of ["READ", "TRIAGE", ""]) assert.equal(hasWriteAccess(p), false);
});

test("NO_MASTER_ACCESS grants nothing", () => {
  assert.deepEqual(NO_MASTER_ACCESS, { login: "", permission: "unknown", canEdit: false });
});

test("masterStatus needs the flag and write access", () => {
  const missing = masterStatus(true, NO_MASTER_ACCESS);
  assert.equal(missing.master, false);
  assert.ok(missing.reason);
  assert.deepEqual(masterStatus(false, writeAccess), { master: false, reason: null });
  assert.deepEqual(masterStatus(true, writeAccess), { master: true, reason: null });
});

test("masterAuthors lowercases, trims and defaults to the viewer", () => {
  assert.deepEqual(masterAuthors("", "Me"), new Set(["me"]));
  assert.deepEqual(masterAuthors(" A, b ", "me"), new Set(["a", "b"]));
});

test("selfImproveAllowed needs auto self-improve and master", () => {
  assert.equal(selfImproveAllowed(true, true), true);
  assert.equal(selfImproveAllowed(true, false), false);
  assert.equal(selfImproveAllowed(false, true), false);
  assert.equal(selfImproveAllowed(false, false), false);
});

test("isOn accepts only an explicit truthy value", () => {
  for (const v of ["true", "on", "yes", "1", " TRUE ", "On"]) assert.equal(isOn(v), true, v);
  for (const v of ["", "false", "flase", "disabled", "n", "off", "0", "2"]) assert.equal(isOn(v), false, v);
});

test("masterMergeEnabled needs gh, master, an explicit on flag and a viewer login", () => {
  const base = { gh: true, master: true, flag: "true", login: "me" };
  assert.equal(masterMergeEnabled(base), true);
  assert.equal(masterMergeEnabled({ ...base, flag: "flase" }), false);
  assert.equal(masterMergeEnabled({ ...base, flag: "" }), false);
  assert.equal(masterMergeEnabled({ ...base, gh: false }), false);
  assert.equal(masterMergeEnabled({ ...base, master: false }), false);
  assert.equal(masterMergeEnabled({ ...base, login: "" }), false);
});

test("isYimbotRepo matches only the upstream yimbot repo, ignoring case", () => {
  assert.equal(YIMBOT_REPO, "YiminArava4508/yimbot");
  assert.equal(isYimbotRepo({ owner: "YiminArava4508", name: "yimbot" }), true);
  assert.equal(isYimbotRepo({ owner: "yiminarava4508", name: "YIMBOT" }), true);
  assert.equal(isYimbotRepo({ owner: "someone", name: "yimbot" }), false);
  assert.equal(isYimbotRepo(null), false);
});
