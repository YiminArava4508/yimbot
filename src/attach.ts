import { unlinkSync } from "node:fs";

// Screenshots must live only on Linear: the local file goes away whether or not
// the upload landed, and an already-missing file is not an error.
export async function uploadAndUnlink(
  path: string,
  upload: (p: string) => Promise<string>,
  unlink: (p: string) => void = unlinkSync,
): Promise<string> {
  try {
    return await upload(path);
  } finally {
    try {
      unlink(path);
    } catch {
      /* already gone */
    }
  }
}
