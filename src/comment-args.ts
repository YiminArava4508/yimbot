export type CommentArgs = { ticket: string; bodyArg: string; marker: string | null };

export function parseCommentArgs(argv: string[]): CommentArgs | null {
  let marker: string | null = null;
  let rest = argv;
  if (rest[0] === "--upsert") {
    if (rest.length !== 4) return null;
    marker = rest[1];
    rest = rest.slice(2);
  }
  if (rest.length !== 2) return null;
  return { ticket: rest[0], bodyArg: rest[1], marker };
}
