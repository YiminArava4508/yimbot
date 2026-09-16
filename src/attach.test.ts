import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { uploadAndUnlink } from "./attach.ts";
import { tempDir } from "./test-temp.ts";

test("uploadAndUnlink returns the asset url and removes the file", async () => {
  const dir = tempDir("yimbot-attach-");
  const file = join(dir, "shot.png");
  writeFileSync(file, "bytes");
  const url = await uploadAndUnlink(file, async () => "https://uploads/asset.png");
  assert.equal(url, "https://uploads/asset.png");
  assert.equal(existsSync(file), false);
});

test("uploadAndUnlink removes the file even when the upload throws", async () => {
  const dir = tempDir("yimbot-attach-");
  const file = join(dir, "shot.png");
  writeFileSync(file, "bytes");
  await assert.rejects(
    uploadAndUnlink(file, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(existsSync(file), false);
});

test("uploadAndUnlink tolerates a file that is already gone", async () => {
  const removed: string[] = [];
  const url = await uploadAndUnlink(
    "/no/such/file.png",
    async () => "https://uploads/a.png",
    (p) => {
      removed.push(p);
      throw new Error("ENOENT");
    },
  );
  assert.equal(url, "https://uploads/a.png");
  assert.deepEqual(removed, ["/no/such/file.png"]);
});
