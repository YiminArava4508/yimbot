// subticket.ts - CLI for the split flow: create a Linear sub-issue under a
// parent ticket, zero the parent's estimate, and print the subticket
// identifier and slice branch name (one per line).
import { createSliceSubticket } from "../src/subticket.ts";

const [parent, title, pointsArg] = process.argv.slice(2);
if (!parent || !title) {
  console.error("Usage: subticket.ts <parent-ticket> <title> [points]");
  process.exit(1);
}
const points = pointsArg == null ? undefined : Number(pointsArg);
if (points != null && !Number.isFinite(points)) {
  console.error(`Invalid points value: ${pointsArg}`);
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}

const result = await createSliceSubticket(apiKey, parent, title, points);
console.log(result.identifier);
console.log(result.branch);
