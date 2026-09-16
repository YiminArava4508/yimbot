import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTicket, type Ticket } from "./ticket-format.ts";

const ticket: Ticket = {
  identifier: "ENG-42",
  title: "Add widget",
  url: "https://linear.app/x/issue/ENG-42",
  state: "In Progress",
  estimate: 3,
  labels: ["backend", "api"],
  parent: "ENG-40",
  assignee: "Yimin",
  description: "Build the widget.\n\n- [ ] AC one",
  comments: [
    { author: "Ada", createdAt: "2026-09-01T10:00:00.000Z", body: "Use the v2 endpoint." },
    { author: null, createdAt: "2026-09-02T11:30:00.000Z", body: "Bot note." },
  ],
};

test("formatTicket leads with the identifier and title, then the metadata lines", () => {
  const out = formatTicket(ticket);
  assert.match(out, /^# ENG-42: Add widget\n/);
  assert.match(out, /^URL: https:\/\/linear.app\/x\/issue\/ENG-42$/m);
  assert.match(out, /^State: In Progress$/m);
  assert.match(out, /^Estimate: 3$/m);
  assert.match(out, /^Labels: backend, api$/m);
  assert.match(out, /^Parent: ENG-40$/m);
  assert.match(out, /^Assignee: Yimin$/m);
});

test("formatTicket prints the description verbatim under its own heading", () => {
  const out = formatTicket(ticket);
  assert.match(out, /## Description\n\nBuild the widget\.\n\n- \[ \] AC one\n/);
});

test("formatTicket lists comments oldest first with author and date", () => {
  const out = formatTicket(ticket);
  const ada = out.indexOf("### Ada (2026-09-01)");
  const bot = out.indexOf("### unknown (2026-09-02)");
  assert.ok(ada > 0 && bot > ada);
  assert.match(out, /### Ada \(2026-09-01\)\n\nUse the v2 endpoint\.\n/);
});

test("formatTicket says so when there is no description, no comments, no estimate", () => {
  const out = formatTicket({ ...ticket, description: "", comments: [], estimate: null, labels: [], parent: null, assignee: null });
  assert.match(out, /^Estimate: none$/m);
  assert.match(out, /^Labels: none$/m);
  assert.doesNotMatch(out, /^Parent:/m);
  assert.match(out, /^Assignee: unassigned$/m);
  assert.match(out, /## Description\n\n\(none\)\n/);
  assert.match(out, /## Comments\n\n\(none\)\n/);
});
