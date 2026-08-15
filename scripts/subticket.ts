// subticket.ts - CLI for the split flow: create a Linear sub-issue under a
// parent ticket, zero the parent's estimate (unless --no-zero-parent), and
// print the subticket identifier and slice branch name (one per line).
import { createSliceSubticket } from "../src/subticket.ts";

const args = process.argv.slice(2);
const claimable = args.includes("--claimable");
const zeroParent = !args.includes("--no-zero-parent");
const flags = new Set(["--claimable", "--no-zero-parent"]);
const positional = args.filter((a) => !flags.has(a));
const [parent, title, pointsArg] = positional;
if (!parent || !title) {
  console.error("Usage: subticket.ts <parent-ticket> <title> [points] [--claimable] [--no-zero-parent]");
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

const result = await createSliceSubticket(apiKey, parent, title, {
  points,
  claimable,
  zeroParent,
  todoStateName: process.env.TODO_STATE_NAME?.trim() || undefined,
});
console.log(result.identifier);
console.log(result.branch);
