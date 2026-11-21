// Roadmap 3c-i-b: the corner's traffic signal as a pure clock. No React, no three.
// Only lazy chunks import this (StreetFurniture, PlanDebug; 5a traffic later), never the main bundle.
// One 90 s cycle, inside NYC DOT's usual 45-120 s (nyc.gov/html/dot/html/infrastructure/signals.shtml).
// Date.now() drives it, so every browser shows the same light (within its clock skew).

export type Lamp = "green" | "yellow" | "red";
export const CYCLE_MS = 90_000;

// [end of phase in s, avenue, street]. The avenue gets the longer green (wider road), and every hand-over
// passes through an all-red clearance (55-57 s, 88-90 s).
const PHASES: [number, Lamp, Lamp][] = [
  [52, "green", "red"],
  [55, "yellow", "red"],
  [57, "red", "red"],
  [85, "red", "green"],
  [88, "red", "yellow"],
  [90, "red", "red"],
];

export function signalAt(ms: number): { avenue: Lamp; street: Lamp; changesIn: number } {
  const t = (((ms % CYCLE_MS) + CYCLE_MS) % CYCLE_MS) / 1000; // safe for negative ms
  const p = PHASES.find(([end]) => t < end) ?? PHASES[PHASES.length - 1];
  return { avenue: p[1], street: p[2], changesIn: Math.max(0, (p[0] - t) * 1000) };
}
