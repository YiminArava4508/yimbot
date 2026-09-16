// move-ticket.ts - move a Linear ticket into a workflow state by name.
import { moveIssueToStateByName } from "../src/linear-api.ts";

const [ticket, stateName] = process.argv.slice(2);
if (!ticket || !stateName) {
  console.error('Usage: move-ticket.ts <ticket> "<state name>"');
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}

const moved = await moveIssueToStateByName(apiKey, ticket, stateName);
console.log(`${ticket.toUpperCase()} moved to ${moved}`);
