import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AC,
  AC_COMMENT_MARKER,
  applyJudgment,
  isComplete,
  type Judgment,
  openAcs,
  parseAcceptanceCriteria,
  parseAcComment,
  renderAcComment,
  satisfiedCount,
  selectContinuation,
} from "./acceptance.ts";

const DESC = `User Story blah.

### PDF Upload Acceptance Criteria

 1. An Upload PDF button is displayed.
 2. Users can upload a supported PDF file.

### Excel Upload Acceptance Criteria

 1. An Upload Excel button is displayed.

### Shared Acceptance Criteria

1. Offers appear in the table.`;

test("parseAcceptanceCriteria assigns section-scoped stable ids", () => {
  const acs = parseAcceptanceCriteria(DESC);
  assert.deepEqual(
    acs.map((a) => a.id),
    ["pdf-1", "pdf-2", "excel-1", "shared-1"],
  );
  assert.equal(acs[0].section, "pdf");
  assert.equal(acs[0].text, "An Upload PDF button is displayed.");
  assert.ok(acs.every((a: AC) => a.status === "open"));
});

test("parseAcceptanceCriteria returns [] when no AC heading present", () => {
  assert.deepEqual(parseAcceptanceCriteria("Just a description, no criteria."), []);
});

test("renderAcComment/parseAcComment round-trip preserves status and reasons", () => {
  const acs: AC[] = [
    { id: "pdf-1", section: "pdf", text: "Upload button", status: "satisfied" },
    { id: "pdf-2", section: "pdf", text: "Validate file", status: "open" },
    { id: "excel-13", section: "excel", text: "Retain file", status: "skipped", skipReason: "manual" },
  ];
  const body = renderAcComment(acs);
  assert.ok(body.startsWith(AC_COMMENT_MARKER));
  const back = parseAcComment(body);
  assert.deepEqual(back, acs);
});

test("parseAcComment returns [] without the marker", () => {
  assert.deepEqual(parseAcComment("some human comment"), []);
});

const base = (): AC[] => [
  { id: "pdf-1", section: "pdf", text: "a", status: "open" },
  { id: "pdf-2", section: "pdf", text: "b", status: "open" },
  { id: "excel-1", section: "excel", text: "c", status: "open" },
];

test("applyJudgment marks satisfied and skipped, never un-satisfies", () => {
  const j: Judgment = { satisfied: ["pdf-1"], skipped: [{ id: "excel-1", reason: "manual" }] };
  const out = applyJudgment(base(), j);
  assert.equal(out.find((a) => a.id === "pdf-1")?.status, "satisfied");
  assert.equal(out.find((a) => a.id === "excel-1")?.status, "skipped");
  assert.equal(out.find((a) => a.id === "excel-1")?.skipReason, "manual");
  assert.equal(out.find((a) => a.id === "pdf-2")?.status, "open");
  // re-applying empty judgment keeps pdf-1 satisfied
  assert.equal(
    applyJudgment(out, { satisfied: [], skipped: [] }).find((a) => a.id === "pdf-1")?.status,
    "satisfied",
  );
});

test("applyJudgment never un-satisfies an already-satisfied AC even if later skipped", () => {
  const done = applyJudgment(base(), { satisfied: ["pdf-1"], skipped: [] });
  const after = applyJudgment(done, { satisfied: [], skipped: [{ id: "pdf-1", reason: "oops" }] });
  assert.equal(after.find((a) => a.id === "pdf-1")?.status, "satisfied");
});

test("isComplete true when all satisfied or skipped", () => {
  const acs = applyJudgment(base(), { satisfied: ["pdf-1", "pdf-2"], skipped: [{ id: "excel-1", reason: "x" }] });
  assert.equal(isComplete(acs), true);
  assert.equal(openAcs(acs).length, 0);
});

test("selectContinuation: complete, halt-no-progress, halt-max, continue", () => {
  const done = applyJudgment(base(), { satisfied: ["pdf-1", "pdf-2", "excel-1"], skipped: [] });
  assert.deepEqual(selectContinuation(done, 2, 1, 5), { kind: "complete" });

  const oneDone = applyJudgment(base(), { satisfied: ["pdf-1"], skipped: [] });
  assert.equal(selectContinuation(oneDone, satisfiedCount(oneDone), 1, 5).kind, "halt"); // 1 <= 1
  assert.equal(selectContinuation(oneDone, 0, 1, 5).kind, "continue"); // 1 > 0
  assert.equal(selectContinuation(oneDone, 0, 5, 5).kind, "halt"); // round cap
});
