// Roadmap 3a-i: seeded randomness for the city, so the same company always gets the same street.
// FNV-1a for string seeds, mulberry32 for the stream (bryc's PRNG notes,
// https://github.com/bryc/code/blob/master/jshash/PRNGs.md). No package needed.
// Pure: no React, no three. Only lazy chunks import this (PlanDebug, later the city), never the main bundle.

export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Its own stream per thing (e.g. rngFor(seed, "street", 3)), so adding one lot never reshuffles the next. */
export const rngFor = (seed: number, ...keys: (string | number)[]) => mulberry32(hashSeed(`${seed}|${keys.join("|")}`));

/** A whole number from lo to hi, both included. */
export const between = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** The city's seed: ?seed= for this visit, else the company name's hash. The one place this lives. */
export const citySeedFor = (companyName: string, override: number | null) => override ?? hashSeed(companyName.trim() || "Office");

export const pick =<T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];
