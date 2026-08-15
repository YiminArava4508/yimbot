// estimate-ticket.ts - set a Linear ticket's estimate. Refine sessions use it
// to size right-sized tickets in place (the estimate is the refined latch).
import { fetchIssueByIdentifier, setIssueEstimate } from "../src/linear-api.ts";

const [ticket, pointsArg] = process.argv.slice(2);
const points = Number(pointsArg);
if (!ticket || !pointsArg || !Number.isFinite(points) || points < 0) {
  console.error("Usage: estimate-ticket.ts <ticket> <points>");
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}

const issue = await fetchIssueByIdentifier(apiKey, ticket);
await setIssueEstimate(apiKey, issue.id, points);
console.log(`${issue.identifier} estimate set to ${points}`);
