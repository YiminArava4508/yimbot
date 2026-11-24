export type SelfImproveJob = {
  id: string;
  skill: string;
  settingKey: string;
  cadence: "daily" | "weekly";
  hour: number;
  label: string;
};

export const SELF_IMPROVE_JOBS: SelfImproveJob[] = [
  {
    id: "dead-code-scan",
    skill: "dead-code-scan",
    settingKey: "AUTO_SELF_IMPROVE_DEAD_CODE_SCAN",
    cadence: "daily",
    hour: 0,
    label: "dead code scan",
  },
];
