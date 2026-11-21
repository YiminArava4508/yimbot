import { fetchViewer } from "./linear-api.ts";
import {
  configToEnvRecord,
  extractPassthroughLines,
  serializeEnvFile,
  type YimbotConfig,
} from "./settings-model.ts";
import { errMsg } from "./setup-core.ts";

export type WizardStep = "prereqs" | "key" | "configure" | "confirm";

export const WIZARD_STEPS: WizardStep[] = ["prereqs", "key", "configure", "confirm"];

const STEP_TITLES: Record<WizardStep, string> = {
  prereqs: "Prerequisites",
  key: "Linear key",
  configure: "Configure",
  confirm: "Confirm",
};

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1] ?? null;
}

export function prevStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) - 1] ?? null;
}

export function stepHeader(step: WizardStep): string {
  return `Step ${WIZARD_STEPS.indexOf(step) + 1} of ${WIZARD_STEPS.length}: ${STEP_TITLES[step]}`;
}

function redact(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

export type KeyResult = { ok: true; apiKey: string; viewerName: string } | { ok: false; error: string };

export async function validateKey(
  raw: string,
  fetch: (k: string) => Promise<{ name: string }> = fetchViewer,
): Promise<KeyResult> {
  const apiKey = raw.trim();
  if (!apiKey) return { ok: false, error: "Required" };
  try {
    const viewer = await fetch(apiKey);
    return { ok: true, apiKey, viewerName: viewer.name };
  } catch (err) {
    return { ok: false, error: redact(errMsg(err), apiKey) };
  }
}

export type FinishEffects = {
  readEnv: () => string | null;
  writeEnv: (contents: string) => void;
  backupEnv: (contents: string) => void;
  installLinks: () => string[];
  setProcessEnv: (record: Record<string, string>) => void;
};

export type FinishResult = { ok: true; linkResults: string[] } | { ok: false; error: string };

// Same semantics as runSetup: keep the old .env as a backup, carry its
// passthrough lines over, and only touch process.env once the write landed.
export function finishWizard(config: YimbotConfig, fx: FinishEffects): FinishResult {
  try {
    const existing = fx.readEnv();
    if (existing !== null) fx.backupEnv(existing);
    fx.writeEnv(serializeEnvFile(config, existing === null ? [] : extractPassthroughLines(existing)));
  } catch (err) {
    return { ok: false, error: redact(errMsg(err), config.apiKey) };
  }
  fx.setProcessEnv(configToEnvRecord(config));
  let linkResults: string[];
  try {
    linkResults = fx.installLinks();
  } catch (err) {
    linkResults = [`[fail] links: ${redact(errMsg(err), config.apiKey)}`];
  }
  return { ok: true, linkResults };
}
