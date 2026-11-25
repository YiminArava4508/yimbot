import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_MASTER_ACCESS, hasWriteAccess, masterAuthors, masterStatus, type MasterAccess } from "./master.ts";

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
