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
export const DESK_COLS = 3;
// Bubbles rise up the screen (the back) and strollers use the right-hand corridor, 1.1 past the last zone.
const FOCUS_MARGIN = { left: 1.0, right: 2.5, back: 2.0, front: 1.0 };
// drei <Html> stacking: separate ranges, so a near sign never beats a far bubble. They only count
// inside the scene (.scene-canvas isolates them), so page overlays always stay on top.
export const BUBBLE_Z: [number, number] = [100, 40];
export const SIGN_Z: [number, number] = [30, 0];
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
  // What the camera frames: the boss and the departments, not the empty cell for the next one.
  focus: { minX: number; maxX: number; minZ: number; maxZ: number };
  door: Vec2;
  corridorX: number;
  cooler: Vec2; // the water cooler, in the gap between the front row's last two zones
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
  const boss = zoneAt(0);
  const placeholder = zoneAt(departments.length + 1);
  // The placeholder only counts while there are no departments yet (it's the call to action then).
  const framed = [boss, ...[...map.values()].map((d) => d.zone), ...(departments.length ? [] : [placeholder])];
  const focus = {
    minX: Math.min(...framed.map((z) => z.center[0])) - ZONE_W / 2 - FOCUS_MARGIN.left,
    maxX: Math.max(...framed.map((z) => z.center[0])) + ZONE_W / 2 + FOCUS_MARGIN.right,
    minZ: Math.min(...framed.map((z) => z.center[1])) - ZONE_D / 2 - FOCUS_MARGIN.back,
    maxZ: Math.max(...framed.map((z) => z.center[1])) + ZONE_D / 2 + FOCUS_MARGIN.front,
  };
  const corridorX = width / 2 + GAP / 2 + 0.2;
  // In the gap right of the front row's last zone, just behind its corridor: the room's front edge and the
  // right-hand corridor's end are off-camera in perspective, but the gaps between zones are always in frame.
  // Nobody walks there: rows are changed only in the right-hand corridor, and desk aisles stay inside zones.
  const frontZ = Math.max(...framed.map((z) => z.front));
  const frontRow = framed.filter((z) => z.front === frontZ);
  const lastX = Math.max(...frontRow.map((z) => z.center[0]));
  const gapX = frontRow.length > 1 ? lastX - ZONE_W / 2 - GAP / 2 : lastX + ZONE_W / 2 + GAP / 2;
  const cooler: Vec2 = [gapX, frontZ - 0.6];
  return {
    boss,
    departments: map,
    placeholder,
    bounds,
    focus,
    door: [corridorX, bounds.maxZ - 0.6],
    corridorX,
    cooler,
  };
}

/** The corridor in front of the cooler, where staff stop for a drink; null when the camera doesn't frame it. */
function coolerSpot(layout: OfficeLayout): Vec2 | null {
  const spot: Vec2 = [layout.cooler[0], layout.cooler[1] + 0.6 + GAP / 2];
  const { minX, maxX, maxZ } = layout.focus;
  return spot[0] >= minX && spot[0] <= maxX && spot[1] <= maxZ ? spot : null;
}

/** Waypoints from the door to a seat: up the right corridor, along the row, down the desk aisle. */
export function pathToSeat(layout: OfficeLayout, zone: Zone, seat: Vec2): Vec2[] {
  const corridorZ = zone.front + GAP / 2;
  const laneX = seat[0] + DESK_DX / 2;
  return [layout.door, [layout.corridorX, corridorZ], [laneX, corridorZ], [laneX, seat[1]], seat];
}

// Permanent employees between tasks stroll the open floor: the corridors in front of each zone and
// the right-hand corridor, which joins them. They only turn into another row in that corridor.

/** Where free employees stop for a while: along the corridor in front of every zone, and at the water cooler. */
export function strollSpots(layout: OfficeLayout): Vec2[] {
  const zones = [layout.boss, ...[...layout.departments.values()].map((d) => d.zone)];
  const spots: Vec2[] = [];
  for (const zone of zones) {
    for (const dx of [-2.4, 0, 2.4]) spots.push([zone.center[0] + dx, zone.front + GAP / 2]);
  }
  const cooler = coolerSpot(layout);
  if (cooler) spots.push(cooler);
  return spots;
}

/** An employee's own stroll spots: the corridor in front of their zone, and the water cooler. */
export function homeSpots(layout: OfficeLayout, zone: Zone): Vec2[] {
  const spots: Vec2[] = [-2.4, 0, 2.4].map((dx) => [zone.center[0] + dx, zone.front + GAP / 2]);
  const cooler = coolerSpot(layout);
  if (cooler) spots.push(cooler);
  return spots;
}

/** Waypoints between two points on the open floor, changing rows only in the right-hand corridor. */
export function floorRoute(layout: OfficeLayout, from: Vec2, to: Vec2): Vec2[] {
  if (Math.abs(from[1] - to[1]) < 0.05) return [to];
  if (Math.abs(from[0] - layout.corridorX) < 0.05) return [[layout.corridorX, to[1]], to];
  return [[layout.corridorX, from[1]], [layout.corridorX, to[1]], to];
}

/** The aisle beside a seat: `lane` is where it meets the corridor, `top` is level with the seat. */
export function aisle(zone: Zone, seat: Vec2): { lane: Vec2; top: Vec2 } {
  const laneX = seat[0] + DESK_DX / 2;
  return { lane: [laneX, zone.front + GAP / 2], top: [laneX, seat[1]] };
}

export function inZone(zone: Zone, point: Vec2): boolean {
  return Math.abs(point[0] - zone.center[0]) < ZONE_W / 2 && Math.abs(point[1] - zone.center[1]) < ZONE_D / 2;
}
