// src/ticket-format.ts
// The text ~/get-ticket.sh prints for a session to read. Markdown, so the
// description's own checklists and code blocks survive untouched.
export type TicketComment = { author: string | null; createdAt: string; body: string };

export type Ticket = {
  identifier: string;
  title: string;
  url: string;
  state: string;
  estimate: number | null;
  labels: string[];
  parent: string | null;
  assignee: string | null;
  description: string;
  comments: TicketComment[];
};

function day(iso: string): string {
  return iso.slice(0, 10);
}

export function formatTicket(t: Ticket): string {
  const lines = [
    `# ${t.identifier}: ${t.title}`,
    "",
    `URL: ${t.url}`,
    `State: ${t.state}`,
    `Estimate: ${t.estimate ?? "none"}`,
    `Labels: ${t.labels.length > 0 ? t.labels.join(", ") : "none"}`,
  ];
  if (t.parent) lines.push(`Parent: ${t.parent}`);
  lines.push(`Assignee: ${t.assignee ?? "unassigned"}`, "", "## Description", "", t.description || "(none)", "", "## Comments", "");
  if (t.comments.length === 0) lines.push("(none)");
  for (const c of t.comments) {
    lines.push(`### ${c.author ?? "unknown"} (${day(c.createdAt)})`, "", c.body, "");
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}
