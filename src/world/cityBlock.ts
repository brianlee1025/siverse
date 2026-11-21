// Roadmap 3a-i: the street block around the office, as plain data (no React, no three, nothing drawn in 3D yet).
// Only lazy chunks import this (PlanDebug today, the city later), so the main bundle doesn't grow.
//
// Everything is measured from the office's front-right corner, so a hire (a bigger office) moves the block with
// the building. The office is a corner lot: the street runs along its front (+z), the avenue along its right (+x).
// Its left strip (Exterior's side sidewalk) is a service passage inside its own lot, so Exterior doesn't change.
//
// Sizes (sources): a Manhattan block is about 200 ft (60.96 m) deep, two rows of 100 ft (30.48 m) lots, and a
// standard lot is 25 ft (7.62 m) wide (Gotham Center, "Why Manhattan's blocks are the shape they are"; Museum of
// the City of New York, "The Greatest Grid"). Streets about 60 ft, avenues about 100 ft. BLOCK_LEN is a pick
// within the real 180-280 m that keeps the whole block inside the walk camera's far plane (150 m).

import { SIDEWALK, type OfficeLayout } from "../layout";
import { between, pick, rngFor } from "./rng";

export const LOT_W = 7.62;
export const LOT_D = 30.48;
export const BLOCK_D = 2 * LOT_D;
export const STREET_W = 18;
export const AVENUE_W = 30;
export const BLOCK_LEN = 180; // curb to curb along the street (see the note above)
const MIN_LOT_W = 4;
const MIN_LOT_D = 8;
const EPS = 0.01;

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type LotUse = "walkup" | "shop" | "office" | "tower";

export interface Lot {
  id: string; // "street-3": row and index, counted from the avenue corner
  row: "street" | "back";
  index: number;
  rect: Rect;
  use: LotUse;
  floors: number;
  tint: number; // 0-5, a facade colour picked later (3b)
}

export interface Slot {
  kind: "lamp" | "signal" | "hydrant" | "bin";
  x: number;
  z: number;
  rotY: number; // 0 faces the street (+z), PI/2 the avenue (+x)
}

export interface Street {
  id: "street" | "avenue" | "back" | "far";
  name: string;
  rect: Rect;
}

export interface CityBlock {
  seed: number;
  block: Rect; // lot lines: the whole block inside its sidewalks
  office: Rect; // the office's own lot
  lots: Lot[]; // the neighbours
  sidewalks: Rect[]; // front, back, avenue, far avenue
  streets: Street[];
  slots: Slot[]; // street furniture on the office's own frontage (drawn in 3c-i)
  keepClear: { name: string; rect?: Rect; circle?: { x: number; z: number; r: number } }[];
  skipped: string[]; // things the generator left out on purpose (grey in ?plan): not errors
  names: { street: string; avenue: string };
}

const AVENUES = ["1st Ave", "2nd Ave", "3rd Ave", "Park Ave", "Madison Ave", "5th Ave", "6th Ave", "7th Ave", "8th Ave"] as const;

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0, x1, z0, z1 });
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Splits [from, to] (from > to, counted from the avenue end) into lots LOT_W wide; the last takes the rest. */
function frontage(from: number, to: number): [number, number][] | null {
  const span = from - to;
  if (span < MIN_LOT_W) return null;
  const n = Math.max(1, Math.floor(span / LOT_W));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = from - i * LOT_W;
    const b = i === n - 1 ? to : a - LOT_W;
    out.push([a, b]);
  }
  return out;
}

/** The office's corner: lot lines on the brick faces, curbs from Exterior's own sums (Exterior.tsx curbs), so
 * data = drawing. The one place these four formulas live. */
export function corner(layout: OfficeLayout) {
  const b = layout.bounds;
  return { x1: b.maxX + 0.22, z1: b.maxZ + 0.22, avenueCurb: b.maxX + SIDEWALK, streetCurb: b.maxZ + 0.2 + SIDEWALK };
}

/** Roadmap 3c-i-a: the office's own sidewalk furniture and the zones it must keep clear. Seed-free: colliders
 * and StreetFurniture need it without the company name. */
export function frontageSlots(layout: OfficeLayout): { slots: Slot[]; keepClear: CityBlock["keepClear"]; skipped: string[] } {
  const b = layout.bounds;
  const door = layout.door[0];
  const { x1, z1, avenueCurb, streetCurb } = corner(layout);
  const skipped: string[] = [];

  // Keep-clear zones on the office's frontage: the door lane, the canopy, where temps arrive, and the corner.
  const canopyX = Math.min(door, b.maxX + 0.22 - 1.2); // Exterior's canopyX
  const keepClear: CityBlock["keepClear"] = [
    { name: "door lane", rect: rect(door - 1.5, door + 1.5, z1, streetCurb) },
    { name: "canopy", rect: rect(canopyX - 1.2, canopyX + 1.2, z1, z1 + 1.4) },
    { name: "arrivals", circle: { x: door, z: b.maxZ + 3, r: 1 } }, // layout.ts pathToSeat's street point
    { name: "corner", circle: { x: avenueCurb, z: streetCurb, r: 3 } },
  ];

  const wanted: Slot[] = [
    { kind: "lamp", x: x1 - 7.5, z: streetCurb - 0.6, rotY: 0 },
    { kind: "lamp", x: x1 - 27.5, z: streetCurb - 0.6, rotY: 0 },
    { kind: "lamp", x: avenueCurb - 0.6, z: z1 - 2, rotY: Math.PI / 2 },
    { kind: "lamp", x: avenueCurb - 0.6, z: z1 - 14, rotY: Math.PI / 2 },
    { kind: "signal", x: avenueCurb - 0.5, z: streetCurb - 0.5, rotY: 0 },
    { kind: "hydrant", x: avenueCurb - 3.5, z: streetCurb - 0.6, rotY: 0 },
    { kind: "bin", x: x1 - 18, z: streetCurb - 0.6, rotY: 0 },
  ];
  const slots: Slot[] = [];
  for (const s of wanted) {
    const hit = blockedBy(s, keepClear);
    if (hit) skipped.push(`${s.kind} at (${r2(s.x)}, ${r2(s.z)}): in the ${hit}`);
    else slots.push(s);
  }
  return { slots, keepClear, skipped };
}

/** The corner's two street names for a seed (round 13: the plates and the walk chip use them without building
 * the whole block). Its own rng stream, so nothing else shifts. */
export function streetNames(seed: number): CityBlock["names"] {
  const nr = rngFor(seed, "names");
  return { street: `W ${ordinal(between(nr, 14, 59))} St`, avenue: pick(nr, AVENUES) };
}

export function buildCityBlock(layout: OfficeLayout, seed: number): CityBlock {
  const b = layout.bounds;
  const skipped: string[] = [];

  const { x1, z1, avenueCurb, streetCurb } = corner(layout);
  const x0 = x1 - (BLOCK_LEN - 2 * SIDEWALK);
  const z0 = z1 - BLOCK_D;
  const farCurb = x0 - SIDEWALK;
  const backCurb = z0 - SIDEWALK;

  // The office lot: from its left passage's outer edge to the corner, at least one lot deep.
  const officeDepth = Math.max(LOT_D, b.maxZ - b.minZ + 0.44 + 2);
  const office = rect(b.minX - SIDEWALK, x1, z1 - officeDepth, z1);
  if (officeDepth > BLOCK_D - MIN_LOT_D) skipped.push("office deeper than the block: no back row behind it");

  const lots: Lot[] = [];
  const looks = (row: Lot["row"], index: number, corner: boolean): Pick<Lot, "use" | "floors" | "tint"> => {
    const r = rngFor(seed, row, index);
    const big = corner;
    const floors = big ? between(r, 8, 16) : between(r, 4, 6);
    const use: LotUse = big ? (r() < 0.5 ? "tower" : "office") : r() < 0.3 ? "shop" : "walkup";
    return { use, floors, tint: between(r, 0, 5) };
  };

  // Street row: from the office lot's left edge to the far avenue, front half of the block.
  const streetRow = frontage(office.x0, x0);
  if (!streetRow) skipped.push("street row: no room beside the office");
  else
    streetRow.forEach(([a, c], i) => {
      lots.push({ id: `street-${i}`, row: "street", index: i, rect: rect(c, a, z1 - LOT_D, z1), ...looks("street", i, i === streetRow.length - 1) });
    });

  // Back row: the whole length, behind the street row. Lots behind a deep office end at its rear.
  const backRow = frontage(x1, x0);
  if (!backRow) skipped.push("back row: block too short");
  else
    backRow.forEach(([a, c], i) => {
      const behindOffice = c < office.x1 - EPS && a > office.x0 + EPS;
      const front = behindOffice ? Math.min(z1 - LOT_D, office.z0) : z1 - LOT_D;
      if (front - z0 < MIN_LOT_D) {
        skipped.push(`lot back-${i}: under ${MIN_LOT_D} m deep behind the office`);
        return;
      }
      lots.push({ id: `back-${i}`, row: "back", index: i, rect: rect(c, a, z0, front), ...looks("back", i, i === 0 || i === backRow.length - 1) });
    });

  const sidewalks = [
    rect(farCurb, avenueCurb, z1, streetCurb), // front (takes the corners)
    rect(farCurb, avenueCurb, backCurb, z0), // back (takes the corners)
    rect(x1, avenueCurb, z0, z1), // avenue
    rect(farCurb, x0, z0, z1), // far avenue
  ];

  const names = streetNames(seed);
  const xFar = farCurb - AVENUE_W;
  const xNear = avenueCurb + AVENUE_W;
  const zFar = backCurb - STREET_W;
  const zNear = streetCurb + STREET_W;
  const streets: Street[] = [
    { id: "street", name: names.street, rect: rect(xFar, xNear, streetCurb, zNear) },
    { id: "avenue", name: names.avenue, rect: rect(avenueCurb, xNear, zFar, zNear) },
    { id: "back", name: "", rect: rect(xFar, xNear, zFar, backCurb) },
    { id: "far", name: "", rect: rect(xFar, farCurb, zFar, zNear) },
  ];

  // The office's own frontage (seed-free, shared with StreetFurniture and the colliders).
  const frontageData = frontageSlots(layout);
  const { slots, keepClear } = frontageData;
  skipped.push(...frontageData.skipped);

  return { seed, block: rect(x0, x1, z0, z1), office, lots, sidewalks, streets, slots, keepClear, skipped, names };
}

function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 - EPS && x <= r.x1 + EPS && z >= r.z0 - EPS && z <= r.z1 + EPS;
}

/** The keep-clear zone a slot sits in, if any. A signal belongs on the corner, so the corner doesn't count for it. */
function blockedBy(s: Slot, zones: CityBlock["keepClear"]): string | null {
  for (const k of zones) {
    if (s.kind === "signal" && k.name === "corner") continue;
    if (k.rect && inRect(k.rect, s.x, s.z)) return k.name;
    if (k.circle && Math.hypot(s.x - k.circle.x, s.z - k.circle.z) < k.circle.r) return k.name;
  }
  return null;
}

function overlaps(a: Rect, b: Rect): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > EPS;
}

/** Real errors in a block (red in ?plan). Skipped things aren't errors. An empty list = a good block. */
export function checkBlock(block: CityBlock): string[] {
  const problems: string[] = [];
  const { lots, office } = block;
  for (let i = 0; i < lots.length; i++)
    for (let j = i + 1; j < lots.length; j++)
      if (overlaps(lots[i].rect, lots[j].rect)) problems.push(`lot ${lots[i].id} overlaps ${lots[j].id}`);
  for (const lot of lots) {
    if (overlaps(lot.rect, office)) problems.push(`lot ${lot.id} overlaps the office lot`);
    for (const s of block.sidewalks) if (overlaps(lot.rect, s)) problems.push(`lot ${lot.id} overlaps a sidewalk`);
    for (const st of block.streets) if (overlaps(lot.rect, st.rect)) problems.push(`lot ${lot.id} overlaps the ${st.id} street`);
    const w = lot.rect.x1 - lot.rect.x0;
    const d = lot.rect.z1 - lot.rect.z0;
    if (w < MIN_LOT_W - EPS) problems.push(`lot ${lot.id} is ${r2(w)} m wide`);
    if (d < MIN_LOT_D - EPS) problems.push(`lot ${lot.id} is ${r2(d)} m deep`);
  }
  // Frontage: each row fills the block's length (the street row together with the office lot). A row that
  // dropped a lot on purpose (listed in skipped) only has to fit.
  const length = block.block.x1 - block.block.x0;
  for (const row of ["street", "back"] as const) {
    const sum = lots.filter((l) => l.row === row).reduce((n, l) => n + l.rect.x1 - l.rect.x0, 0) + (row === "street" ? office.x1 - office.x0 : 0);
    const dropped = block.skipped.some((s) => s.startsWith(row === "street" ? "street row" : "lot back-") || (row === "back" && s.startsWith("back row")));
    if (dropped ? sum > length + EPS : Math.abs(sum - length) > EPS) problems.push(`${row} row frontage ${r2(sum)} m, block ${r2(length)} m`);
  }
  for (const s of block.slots) {
    if (!block.sidewalks.some((w) => inRect(w, s.x, s.z))) problems.push(`${s.kind} at (${r2(s.x)}, ${r2(s.z)}) is off the sidewalk`);
    const hit = blockedBy(s, block.keepClear);
    if (hit) problems.push(`${s.kind} at (${r2(s.x)}, ${r2(s.z)}) is in the ${hit}`);
    // Round 12 (R12-M23): nothing within 0.5 m of the office's brick faces (its lot lines at x1 and z1).
    const o = office;
    if (s.x > o.x0 - 0.5 && s.x < o.x1 + 0.5 && s.z > o.z0 - 0.5 && s.z < o.z1 + 0.5)
      problems.push(`${s.kind} at (${r2(s.x)}, ${r2(s.z)}) is within 0.5 m of the office`);
  }
  return problems;
}
