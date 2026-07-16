import { fetchTriggerIssues, resolveContext } from "../src/linear-api.ts";
import { buildSessionName } from "../src/watcher.ts";

const apiKey = process.env.LINEAR_API_KEY ?? "";
if (!apiKey) throw new Error("LINEAR_API_KEY is required (put it in .env)");
const teamName = process.env.LINEAR_TEAM_NAME ?? "Engineering";
const stateName = process.env.TRIGGER_STATE_NAME ?? "In Progress";

const ctx = await resolveContext(apiKey, teamName, stateName);
console.log(`team="${teamName}" state="${stateName}" viewer=${ctx.viewerId}`);

const issues = await fetchTriggerIssues(apiKey, ctx);
if (issues.length === 0) {
  console.log("no issues currently match the trigger filter");
} else {
  for (const i of issues) {
    console.log(`${i.identifier}  "${i.title}"  ->  session '${buildSessionName(i.identifier, i.title)}'`);
  }
}
