// comment-ticket.ts - post a comment on a Linear ticket. The body is the second
// argument, or stdin when the argument is "-" (so a long markdown body can be
// piped in without shell quoting).
import { readFileSync } from "node:fs";
import { createComment, fetchIssueByIdentifier } from "../src/linear-api.ts";

const [ticket, bodyArg] = process.argv.slice(2);
if (!ticket || !bodyArg) {
  console.error('Usage: comment-ticket.ts <ticket> <body | ->   ("-" reads the body from stdin)');
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}
const body = bodyArg === "-" ? readFileSync(0, "utf8") : bodyArg;
if (!body.trim()) {
  console.error("comment body is empty");
  process.exit(1);
}

const issue = await fetchIssueByIdentifier(apiKey, ticket);
await createComment(apiKey, issue.id, body);
console.log(`commented on ${issue.identifier}`);
