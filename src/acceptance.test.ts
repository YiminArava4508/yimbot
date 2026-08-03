import assert from "node:assert/strict";
import { test } from "node:test";
import { type AC, AC_COMMENT_MARKER, parseAcceptanceCriteria, parseAcComment, renderAcComment } from "./acceptance.ts";

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
