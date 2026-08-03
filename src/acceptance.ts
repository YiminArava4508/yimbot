export type AcStatus = "open" | "satisfied" | "skipped";

export type AC = {
  id: string;
  section: string;
  text: string;
  status: AcStatus;
  skipReason?: string;
};

const SECTIONS: [RegExp, string][] = [
  [/pdf/i, "pdf"],
  [/excel/i, "excel"],
  [/shared/i, "shared"],
];

function sectionForHeading(line: string): string | null {
  if (!/acceptance criteria/i.test(line)) return null;
  for (const [re, name] of SECTIONS) if (re.test(line)) return name;
  return null;
}

// Parse numbered acceptance-criteria items grouped under recognized headings.
// Ids are <section>-<ordinal within section>, stable as long as the heading set
// and item order in the description do not change.
export function parseAcceptanceCriteria(description: string): AC[] {
  const acs: AC[] = [];
  let section: string | null = null;
  const counters = new Map<string, number>();
  for (const raw of description.split("\n")) {
    const heading = sectionForHeading(raw);
    if (heading) {
      section = heading;
      continue;
    }
    if (!section) continue;
    const m = /^\s*\d+\.\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const n = (counters.get(section) ?? 0) + 1;
    counters.set(section, n);
    acs.push({ id: `${section}-${n}`, section, text: m[1].trim(), status: "open" });
  }
  return acs;
}
