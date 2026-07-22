// `pnpm onboard` — run the onboarding wizard on demand (fresh setup or reconfigure).
// Named `onboard`, not `setup`, because `pnpm setup` is a reserved pnpm builtin.
// Loaded with --env-file-if-exists so an existing .env supplies the defaults.
import { runSetup } from "../src/setup.ts";

await runSetup();
process.exit(0);
