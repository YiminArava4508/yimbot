// relate-tickets.ts - record "<blocker> blocks <blocked>" as a Linear relation,
// so refine-time subtickets are claimed in dependency order.
import { createBlocksRelation, fetchIssueByIdentifier } from "../src/linear-api.ts";

const [blocker, blocked] = process.argv.slice(2);
if (!blocker || !blocked) {
  console.error("Usage: relate-tickets.ts <blocker-ticket> <blocked-ticket>");
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}

const [b1, b2] = await Promise.all([
  fetchIssueByIdentifier(apiKey, blocker),
  fetchIssueByIdentifier(apiKey, blocked),
]);
await createBlocksRelation(apiKey, b1.id, b2.id);
console.log(`${b1.identifier} blocks ${b2.identifier}`);
