import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommentArgs } from "./comment-args.ts";

test("parseCommentArgs handles the plain form", () => {
  assert.deepEqual(parseCommentArgs(["ENG-1", "hello"]), { ticket: "ENG-1", bodyArg: "hello", marker: null });
});

test("parseCommentArgs handles --upsert with a marker", () => {
  assert.deepEqual(parseCommentArgs(["--upsert", "<!-- yimbot:qa -->", "ENG-1", "-"]), {
    ticket: "ENG-1",
    bodyArg: "-",
    marker: "<!-- yimbot:qa -->",
  });
});

test("parseCommentArgs rejects missing pieces", () => {
  assert.equal(parseCommentArgs(["ENG-1"]), null);
  assert.equal(parseCommentArgs(["--upsert", "ENG-1", "body"]), null);
  assert.equal(parseCommentArgs([]), null);
});
