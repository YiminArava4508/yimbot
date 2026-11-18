// backfill-after-release.ts - for every active-cycle ticket titled
// "Remove `<flag>` flag (code, then prod)" whose PR merged and that has no
// after-release child, create the archive subticket with --after-release.
// Dry run by default; pass --apply to write.
import { archiveDescription, planBackfill } from "../src/backfill-after-release.ts";
import { codebasePath, envOr } from "../src/env.ts";
import { ghRunner, listMyMergedPRs } from "../src/gh.ts";
import { mergedIdentifierSet } from "../src/blocked.ts";
import { parseAfterReleaseLabel } from "../src/labels.ts";
import { fetchCycleParents, resolveContext } from "../src/linear-api.ts";
import { parseExtraRepos } from "../src/multi-repo.ts";
import { createSliceSubticket } from "../src/subticket.ts";

const apply = process.argv.includes("--apply");
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) throw new Error("LINEAR_API_KEY is required (put it in .env)");
const afterReleaseLabel = parseAfterReleaseLabel(process.env.AFTER_RELEASE_LABEL);
const todoStateName = envOr("TODO_STATE_NAME", "Todo");

const ctx = await resolveContext(apiKey, envOr("LINEAR_TEAM_NAME", "Engineering"), todoStateName);
const cwd = codebasePath();
const runners = [ghRunner(cwd), ...parseExtraRepos(envOr("EXTRA_REPOS", "")).map((r) => ghRunner(cwd, r))];
const mergedPRs = (await Promise.all(runners.map((run) => listMyMergedPRs(run)))).flat();

const plan = planBackfill(
  await fetchCycleParents(apiKey, ctx.teamId),
  mergedIdentifierSet(mergedPRs),
  afterReleaseLabel,
);
if (plan.length === 0) console.log("nothing to backfill");
for (const item of plan) {
  console.log(`${apply ? "creating" : "would create"} under ${item.parent}: ${item.title}`);
  if (!apply) continue;
  const result = await createSliceSubticket(apiKey, item.parent, item.title, {
    points: 1,
    afterRelease: true,
    afterReleaseLabel,
    todoStateName,
    description: archiveDescription(item.parent, item.flag),
  });
  console.log(`  ${result.identifier}`);
}
if (!apply && plan.length > 0) console.log("dry run: pass --apply to create these");
