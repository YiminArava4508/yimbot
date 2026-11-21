// reject-ticket.ts - reject a ticket whose planned size is far above its
// estimate: comment with the reason, add the reject label and move it back to Todo. Exit 0 when
// rejected, 3 when within tolerance (nothing written), 1 on bad usage.
import { readFileSync } from "node:fs";
import { addIssueLabel, createComment, fetchTicket, moveIssueToStateByName } from "../src/linear-api.ts";
import { parseRejectLabel, rejectTicket } from "../src/reject.ts";

const [ticket, plannedArg, reasonArg] = process.argv.slice(2);
const planned = Number(plannedArg);
if (!ticket || !reasonArg || !Number.isFinite(planned) || planned <= 0) {
  console.error('Usage: reject-ticket.ts <ticket> <planned-points> <reason | ->   ("-" reads the reason from stdin)');
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}
const reason = reasonArg === "-" ? readFileSync(0, "utf8") : reasonArg;
if (!reason.trim()) {
  console.error("reason is empty");
  process.exit(1);
}

const result = await rejectTicket(
  {
    fetchTicket: (id) => fetchTicket(apiKey, id),
    comment: (issueId, body) => createComment(apiKey, issueId, body),
    addLabel: (issueId, teamId, label) => addIssueLabel(apiKey, issueId, teamId, label),
    moveToTodo: async (identifier) => {
      await moveIssueToStateByName(apiKey, identifier, process.env.TODO_STATE_NAME?.trim() || "Todo");
    },
  },
  parseRejectLabel(process.env.REJECT_LABEL),
  ticket,
  planned,
  reason,
);
if (!result.rejected) {
  console.log(`${result.identifier} within tolerance, proceed`);
  process.exit(3);
}
console.log(`rejected ${result.identifier}`);
