import { envOr } from "../src/env.ts";
import { fetchIssuesInState, resolveContext } from "../src/linear-api.ts";
import { buildSessionName } from "../src/watcher.ts";

const apiKey = process.env.LINEAR_API_KEY?.trim() ?? "";
if (!apiKey) throw new Error("LINEAR_API_KEY is required (put it in .env)");
const teamName = envOr("LINEAR_TEAM_NAME", "Engineering");
const stateName = envOr("DEPLOY_STATE_NAME", envOr("TRIGGER_STATE_NAME", "In Progress"));

const ctx = await resolveContext(apiKey, teamName, stateName);
console.log(`team="${teamName}" state="${stateName}" viewer=${ctx.viewerId}`);

const issues = await fetchIssuesInState(apiKey, ctx);
if (issues.length === 0) {
  console.log("no issues currently match the deploy filter");
} else {
  for (const i of issues) {
    console.log(`${i.identifier}  "${i.title}"  ->  session '${buildSessionName(i.identifier, i.title)}'`);
  }
}
