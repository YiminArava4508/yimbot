import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeLabelFilter,
  filterByLabel,
  labelFilterAllows,
  parseLabelFilter,
} from "./labels.ts";

test("parseLabelFilter treats unset, empty and whitespace as no restriction", () => {
  assert.equal(parseLabelFilter(undefined), null);
  assert.equal(parseLabelFilter(""), null);
  assert.equal(parseLabelFilter("   "), null);
});

test("parseLabelFilter reads a plain label as an include filter", () => {
  assert.deepEqual(parseLabelFilter(" Bot "), { label: "bot", negated: false });
});

test("parseLabelFilter reads a leading ! as an exclude filter", () => {
  assert.deepEqual(parseLabelFilter("!bot"), { label: "bot", negated: true });
  assert.deepEqual(parseLabelFilter("! bot"), { label: "bot", negated: true });
});

test("parseLabelFilter treats a bare ! as no restriction", () => {
  assert.equal(parseLabelFilter("!"), null);
});

test("labelFilterAllows passes everything when there is no filter", () => {
  assert.equal(labelFilterAllows(null, []), true);
  assert.equal(labelFilterAllows(null, ["bot"]), true);
});

test("labelFilterAllows requires the label when the filter is not negated", () => {
  const f = parseLabelFilter("bot");
  assert.equal(labelFilterAllows(f, ["BOT"]), true);
  assert.equal(labelFilterAllows(f, ["infra", "bot"]), true);
  assert.equal(labelFilterAllows(f, ["infra"]), false);
  assert.equal(labelFilterAllows(f, []), false);
});

test("labelFilterAllows rejects the label when the filter is negated", () => {
  const f = parseLabelFilter("!bot");
  assert.equal(labelFilterAllows(f, ["bot"]), false);
  assert.equal(labelFilterAllows(f, ["infra"]), true);
  assert.equal(labelFilterAllows(f, []), true);
});

test("filterByLabel keeps only allowed items", () => {
  const items = [
    { id: "a", labels: ["bot"] },
    { id: "b", labels: [] },
  ];
  assert.deepEqual(
    filterByLabel(parseLabelFilter("bot"), items).map((i) => i.id),
    ["a"],
  );
  assert.deepEqual(
    filterByLabel(parseLabelFilter("!bot"), items).map((i) => i.id),
    ["b"],
  );
  assert.deepEqual(filterByLabel(null, items).map((i) => i.id), ["a", "b"]);
});

test("describeLabelFilter renders each mode for the startup log", () => {
  assert.equal(describeLabelFilter(null), "every ticket");
  assert.equal(describeLabelFilter(parseLabelFilter("bot")), 'only tickets labelled "bot"');
  assert.equal(describeLabelFilter(parseLabelFilter("!bot")), 'every ticket except those labelled "bot"');
});
