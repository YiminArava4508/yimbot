// get-ticket.ts - print a Linear ticket (metadata, description, comments) as
// markdown. What a session reads at startup instead of the Linear MCP.
import { fetchTicket } from "../src/linear-api.ts";
import { formatTicket } from "../src/ticket-format.ts";

const [ticket] = process.argv.slice(2);
if (!ticket) {
  console.error("Usage: get-ticket.ts <ticket>");
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}

process.stdout.write(formatTicket(await fetchTicket(apiKey, ticket)));
