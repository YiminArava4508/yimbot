// attach-ticket.ts - upload one local file to Linear and print its asset url.
// The file is deleted afterwards, success or not, so screenshots never linger.
import { uploadAndUnlink } from "../src/attach.ts";
import { uploadFile } from "../src/linear-api.ts";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("Usage: attach-ticket.ts <file>");
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("LINEAR_API_KEY is not set");
  process.exit(1);
}
console.log(await uploadAndUnlink(file, (p) => uploadFile(apiKey, p)));
