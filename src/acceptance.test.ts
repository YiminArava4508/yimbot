import assert from "node:assert/strict";
import { test } from "node:test";
import { type AC, parseAcceptanceCriteria } from "./acceptance.ts";

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
