import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESEARCH_WORDS, researchWords, ticketType } from "./ticket-type.ts";

test("ticketType reads research from a title that opens with a research verb", () => {
  assert.equal(ticketType("Decide retention for bov-exports/ objects"), "research");
  assert.equal(ticketType("Investigate slow escrow sync"), "research");
  assert.equal(ticketType("Spike: streaming exports"), "research");
});

test("ticketType matches the verb anywhere in the title, by word start, any case", () => {
  assert.equal(ticketType("Retention: RESEARCH the options"), "research");
  assert.equal(ticketType("Write up the evaluation of vendors"), "research");
});

test("ticketType leaves ordinary work titles untyped", () => {
  assert.equal(ticketType("Add column to listings table"), null);
  assert.equal(ticketType("Fix undecided-state crash"), null);
  assert.equal(ticketType("Fix file explorer crash"), null);
  assert.equal(ticketType("Show assessments tab"), null);
  assert.equal(ticketType(undefined), null);
  assert.equal(ticketType(""), null);
});

test("ticketType takes a custom word list", () => {
  assert.equal(ticketType("Compare CDN vendors", ["compare"]), "research");
  assert.equal(ticketType("Decide retention", ["compare"]), null);
});

test("researchWords falls back to the defaults and reads RESEARCH_TITLE_WORDS when set", () => {
  const prev = process.env.RESEARCH_TITLE_WORDS;
  try {
    delete process.env.RESEARCH_TITLE_WORDS;
    assert.deepEqual(researchWords(), DEFAULT_RESEARCH_WORDS);
    process.env.RESEARCH_TITLE_WORDS = " Compare, audit ,";
    assert.deepEqual(researchWords(), ["compare", "audit"]);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_TITLE_WORDS;
    else process.env.RESEARCH_TITLE_WORDS = prev;
  }
});
