import type { Department } from "../shared/types";

// Office floor plan, in world units (1 unit ≈ 1 metre). The floor is a grid of zones: the boss's
// office takes the first cell and every department gets the next one. Workers enter through the
// door at the front-right and walk along corridors to their desk, so they never cut through
// furniture.

export type Vec2 = [x: number, z: number];

export const ZONE_W = 7.4;
export const ZONE_D = 6.2;
const GAP = 1.8; // corridor width between zones
const COLS = 3;
const MARGIN = 2.4;
const DESK_COLS = 3;
const DESK_DX = 2.3;
const DESK_DZ = 2.5;

export interface Zone {
  center: Vec2;
  front: number; // z of the zone's front edge (towards the camera)
}

export interface Desk {
  position: Vec2; // desk centre
  seat: Vec2; // where the worker sits, facing +z
}

export interface OfficeLayout {
  boss: Zone;
  departments: Map<string, { zone: Zone; desks: Desk[] }>;
  placeholder: Zone | null; // where the next department will go
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  door: Vec2;
  corridorX: number;
}

function cellCenter(index: number): Vec2 {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return [col * (ZONE_W + GAP), row * (ZONE_D + GAP)];
}

export function desksFor(center: Vec2, headcount: number): Desk[] {
  const desks: Desk[] = [];
  const rows = Math.ceil(headcount / DESK_COLS);
  for (let i = 0; i < headcount; i++) {
    const col = i % DESK_COLS;
    const row = Math.floor(i / DESK_COLS);
    const x = center[0] + (col - 1) * DESK_DX;
    const z = center[1] + (row - (rows - 1) / 2) * DESK_DZ + 0.3;
    desks.push({ position: [x, z], seat: [x, z - 0.75] });
  }
  return desks;
}

export function buildLayout(departments: Department[]): OfficeLayout {
  const cells = departments.length + 2; // boss + departments + placeholder
  const cols = Math.min(COLS, cells);
  const rows = Math.ceil(cells / COLS);
  const width = cols * ZONE_W + (cols - 1) * GAP;
  const depth = rows * ZONE_D + (rows - 1) * GAP;
  const offsetX = -width / 2 + ZONE_W / 2;
  const offsetZ = -depth / 2 + ZONE_D / 2;

  const zoneAt = (index: number): Zone => {
    const [x, z] = cellCenter(index);
    const center: Vec2 = [x + offsetX, z + offsetZ];
    return { center, front: center[1] + ZONE_D / 2 };
  };

  const map = new Map<string, { zone: Zone; desks: Desk[] }>();
  departments.forEach((d, i) => {
    const zone = zoneAt(i + 1);
    map.set(d.id, { zone, desks: desksFor(zone.center, d.headcount) });
  });

  const bounds = {
    minX: -width / 2 - MARGIN,
    maxX: width / 2 + MARGIN,
    minZ: -depth / 2 - MARGIN,
    maxZ: depth / 2 + MARGIN,
  };
  const corridorX = width / 2 + GAP / 2 + 0.2;
  return {
    boss: zoneAt(0),
    departments: map,
    placeholder: zoneAt(departments.length + 1),
    bounds,
    door: [corridorX, bounds.maxZ - 0.6],
    corridorX,
  };
}

/** Waypoints from the door to a seat: up the right corridor, along the row, down the desk aisle. */
export function pathToSeat(layout: OfficeLayout, zone: Zone, seat: Vec2): Vec2[] {
  const corridorZ = zone.front + GAP / 2;
  const laneX = seat[0] + DESK_DX / 2;
  return [layout.door, [layout.corridorX, corridorZ], [laneX, corridorZ], [laneX, seat[1]], seat];
}
