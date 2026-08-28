// src/review-diff.ts
// Pure parser for `gh pr diff` output (git unified diff format). No fs, no
// subprocess: raw text in, per-file structures out, so tests stay hermetic.

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";
export type DiffLine = { kind: DiffLineKind; text: string };
export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export type FileDiff = {
  path: string;
  oldPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  lines: DiffLine[];
};

const DIFF_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  // Header lines and hunk-body lines share prefixes ("---" vs "-"), so the
  // classifier tracks whether it is inside a hunk: before the first @@ of a
  // file everything is metadata, after it every line is content.
  let inHunk = false;
  const rawLines = text.split("\n");
  // split leaves one trailing "" after the final newline; drop only that.
  if (rawLines.at(-1) === "") rawLines.pop();
  for (const line of rawLines) {
    const m = DIFF_HEADER.exec(line);
    if (m) {
      cur = { path: m[2], oldPath: m[1], status: "modified", additions: 0, deletions: 0, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      cur.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ") || line.startsWith("rename to ")) cur.status = "renamed";
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.status = "binary";
      cur.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      cur.additions++;
      cur.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      cur.deletions++;
      cur.lines.push({ kind: "del", text: line });
    } else {
      cur.lines.push({ kind: "ctx", text: line });
    }
  }
  return files;
}
