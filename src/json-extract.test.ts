import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject } from "./json-extract.ts";

test("extractJsonObject parses the outermost braces, ignoring surrounding prose", () => {
  assert.deepEqual(extractJsonObject('Sure!\n{"a": 1}\nDone.'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"a": {"b": 2}}'), { a: { b: 2 } });
});

test("extractJsonObject returns null for junk", () => {
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject("{broken"), null);
  assert.equal(extractJsonObject("} backwards {"), null);
  assert.equal(extractJsonObject(""), null);
});
