import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenPR } from "./gh.ts";
import { mergeOpenPRs, parseExtraRepos } from "./multi-repo.ts";

test("parseExtraRepos: empty and whitespace mean no extra repos", () => {
  assert.deepEqual(parseExtraRepos(""), []);
  assert.deepEqual(parseExtraRepos("  , "), []);
});

test("parseExtraRepos: splits on commas, trims, keeps order", () => {
  assert.deepEqual(parseExtraRepos(" acme/terraform-aws-platform,acme/terraform-cluster "), [
    "acme/terraform-aws-platform",
    "acme/terraform-cluster",
  ]);
});

test("parseExtraRepos: rejects a slug that is not owner/name, naming it", () => {
  assert.throws(() => parseExtraRepos("acme/ok,terraform-aws-platform"), /terraform-aws-platform/);
  assert.throws(() => parseExtraRepos("acme/a/b"), /acme\/a\/b/);
  assert.throws(() => parseExtraRepos("https://github.com/acme/x"), /github\.com/);
});

function pr(number: number, repo?: string): OpenPR {
  return { number, headRefName: `eng-${number}-x`, isDraft: false, ...(repo ? { repo } : {}) };
}

test("mergeOpenPRs: concatenates primary then extras in order", () => {
  const out = mergeOpenPRs([pr(10)], [[pr(1, "acme/tf")], [pr(2, "acme/tf2")]], () => {});
  assert.deepEqual(
    out.map((p) => [p.number, p.repo]),
    [
      [10, undefined],
      [1, "acme/tf"],
      [2, "acme/tf2"],
    ],
  );
});

test("mergeOpenPRs: drops a later PR whose number collides, with a log line", () => {
  const logs: string[] = [];
  const out = mergeOpenPRs([pr(7)], [[pr(7, "acme/tf"), pr(8, "acme/tf")], [pr(8, "acme/tf2")]], (m) => logs.push(m));
  assert.deepEqual(
    out.map((p) => [p.number, p.repo]),
    [
      [7, undefined],
      [8, "acme/tf"],
    ],
  );
  assert.equal(logs.length, 2);
  assert.match(logs[0], /acme\/tf#7/);
  assert.match(logs[1], /acme\/tf2#8/);
});
