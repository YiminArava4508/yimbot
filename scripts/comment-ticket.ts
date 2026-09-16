// comment-ticket.ts - post a comment on a Linear ticket. The body is the last
// argument, or stdin when it is "-" (so a long markdown body can be piped in
// without shell quoting). With --upsert <marker>, a comment already carrying
// the marker is edited in place instead of a second one being created.
import { readFileSync } from "node:fs";
import { parseCommentArgs } from "../src/comment-args.ts";
import { createComment, fetchIssueByIdentifier, upsertMarkedComment } from "../src/linear-api.ts";

const args = parseCommentArgs(process.argv.slice(2));
if (!args) {
  console.error('Usage: comment-ticket.ts [--upsert <marker>] <ticket> <body | ->   ("-" reads the body from stdin)');
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}
const body = args.bodyArg === "-" ? readFileSync(0, "utf8") : args.bodyArg;
if (!body.trim()) {
  console.error("comment body is empty");
  process.exit(1);
}

const issue = await fetchIssueByIdentifier(apiKey, args.ticket);
if (args.marker) {
  const withMarker = body.includes(args.marker) ? body : `${args.marker}\n${body}`;
  await upsertMarkedComment(apiKey, issue.id, args.marker, withMarker);
  console.log(`upserted marked comment on ${issue.identifier}`);
} else {
  await createComment(apiKey, issue.id, body);
  console.log(`commented on ${issue.identifier}`);
}
