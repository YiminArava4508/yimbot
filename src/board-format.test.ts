import assert from "node:assert/strict";
import { test } from "node:test";
import { repoDisplayName, titleCell } from "./board-format.ts";

test("repoDisplayName is blank until the row has a PR", () => {
  assert.equal(repoDisplayName({ pr: undefined, repo: "owner/extra" }, "codebase"), "");
  assert.equal(repoDisplayName({}, "codebase"), "");
});

test("repoDisplayName names a codebase PR after the codebase checkout", () => {
  assert.equal(repoDisplayName({ pr: 12 }, "codebase"), "codebase");
});

test("repoDisplayName names an extra-repo PR by the name half of its slug", () => {
  assert.equal(repoDisplayName({ pr: 12, repo: "owner/extra-repo" }, "codebase"), "extra-repo");
});

test("titleCell passes a plain title through", () => {
  assert.equal(titleCell({ key: "ENG-1", title: "Fix the thing" }, ["research"]), "Fix the thing");
  assert.equal(titleCell({ key: "ENG-1" }, ["research"]), "");
});

test("titleCell puts the research chip ahead of a research title", () => {
  assert.equal(
    titleCell({ key: "ENG-1", title: "Research the cache" }, ["research"]),
    "{magenta-fg}[research]{/magenta-fg} Research the cache",
  );
});

test("titleCell puts the pr chip ahead of a row keyed by its PR, over any title word", () => {
  assert.equal(
    titleCell({ key: "pr:42", title: "Research the cache" }, ["research"]),
    "{cyan-fg}[pr]{/cyan-fg} Research the cache",
  );
});
