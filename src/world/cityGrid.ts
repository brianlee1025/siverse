// City round (2026-11-21): the Manhattan-style grid round the office, as plain data. No React, no three.
// Only lazy chunks import this (City, WalkControls), so the main bundle doesn't grow.
//
// The office's own block comes from cityBlock.ts (its lots, its corner, its curbs), and every other block is the
// same block moved by one "pitch": a block plus an avenue along x, a block plus a street along z. So the office
// block sits in the middle of a 3 × 3 walkable grid, with an outer ring of 16 blocks that are only drawn (the
// street wall you see at the end of each street) and a skyline of cheap far boxes past that.
//
// Axes as before: streets run along x (the office's street is in front, +z), avenues along z (the office's
// avenue is to its right, +x). North is −z, so street numbers go up behind the office; avenues are counted
// east (+x) to west (−x) as in Manhattan (York, 1st, 2nd … 11th).
//
// Sources: block, lot, street and avenue sizes as in cityBlock.ts (Gotham Center; MCNY "The Greatest Grid");
// setback towers after the 1916 Zoning Resolution (Skyscraper Museum); high-visibility crosswalks, bus lanes
// and parking lanes after NYC DOT's Street Design Manual (3rd ed., 2020). Every number below is a pick within
// those, not a copy of a real building.

import { SIDEWALK, STREET_Y, type OfficeLayout } from "../layout";
import { AVENUE_W, BLOCK_D, BLOCK_LEN, buildCityBlock, corner, LOT_D, LOT_W, ordinal, STREET_W, streetNames, type Lot, type Rect, type Slot } from "./cityBlock";
import type { Box } from "./colliders";
import type { Lamp } from "./signals";
import { between, rngFor } from "./rng";

/** Facade styles, read by City's shader (aCity.x). 2–6 get windows; 2 and up are cut away in the outside view. */
export const STYLE = { plain: 0, pave: 1, brick: 2, stone: 3, glass: 4, ribbon: 5, deco: 6, roof: 7 } as const;
export type Style = keyof typeof STYLE;

/** An axis-aligned box standing on y (its bottom). */
export interface Solid {
  x: number;
  y: number;
  z: number;
  w: number; // along x
  h: number;
  d: number; // along z
  color: string;
  style: Style;
  floorH?: number;
  bay?: number;
  seed?: number; // 0–1, varies which windows are lit
}
export type GlowKind = "head" | "lens" | "globe" | "cab" | "beacon" | "crown";
export interface Glow {
  x: number;
  y: number; // centre
  z: number;
  w: number;
  h: number;
  d: number;
  kind: GlowKind;
  lens?: { at: number; road: "street" | "avenue"; lamp: Lamp }; // `at`: index into intersections
}
export interface Cyl {
  x: number;
  y: number; // bottom
  z: number;
  r: number;
  h: number;
  color: string;
  cut: boolean; // water tanks are cut away with their building; trunks and hydrants aren't
}
export interface Crown {
  x: number;
  y: number; // centre
  z: number;
  r: number;
  color: string;
}
export interface Mark {
  x: number;
  z: number;
  w: number; // along x
  d: number; // along z
  color: string;
}
export interface Far {
  x: number;
  z: number;
  w: number;
  h: number;
  d: number;
  t: number; // 0 near … 1 far, for the haze colour
}

export interface CityGrid {
  seed: number;
  solids: Solid[];
  glows: Glow[];
  cyls: Cyl[];
  cones: Cyl[]; // water-tank roofs
  crowns: Crown[];
  marks: Mark[];
  far: Far[]; // the skyline past the drawn blocks
  intersections: { offset: number }[]; // signal clock offsets (ms) for the green wave
  lamps: Slot[]; // for the night light pools
  colliders: Box[];
  walk: Rect; // where the walker can go
  extent: Rect; // the drawn blocks, streets included
  centre: [number, number];
  names: { avenue: (a: number) => string; street: (s: number) => string };
  counts: { buildings: number; blocks: number; towers: number };
  groundAt: (x: number, z: number) => number;
  placeAt: (x: number, z: number) => string | null;
}

const WALK_R = 1; // blocks in each direction you can walk (3 × 3)
const RING_R = 2; // blocks drawn (5 × 5)
const SHOP = 4.2; // ground floor height (the shader's shopfront band)
const PAVE = "#cfc9bf"; // Exterior's CONCRETE
const CURB = "#b9b2a7";
const SLAB_TOP = 0.012; // Exterior's sidewalk joint plane
const CURB_TOP = 0.03;

// Manhattan's avenues east to west. cityBlock's own AVENUES list (it picks the office's avenue) has no Lexington
// or York; this one is only for the neighbours, found by the office avenue's name.
const AVENUE_ORDER = ["York Ave", "1st Ave", "2nd Ave", "3rd Ave", "Lexington Ave", "Park Ave", "Madison Ave", "5th Ave", "6th Ave", "7th Ave", "8th Ave", "9th Ave", "10th Ave", "11th Ave"];

const BRICKS = ["#9c4f3c", "#a8603f", "#8a4a3a", "#b06d4f", "#7f3f33", "#a35a48", "#8c5a46"];
const STONES = ["#cbbfa8", "#bfb39c", "#d6ccb8", "#b5a890", "#c9c2b5", "#a99f8d"];
const GLASSES = ["#4c6a80", "#3f5d6e", "#56707f", "#5d6b78", "#41566b", "#6b7f8c", "#4a5560"];
const MODERN = ["#d9d6cf", "#a9adb1", "#7d8287", "#e4e0d8", "#8f8a80"];
const CARS = ["#1f2326", "#e9e9e6", "#7a7f86", "#2d4a7a", "#8b2a2a", "#3b3f45", "#b8bcc0"];
const CAB = "#f2b705";
const TREES = ["#4f7a3a", "#5d8a42", "#46703a", "#6b8f4a"];

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0, x1, z0, z1 });
const shift = (r: Rect, dx: number, dz: number): Rect => rect(r.x0 + dx, r.x1 + dx, r.z0 + dz, r.z1 + dz);
const pick = <T,>(r: () => number, list: readonly T[]) => list[Math.floor(r() * list.length)];
const box = (x0: number, x1: number, z0: number, z1: number): Box => ({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 });
const around = (x: number, z: number, w: number, d = w): Box => box(x - w / 2, x + w / 2, z - d / 2, z + d / 2);

type Kind = "walkup" | "loft" | "ribbon" | "prewar" | "glass" | "deco";

/** One grid, cached per layout + seed: City and WalkControls ask for the same one. */
let cache: { layout: OfficeLayout; seed: number; grid: CityGrid } | null = null;
export function cityFor(layout: OfficeLayout, seed: number): CityGrid {
  if (cache?.layout === layout && cache.seed === seed) return cache.grid;
  const grid = buildCityGrid(layout, seed);
  cache = { layout, seed, grid };
  return grid;
}

export function buildCityGrid(layout: OfficeLayout, seed: number): CityGrid {
  const b = layout.bounds;
  const c = corner(layout);
  // The office block, as cityBlock builds it: lot lines L0 inside curbs C0.
  const L0 = rect(c.x1 - (BLOCK_LEN - 2 * SIDEWALK), c.x1, c.z1 - BLOCK_D, c.z1);
  const C0 = rect(L0.x0 - SIDEWALK, c.avenueCurb, L0.z0 - SIDEWALK, c.streetCurb);
  const blockW = C0.x1 - C0.x0;
  const blockD = C0.z1 - C0.z0;
  const PX = blockW + AVENUE_W;
  const PZ = blockD + STREET_W;
  const curbOf = (i: number, j: number) => shift(C0, i * PX, j * PZ);
  const lotOf = (i: number, j: number) => shift(L0, i * PX, j * PZ);
  // Avenue a runs between blocks a−1 and a; street s between rows s−1 and s. The office's are a = 1, s = 1.
  const avenueX = (a: number): [number, number] => [C0.x1 + (a - 1) * PX, C0.x0 + a * PX];
  const streetZ = (s: number): [number, number] => [C0.z1 + (s - 1) * PZ, C0.z0 + s * PZ];

  const solids: Solid[] = [];
  const glows: Glow[] = [];
  const cyls: Cyl[] = [];
  const cones: Cyl[] = [];
  const crowns: Crown[] = [];
  const marks: Mark[] = [];
  const lamps: Slot[] = [];
  const colliders: Box[] = [];
  let buildings = 0;
  let towers = 0;

  // ---- Names -------------------------------------------------------------------------------------------
  const office = streetNames(seed);
  const n = Number(/\d+/.exec(office.street)?.[0] ?? 40);
  const k = AVENUE_ORDER.indexOf(office.avenue);
  const names = {
    avenue: (a: number) => (a === 1 ? office.avenue : k < 0 ? "" : AVENUE_ORDER[k + (1 - a)] ?? ""),
    street: (s: number) => (s === 1 ? office.street : `W ${ordinal(n + (1 - s))} St`),
  };

  // ---- Ground: one slab per block (sidewalks + lots), minus what Exterior draws round the office ---------
  const slab = (r: Rect) => {
    if (r.x1 - r.x0 < 0.05 || r.z1 - r.z0 < 0.05) return;
    solids.push({ x: (r.x0 + r.x1) / 2, y: STREET_Y, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, h: SLAB_TOP - STREET_Y, d: r.z1 - r.z0, color: PAVE, style: "pave" });
  };
  const curb = (x0: number, x1: number, z0: number, z1: number) =>
    solids.push({ x: (x0 + x1) / 2, y: STREET_Y, z: (z0 + z1) / 2, w: x1 - x0, h: CURB_TOP - STREET_Y, d: z1 - z0, color: CURB, style: "plain" });
  // Exterior's own sidewalk + office rectangle (its curbs included): x from the left curb to the avenue curb,
  // z from the back wall's outer face to the street curb.
  const exX0 = b.minX - SIDEWALK;
  const exZ0 = b.minZ - 0.2;
  for (let i = -RING_R; i <= RING_R; i++)
    for (let j = -RING_R; j <= RING_R; j++) {
      const C = curbOf(i, j);
      if (i === 0 && j === 0) {
        slab(rect(C.x0, exX0, C.z0, C.z1)); // west of the office's left sidewalk
        slab(rect(exX0, C.x1, C.z0, exZ0)); // behind the office (its yard and the back row)
        curb(C.x0 - 0.1, exX0 - 0.1, C.z1 - 0.1, C.z1 + 0.1); // front, up to Exterior's own curb
        curb(C.x1 - 0.1, C.x1 + 0.1, C.z0, exZ0); // avenue, behind Exterior's
      } else {
        slab(C);
        curb(C.x0 - 0.1, C.x1 + 0.1, C.z1 - 0.1, C.z1 + 0.1);
        curb(C.x1 - 0.1, C.x1 + 0.1, C.z0, C.z1);
      }
      curb(C.x0 - 0.1, C.x1 + 0.1, C.z0 - 0.1, C.z0 + 0.1);
      curb(C.x0 - 0.1, C.x0 + 0.1, C.z0, C.z1);
    }

  // ---- Buildings ----------------------------------------------------------------------------------------
  const walkable = (i: number, j: number) => Math.abs(i) <= WALK_R && Math.abs(j) <= WALK_R;
  const addBuilding = (foot: Rect, kind: Kind, r: () => number, collide: boolean, floorsIn?: number) => {
    buildings++;
    const w = foot.x1 - foot.x0;
    const d = foot.z1 - foot.z0;
    const cx = (foot.x0 + foot.x1) / 2;
    const cz = (foot.z0 + foot.z1) / 2;
    const s = r();
    const part = (inset: number, y: number, h: number, color: string, style: Style, floorH: number, bay: number, dx = 0, dz = 0) => {
      const pw = Math.max(4, w - 2 * inset);
      const pd = Math.max(4, d - 2 * inset);
      solids.push({ x: cx + dx, y, z: cz + dz, w: pw, h, d: pd, color, style, floorH, bay, seed: s });
      return { pw, pd, top: y + h };
    };
    const roofBox = (y: number, pw: number, pd: number, frac: number, h: number, color = "#6f6c68") =>
      solids.push({ x: cx + (r() - 0.5) * pw * 0.3, y, z: cz + (r() - 0.5) * pd * 0.3, w: pw * frac, h, d: pd * frac, color, style: "roof" });
    const base = SLAB_TOP;
    if (collide) colliders.push(box(foot.x0, foot.x1, foot.z0, foot.z1));

    if (kind === "walkup") {
      const floors = floorsIn ?? between(r, 4, 7);
      const h = SHOP + (floors - 1) * 3.2 + 0.4;
      const color = pick(r, BRICKS);
      part(0, base, h, color, "brick", 3.2, 2.3);
      part(-0.15, base + h, 0.45, "#5e4d42", "roof", 0, 0); // cornice
      if (r() < 0.45 && w * d > 120) {
        const tr = 1.2 + r() * 0.5;
        const tx = cx + (r() - 0.5) * (w - 2 * tr - 1);
        const tz = cz + (r() - 0.5) * (d - 2 * tr - 1);
        const top = base + h + 0.45;
        for (const [lx, lz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]])
          solids.push({ x: tx + lx * tr, y: top, z: tz + lz * tr, w: 0.15, h: 1.8, d: 0.15, color: "#3b3631", style: "roof" });
        cyls.push({ x: tx, y: top + 1.8, z: tz, r: tr, h: 2.8, color: "#7a5a3c", cut: true });
        cones.push({ x: tx, y: top + 4.6, z: tz, r: tr + 0.1, h: 1.1, color: "#5b4636", cut: true });
      }
      return;
    }
    if (kind === "loft" || kind === "ribbon") {
      const floors = floorsIn ?? (kind === "loft" ? between(r, 8, 16) : between(r, 8, 22));
      const h = SHOP + (floors - 1) * 3.6;
      const color = kind === "loft" ? pick(r, STONES) : pick(r, MODERN);
      const style: Style = kind === "loft" ? "stone" : "ribbon";
      if (kind === "loft" && floors > 10) {
        const low = SHOP + Math.round(floors * 0.7) * 3.6;
        part(0, base, low, color, style, 3.6, 2.2);
        const up = part(Math.min(2, w / 6), base + low, h - low, color, style, 3.6, 2.2);
        roofBox(base + h, up.pw, up.pd, 0.35, 2.4);
      } else {
        const p = part(0, base, h, color, style, 3.6, kind === "loft" ? 2.2 : 3);
        roofBox(base + h, p.pw, p.pd, 0.4, 2.6);
      }
      return;
    }
    if (kind === "prewar") {
      const floors = floorsIn ?? between(r, 14, 24);
      const h = SHOP + (floors - 1) * 3.5;
      const color = r() < 0.6 ? pick(r, STONES) : pick(r, BRICKS);
      const style: Style = r() < 0.5 ? "stone" : "brick";
      const low = h * (0.6 + r() * 0.15);
      part(0, base, low, color, style, 3.5, 2.2);
      const up = part(Math.min(3, w / 5), base + low, h - low, color, style, 3.5, 2.2);
      part(Math.min(3, w / 5) - 0.2, base + h, 0.6, "#6d665c", "roof", 0, 0);
      roofBox(base + h + 0.6, up.pw, up.pd, 0.3, 3);
      return;
    }
    if (kind === "glass") {
      towers++;
      const floors = floorsIn ?? between(r, 25, 55);
      const podium = floorsIn ? 0 : between(r, 3, 6);
      const color = pick(r, GLASSES);
      let y = base;
      if (podium) {
        const ph = SHOP + (podium - 1) * 4;
        part(0, y, ph, r() < 0.5 ? pick(r, STONES) : "#3a4048", r() < 0.5 ? "stone" : "ribbon", 4, 3);
        y += ph;
      }
      const inset = podium ? Math.min(3, Math.max(0, (Math.min(w, d) - 14) / 2)) : 0;
      const th = (floors - podium) * 3.8;
      const t = part(inset, y, th, color, "glass", 3.8, 1.5);
      const crown = Math.min(t.pw, t.pd) * 0.6;
      solids.push({ x: cx, y: y + th, z: cz, w: crown, h: 5, d: crown, color: "#2f353c", style: "roof" });
      if (y + th > 120) glows.push({ x: cx, y: y + th + 5.3, z: cz, w: 0.5, h: 0.5, d: 0.5, kind: "beacon" });
      return;
    }
    // deco: a 1916-zoning "wedding cake", three or four tiers, each set back.
    towers++;
    const color = r() < 0.7 ? pick(r, STONES) : pick(r, BRICKS);
    const tiers = between(r, 3, 4);
    let y = base;
    let inset = 0;
    let h = between(r, 30, 48);
    let last = { pw: w, pd: d, top: y };
    for (let t = 0; t < tiers; t++) {
      last = part(inset, y, h, color, "deco", 3.6, 2);
      y += h;
      inset += Math.min(w, d) * (0.1 + r() * 0.06);
      h *= 0.75 + r() * 0.25;
      if (Math.min(w, d) - 2 * inset < 8) break;
    }
    solids.push({ x: cx, y, z: cz, w: last.pw * 0.4, h: 6, d: last.pd * 0.4, color: "#6d665c", style: "roof" });
    if (y > 120) glows.push({ x: cx, y: y + 6.3, z: cz, w: 0.5, h: 0.5, d: 0.5, kind: "beacon" });
  };

  /** One row of a block: pieces 1–4 lots wide from the east end, the ends being corner buildings. */
  const fillRow = (i: number, j: number, row: "front" | "back", x0: number, x1: number, zr: [number, number], eastCorner: boolean) => {
    const r = rngFor(seed, "grid", i, j, row);
    const collide = walkable(i, j); // the ring's faces stand on the walk boundary, which already holds you
    let x = x1;
    let first = true;
    while (x - x0 > 0.01) {
      const left = x - x0;
      let w = (first && eastCorner ? between(r, 3, 5) : between(r, 1, 4)) * LOT_W;
      if (left - w < 3 * LOT_W) w = left;
      const isCorner = (first && eastCorner) || w === left;
      first = false;
      let kind: Kind;
      const roll = r();
      if (isCorner) kind = roll < 0.4 ? "glass" : roll < 0.65 ? "deco" : roll < 0.85 ? "prewar" : "loft";
      else kind = roll < 0.45 ? "walkup" : roll < 0.7 ? "loft" : roll < 0.85 ? "ribbon" : roll < 0.93 ? "prewar" : "glass";
      if ((kind === "glass" || kind === "deco") && w < 22) kind = "ribbon";
      const depth = kind === "walkup" ? LOT_D * (0.6 + r() * 0.25) : LOT_D;
      const foot = row === "front" ? rect(x - w, x, zr[1] - depth, zr[1]) : rect(x - w, x, zr[0], zr[0] + depth);
      addBuilding(foot, kind, r, collide);
      x -= w;
    }
  };

  // The office block: its own lots from cityBlock (the same seed and per-lot streams as ?plan).
  const block = buildCityBlock(layout, seed);
  const lotKind = (lot: Lot): Kind => (lot.use === "tower" ? "glass" : lot.use === "office" ? "loft" : "walkup");
  for (const lot of block.lots) {
    const r = rngFor(seed, "lot-look", lot.id);
    const kind = lotKind(lot);
    const depth = kind === "walkup" ? (lot.rect.z1 - lot.rect.z0) * (0.65 + r() * 0.2) : lot.rect.z1 - lot.rect.z0;
    const foot = lot.row === "street" ? rect(lot.rect.x0, lot.rect.x1, lot.rect.z1 - depth, lot.rect.z1) : rect(lot.rect.x0, lot.rect.x1, lot.rect.z0, lot.rect.z0 + depth);
    addBuilding(foot, kind, r, true, kind === "glass" ? lot.floors * 2 : lot.floors);
  }

  // The landmark: one tall setback tower with a spire, on the corner behind the office (block 0, −1), the full
  // depth of its block. Original massing: five tiers, a lit crown, a mast.
  const LANDMARK_W = 46;
  {
    const L = lotOf(0, -1);
    const x0 = L.x1 - LANDMARK_W;
    const cx = (x0 + L.x1) / 2;
    const cz = (L.z0 + L.z1) / 2;
    const r = rngFor(seed, "landmark");
    const color = pick(r, ["#cfc6b4", "#bdb4a3", "#d8cfbf"]);
    colliders.push(box(x0, L.x1, L.z0, L.z1));
    buildings++;
    towers++;
    const tiers: [number, number, number][] = [
      [LANDMARK_W, BLOCK_D, 34],
      [38, 48, 62],
      [30, 34, 72],
      [22, 22, 48],
      [14, 14, 24],
    ];
    let y = SLAB_TOP;
    tiers.forEach(([w, d, h]) => {
      solids.push({ x: cx, y, z: cz, w, h, d, color, style: "deco", floorH: 3.6, bay: 1.8, seed: 0.37 });
      y += h;
    });
    // The crown: a lit band round the top tier's head (glows), a cap, then a mast with a red light.
    for (const [dx, dz, w, d] of [[0, 7.05, 14, 0.1], [0, -7.05, 14, 0.1], [7.05, 0, 0.1, 14], [-7.05, 0, 0.1, 14]])
      glows.push({ x: cx + dx, y: y - 3, z: cz + dz, w, h: 2, d, kind: "crown" });
    solids.push({ x: cx, y, z: cz, w: 9, h: 8, d: 9, color, style: "roof" });
    solids.push({ x: cx, y: y + 8, z: cz, w: 4, h: 10, d: 4, color: "#a9a49a", style: "roof" });
    solids.push({ x: cx, y: y + 18, z: cz, w: 1.1, h: 46, d: 1.1, color: "#8e8c88", style: "roof" });
    glows.push({ x: cx, y: y + 64.4, z: cz, w: 0.6, h: 0.6, d: 0.6, kind: "beacon" });
    // The rest of that block's two rows.
    const mid = L.z0 + LOT_D;
    fillRow(0, -1, "front", L.x0, x0, [mid, L.z1], false);
    fillRow(0, -1, "back", L.x0, x0, [L.z0, mid], false);
  }

  for (let i = -RING_R; i <= RING_R; i++)
    for (let j = -RING_R; j <= RING_R; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === -1)) continue;
      const L = lotOf(i, j);
      const mid = L.z0 + LOT_D;
      fillRow(i, j, "front", L.x0, L.x1, [mid, L.z1], true);
      fillRow(i, j, "back", L.x0, L.x1, [L.z0, mid], true);
    }

  // ---- Intersections and their signals ------------------------------------------------------------------
  // A green wave up the avenues: each street further north starts 6 s later, each avenue 11 s. The office's
  // corner (a = 1, s = 1) is offset 0, so its own signal (StreetFurniture) and the new ones agree.
  const intersections: { offset: number }[] = [];
  const crossing = new Map<string, number>();
  const crossingAt = (a: number, s: number) => {
    const key = `${a}|${s}`;
    let at = crossing.get(key);
    if (at === undefined) {
      at = intersections.length;
      intersections.push({ offset: ((a - 1) * 11 + (1 - s) * 6) * 1000 });
      crossing.set(key, at);
    }
    return at;
  };

  // ---- Sidewalk furniture on the walkable blocks --------------------------------------------------------
  const POLE = "#3d4147";
  const addLamp = (x: number, z: number, rotY: number) => {
    const ax = Math.round(Math.sin(rotY));
    const az = Math.round(Math.cos(rotY));
    solids.push({ x, y: SLAB_TOP, z, w: 0.14, h: 4.5, d: 0.14, color: POLE, style: "plain" });
    solids.push({ x: x + ax * 0.45, y: 4.41, z: z + az * 0.45, w: ax ? 0.9 : 0.08, h: 0.08, d: az ? 0.9 : 0.08, color: POLE, style: "plain" });
    glows.push({ x: x + ax * 0.85, y: 4.4, z: z + az * 0.85, w: ax ? 0.3 : 0.5, h: 0.15, d: az ? 0.3 : 0.5, kind: "head" });
    lamps.push({ kind: "lamp", x, z, rotY });
    colliders.push(around(x, z, 0.3));
  };
  const addSignal = (x: number, z: number, at: number) => {
    const col = "#2b2f33";
    solids.push({ x, y: SLAB_TOP, z, w: 0.16, h: 3.2, d: 0.16, color: col, style: "plain" });
    solids.push({ x, y: 2.45, z, w: 0.3, h: 0.9, d: 0.3, color: col, style: "plain" });
    for (const [nx, nz, road] of [[1, 0, "street"], [-1, 0, "street"], [0, 1, "avenue"], [0, -1, "avenue"]] as const)
      for (const [lamp, y] of [["red", 3.15], ["yellow", 2.9], ["green", 2.65]] as const)
        glows.push({ x: x + nx * 0.16, y, z: z + nz * 0.16, w: nx ? 0.02 : 0.16, h: 0.16, d: nz ? 0.02 : 0.16, kind: "lens", lens: { at, road, lamp } });
    colliders.push(around(x, z, 0.3));
  };
  const addTree = (x: number, z: number, r: () => number) => {
    solids.push({ x, y: SLAB_TOP - 0.006, z, w: 1.2, h: 0.012, d: 1.2, color: "#4a3f33", style: "plain" });
    cyls.push({ x, y: SLAB_TOP, z, r: 0.11, h: 2.8, color: "#5b4636", cut: false });
    crowns.push({ x, y: 3.9 + r() * 0.5, z, r: 1.5 + r() * 0.6, color: pick(r, TREES) });
    colliders.push(around(x, z, 0.4));
  };
  const addHydrant = (x: number, z: number) => {
    cyls.push({ x, y: SLAB_TOP, z, r: 0.16, h: 0.62, color: "#c92a2a", cut: false });
    colliders.push(around(x, z, 0.4));
  };
  const addBin = (x: number, z: number) => {
    solids.push({ x, y: SLAB_TOP, z, w: 0.55, h: 0.9, d: 0.55, color: "#2f4f3a", style: "plain" });
    colliders.push(around(x, z, 0.6));
  };
  /** A subway stair on an avenue sidewalk: a dark opening, green railings on three sides, two green globes. */
  const addSubway = (x: number, z: number, out: 1 | -1) => {
    const L = 3.8;
    const W = 1.7;
    const green = "#2e5a3c";
    solids.push({ x, y: SLAB_TOP - 0.004, z, w: W, h: 0.01, d: L, color: "#16181b", style: "plain" });
    solids.push({ x: x - W / 2, y: SLAB_TOP, z, w: 0.06, h: 1.0, d: L, color: green, style: "plain" });
    solids.push({ x: x + W / 2, y: SLAB_TOP, z, w: 0.06, h: 1.0, d: L, color: green, style: "plain" });
    solids.push({ x, y: SLAB_TOP, z: z - (out * L) / 2, w: W, h: 1.0, d: 0.06, color: green, style: "plain" });
    for (const sx of [-1, 1]) {
      cyls.push({ x: x + (sx * W) / 2, y: SLAB_TOP, z: z + (out * L) / 2, r: 0.05, h: 1.9, color: green, cut: false });
      glows.push({ x: x + (sx * W) / 2, y: 2.05, z: z + (out * L) / 2, w: 0.3, h: 0.3, d: 0.3, kind: "globe" });
    }
    colliders.push(around(x, z, W + 0.1, L + 0.1));
  };
  const addNewsstand = (x: number, z: number) => {
    solids.push({ x, y: SLAB_TOP, z, w: 3.2, h: 2.4, d: 1.6, color: "#3d5a4a", style: "plain" });
    solids.push({ x, y: 2.41, z, w: 3.6, h: 0.12, d: 2.1, color: "#2b2f33", style: "plain" });
    colliders.push(around(x, z, 3.3, 1.7));
  };
  const addCar = (x: number, z: number, alongX: boolean, r: () => number) => {
    const cab = r() < 0.35;
    const body = cab ? CAB : pick(r, CARS);
    const L = 4.5;
    const W = 1.8;
    const sz = (l: number, w: number) => (alongX ? { w: l, d: w } : { w, d: l });
    const back = (r() < 0.5 ? 1 : -1) * 0.3;
    solids.push({ x, y: STREET_Y, z, ...sz(L - 0.3, W - 0.1), h: 0.35, color: "#15171a", style: "plain" });
    solids.push({ x, y: STREET_Y + 0.3, z, ...sz(L, W), h: 0.6, color: body, style: "plain" });
    const cx = alongX ? x + back : x;
    const cz = alongX ? z : z + back;
    solids.push({ x: cx, y: STREET_Y + 0.9, z: cz, ...sz(2.4, W - 0.2), h: 0.52, color: "#22272e", style: "plain" });
    if (cab) glows.push({ x: cx, y: STREET_Y + 1.52, z: cz, ...(alongX ? { w: 0.25, d: 0.7 } : { w: 0.7, d: 0.25 }), h: 0.18, kind: "cab" });
    colliders.push(alongX ? around(x, z, L, W) : around(x, z, W, L));
  };

  const ex = { x0: exX0 - 1, z0: exZ0 - 1 }; // the office's own frontage: StreetFurniture has it
  for (let i = -WALK_R; i <= WALK_R; i++)
    for (let j = -WALK_R; j <= WALK_R; j++) {
      const C = curbOf(i, j);
      const isOffice = i === 0 && j === 0;
      // Signals on all four corners (the office's own corner already has one).
      const corners: [number, number, number, number][] = [
        [C.x1 - 0.5, C.z1 - 0.5, i + 1, j + 1],
        [C.x0 + 0.5, C.z1 - 0.5, i, j + 1],
        [C.x1 - 0.5, C.z0 + 0.5, i + 1, j],
        [C.x0 + 0.5, C.z0 + 0.5, i, j],
      ];
      corners.forEach(([x, z, a, s], ci) => {
        if (isOffice && ci === 0) return;
        addSignal(x, z, crossingAt(a, s));
      });
      // The four sides: slots every lot width, 7 m clear of the corners.
      const sides = [
        { name: "front", alongX: true, curb: C.z1, out: 1 as const, from: C.x0, to: isOffice ? ex.x0 : C.x1, rotY: 0 },
        { name: "back", alongX: true, curb: C.z0, out: -1 as const, from: C.x0, to: C.x1, rotY: Math.PI },
        { name: "east", alongX: false, curb: C.x1, out: 1 as const, from: C.z0, to: isOffice ? ex.z0 : C.z1, rotY: Math.PI / 2 },
        { name: "west", alongX: false, curb: C.x0, out: -1 as const, from: C.z0, to: C.z1, rotY: -Math.PI / 2 },
      ];
      for (const side of sides) {
        const r = rngFor(seed, "side", i, j, side.name);
        const at = (s: number, inset: number): [number, number] =>
          side.alongX ? [s, side.curb - side.out * inset] : [side.curb - side.out * inset, s];
        const hydrants: number[] = [];
        const wantSubway = !side.alongX && !isOffice && rngFor(seed, "subway", i, j, side.name)() < 0.3;
        const wantStand = side.alongX && rngFor(seed, "stand", i, j, side.name)() < 0.3;
        let slot = 0;
        for (let s = side.from + 7; s < side.to - 7; s += LOT_W, slot++) {
          if (slot % 4 === 0) {
            addLamp(...at(s, 0.6), side.rotY);
            continue;
          }
          if (wantSubway && slot === 2) {
            const [x, z] = at(s, 0.45 + 0.85);
            addSubway(x, z, side.out);
            continue;
          }
          if (wantStand && slot === 5) {
            addNewsstand(...at(s, 0.6 + 0.8));
            continue;
          }
          const roll = r();
          if (roll < 0.62) addTree(...at(s, 0.9), r);
          else if (roll < 0.7 && !hydrants.length) {
            addHydrant(...at(s, 0.6));
            hydrants.push(s);
          } else if (roll < 0.76) addBin(...at(s, 0.7));
        }
        // Parked cars, 1.25 m out from the curb, 10 m clear of the corners and 5 m of a hydrant. No parking on
        // a block's west side: that's the avenue's curbside bus lane.
        if (side.name === "west") continue;
        const cr = rngFor(seed, "cars", i, j, side.name);
        for (let s = side.from + 11; s < side.to - 11; s += 6.4) {
          if (hydrants.some((h) => Math.abs(h - s) < 5) || cr() < 0.3) continue;
          const [x, z] = at(s, -1.25);
          addCar(x, z, side.alongX, cr);
        }
      }
    }

  // ---- Road markings: lane lines, bus lanes, crosswalks and stop bars -----------------------------------
  const WHITE = "#e8e6df";
  const BUS = "#9e3b32";
  const dashes = (alongX: boolean, fixed: number, from: number, to: number) => {
    for (let s = from; s + 3 <= to; s += 9) marks.push(alongX ? { x: s + 1.5, z: fixed, w: 3, d: 0.15, color: WHITE } : { x: fixed, z: s + 1.5, w: 0.15, d: 3, color: WHITE });
  };
  for (let a = -WALK_R; a <= WALK_R + 1; a++) {
    const [ax0, ax1] = avenueX(a);
    for (let j = -RING_R; j <= RING_R; j++) {
      const C = curbOf(0, j);
      const z0 = C.z0 + 6;
      const z1 = C.z1 - 6;
      const bus0 = ax1 - 3.3;
      marks.push({ x: (bus0 + ax1) / 2, z: (z0 + z1) / 2, w: 3.3, d: z1 - z0, color: BUS });
      marks.push({ x: bus0, z: (z0 + z1) / 2, w: 0.2, d: z1 - z0, color: WHITE });
      const t0 = ax0 + 2.5;
      const lane = (bus0 - t0) / 4;
      for (let l = 1; l < 4; l++) dashes(false, t0 + l * lane, z0, z1);
    }
  }
  for (let s = -WALK_R; s <= WALK_R + 1; s++) {
    const [sz0, sz1] = streetZ(s);
    for (let i = -RING_R; i <= RING_R; i++) {
      const C = curbOf(i, 0);
      const lane = (sz1 - sz0 - 5) / 3;
      for (let l = 1; l < 3; l++) dashes(true, sz0 + 2.5 + l * lane, C.x0 + 6, C.x1 - 6);
    }
  }
  for (let a = -WALK_R; a <= WALK_R + 1; a++)
    for (let s = -WALK_R; s <= WALK_R + 1; s++) {
      const [ax0, ax1] = avenueX(a);
      const [sz0, sz1] = streetZ(s);
      // Across the street (walkers go along z; the bars lie along the traffic, x), either side of the avenue.
      for (const x of [ax0 - 2.1, ax1 + 2.1]) for (let z = sz0 + 0.8; z < sz1 - 0.4; z += 1.2) marks.push({ x, z, w: 3, d: 0.6, color: WHITE });
      for (const x of [ax0 - 4.2, ax1 + 4.2]) marks.push({ x, z: (sz0 + sz1) / 2, w: 0.45, d: sz1 - sz0 - 0.6, color: WHITE });
      // Across the avenue, north and south of the street.
      for (const z of [sz0 - 2.1, sz1 + 2.1]) for (let x = ax0 + 0.8; x < ax1 - 0.4; x += 1.2) marks.push({ x, z, w: 0.6, d: 3, color: WHITE });
      for (const z of [sz0 - 4.2, sz1 + 4.2]) marks.push({ x: (ax0 + ax1) / 2, z, w: ax1 - ax0 - 0.6, d: 0.45, color: WHITE });
    }

  // A few cars in the travel lanes (static traffic), 2–3 per walkable street and avenue segment.
  {
    const r = rngFor(seed, "traffic");
    for (let a = -WALK_R; a <= WALK_R + 1; a++) {
      const [ax0, ax1] = avenueX(a);
      for (let j = -WALK_R; j <= WALK_R; j++) {
        const C = curbOf(0, j);
        const first = between(r, 0, 3);
        for (let q = between(r, 1, 3); q > 0; q--) {
          const lane = (first + q) % 4; // one car per lane, so two never overlap
          addCar(ax0 + 2.5 + (lane + 0.5) * ((ax1 - 3.3 - ax0 - 2.5) / 4), C.z0 + 12 + r() * (blockD - 24), false, r);
        }
      }
    }
    for (let s = -WALK_R; s <= WALK_R + 1; s++) {
      const [sz0, sz1] = streetZ(s);
      for (let i = -WALK_R; i <= WALK_R; i++) {
        const C = curbOf(i, 0);
        const first = between(r, 0, 2);
        for (let q = between(r, 1, 3); q > 0; q--) {
          const lane = (first + q) % 3;
          addCar(C.x0 + 14 + r() * (blockW - 28), sz0 + 2.5 + (lane + 0.5) * ((sz1 - sz0 - 5) / 3), true, r);
        }
      }
    }
  }

  // ---- The walk boundary: the ring blocks' facing lot lines, with police barriers where a street goes on --
  const walk = rect(lotOf(-RING_R, 0).x1, lotOf(RING_R, 0).x0, lotOf(0, -RING_R).z1, lotOf(0, RING_R).z0);
  // The walls stand 0.65 m inside the line, just in front of the barriers (0.35 m in, legs ±0.25 m).
  const T = 2;
  const I = 0.65;
  colliders.push(box(walk.x0 - T, walk.x0 + I, walk.z0 - T, walk.z1 + T), box(walk.x1 - I, walk.x1 + T, walk.z0 - T, walk.z1 + T));
  colliders.push(box(walk.x0 - T, walk.x1 + T, walk.z0 - T, walk.z0 + I), box(walk.x0 - T, walk.x1 + T, walk.z1 - I, walk.z1 + T));
  const groundAt = (x: number, z: number) => {
    const fx = (x - C0.x0) / PX;
    const fz = (z - C0.z0) / PZ;
    const lx = (fx - Math.floor(fx)) * PX;
    const lz = (fz - Math.floor(fz)) * PZ;
    return lx > blockW || lz > blockD ? STREET_Y : 0;
  };
  const barrier = (x: number, z: number, alongX: boolean) => {
    const y = groundAt(x, z) === 0 ? SLAB_TOP : STREET_Y;
    const blue = "#2f5fb3";
    solids.push({ x, y: y + 0.75, z, w: alongX ? 2.3 : 0.1, h: 0.28, d: alongX ? 0.1 : 2.3, color: blue, style: "plain" });
    for (const k2 of [-0.9, 0.9])
      solids.push({ x: alongX ? x + k2 : x, y, z: alongX ? z : z + k2, w: alongX ? 0.08 : 0.5, h: 0.8, d: alongX ? 0.5 : 0.08, color: "#e9e6df", style: "plain" });
  };
  for (const s of [-WALK_R, 0, 1, WALK_R + 1]) {
    const [sz0, sz1] = streetZ(s);
    for (const x of [walk.x0 + 0.35, walk.x1 - 0.35]) for (let z = sz0 - SIDEWALK + 1.4; z < sz1 + SIDEWALK - 1; z += 2.6) barrier(x, z, false);
  }
  for (let a = -WALK_R; a <= WALK_R + 1; a++) {
    const [ax0, ax1] = avenueX(a);
    for (const z of [walk.z0 + 0.35, walk.z1 - 0.35]) for (let x = ax0 - SIDEWALK + 1.4; x < ax1 + SIDEWALK - 1; x += 2.6) barrier(x, z, true);
  }

  // ---- The skyline: plain boxes past the drawn blocks, hazier the further out -----------------------------
  const extent = rect(avenueX(-RING_R)[0], avenueX(RING_R + 1)[1], streetZ(-RING_R)[0], streetZ(RING_R + 1)[1]);
  const far: Far[] = [];
  {
    const r = rngFor(seed, "skyline");
    const near = 30;
    const reach = 650;
    for (let tries = 0; far.length < 420 && tries < 6000; tries++) {
      const x = extent.x0 - reach + r() * (extent.x1 - extent.x0 + 2 * reach);
      const z = extent.z0 - reach + r() * (extent.z1 - extent.z0 + 2 * reach);
      const out = Math.max(extent.x0 - x, x - extent.x1, extent.z0 - z, z - extent.z1);
      if (out < near) continue;
      const t = Math.min(1, (out - near) / (reach - near));
      const w = 20 + r() * 40;
      const tall = r();
      far.push({ x, z, w, d: 20 + r() * 40, h: 25 + 230 * tall * tall * (1 - 0.4 * t), t });
    }
  }

  // ---- Where am I (the walk chip) --------------------------------------------------------------------------
  const placeAt = (x: number, z: number): string | null => {
    const i = Math.floor((x - C0.x0) / PX);
    const j = Math.floor((z - C0.z0) / PZ);
    const lx = x - (C0.x0 + i * PX);
    const lz = z - (C0.z0 + j * PZ);
    const inAvenue = lx > blockW;
    const inStreet = lz > blockD;
    const av = (a: number) => names.avenue(a);
    const st = (s: number) => names.street(s);
    const both = (s: number, a: number) => (st(s) && av(a) ? `${st(s)} & ${av(a)}` : st(s) || av(a) || null);
    if (inAvenue && inStreet) return both(j + 1, i + 1);
    if (inAvenue) return av(i + 1) || null;
    if (inStreet) return st(j + 1) || null;
    const ns = lz < blockD / 2 ? j : j + 1;
    const ea = lx < blockW / 2 ? i : i + 1;
    const dz = Math.min(lz, blockD - lz);
    const dx = Math.min(lx, blockW - lx);
    if (dx < 6 && dz < 6) return both(ns, ea);
    return dx < dz ? av(ea) || null : st(ns) || null;
  };

  return {
    seed,
    solids,
    glows,
    cyls,
    cones,
    crowns,
    marks,
    far,
    intersections,
    lamps,
    colliders,
    walk,
    extent,
    centre: [(extent.x0 + extent.x1) / 2, (extent.z0 + extent.z1) / 2],
    names,
    counts: { buildings, blocks: (2 * RING_R + 1) ** 2, towers },
    groundAt,
    placeAt,
  };
}

