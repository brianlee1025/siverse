// Roadmap step 2a-i: what the walking boss bumps into. Pure maths (no React, no three), built from the
// same layout the scene draws from, so a moved desk moves its collider too. Axis-aligned boxes on the
// floor plane, in world units. Staff aren't colliders yet (roadmap 2c).
import { DOOR_HALF, SIDEWALK, ZONE_W, type OfficeLayout, type Vec2 } from "../layout";
import { frontageSlots } from "./cityBlock"; // lazy-only, like this file (WalkControls, ColliderDebug)

const SLOT_SIZE = { lamp: 0.3, signal: 0.3, hydrant: 0.4, bin: 0.6 } as const;

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The walking boss's radius. */
export const PLAYER_R = 0.25;

const WALL_OUT = 0.46; // inner face to the stone base course's outer face, with slack (Exterior.tsx)
const RING = 2; // the curb ring's thickness

const at = (cx: number, cz: number, w: number, d: number): Box => ({
  minX: cx - w / 2,
  maxX: cx + w / 2,
  minZ: cz - d / 2,
  maxZ: cz + d / 2,
});
const atV = ([x, z]: Vec2, w: number, d: number) => at(x, z, w, d);

export function buildColliders(layout: OfficeLayout): Box[] {
  const b = layout.bounds;
  const door = layout.door[0];
  const out: Box[] = [];

  // Walls: back, left, right, and the front in two pieces either side of the door.
  out.push({ minX: b.minX - 0.5, maxX: b.maxX + 0.5, minZ: b.minZ - WALL_OUT, maxZ: b.minZ });
  out.push({ minX: b.minX - WALL_OUT, maxX: b.minX, minZ: b.minZ - WALL_OUT, maxZ: b.maxZ + WALL_OUT });
  out.push({ minX: b.maxX, maxX: b.maxX + WALL_OUT, minZ: b.minZ - WALL_OUT, maxZ: b.maxZ + WALL_OUT });
  out.push({ minX: b.minX - WALL_OUT, maxX: door - DOOR_HALF, minZ: b.maxZ, maxZ: b.maxZ + WALL_OUT });
  out.push({ minX: door + DOOR_HALF, maxX: b.maxX + WALL_OUT, minZ: b.maxZ, maxZ: b.maxZ + WALL_OUT });
  // Door-frame posts (1.36 m between them; the player needs 0.5).
  out.push(at(door - 0.75, b.maxZ - 0.05, 0.14, 0.2), at(door + 0.75, b.maxZ - 0.05, 0.14, 0.2));

  // Desks (no chairs: the boss would get stuck between a chair and the next row) and in-trays.
  for (const { zone, desks } of layout.departments.values()) {
    for (const desk of desks) out.push(atV(desk.position, 1.45, 0.8));
    out.push(at(zone.center[0] - ZONE_W / 2 + 0.6, zone.front - 0.6, 0.6, 0.45));
  }

  // The boss's zone (OfficeScene BossOffice): desk, chair, bookshelf, plant, and the manager's spot.
  const [cx, cz] = layout.boss.center;
  out.push(
    at(cx - 0.6, cz + 0.2, 2.4, 1.1),
    at(cx - 0.6, cz - 0.6, 0.6, 0.6),
    at(cx - 1.4, cz - 2.6, 1.6, 0.4),
    at(cx + 2.6, cz - 2.4, 1.0, 1.0),
    at(cx + 1.5, cz + 0.4, 0.5, 0.5),
  );

  for (const d of layout.dividers) out.push(atV(d.position, d.glass ? 0.2 : 0.5, d.length));
  out.push(atV(layout.cooler, 0.4, 0.4));
  // Coffee corner: the counter is centred at x −0.4 (2.2 wide), the fridge at +1.05 (0.7 wide).
  if (layout.kitchenX !== undefined)
    out.push({ minX: layout.kitchenX - 1.5, maxX: layout.kitchenX + 1.4, minZ: b.minZ, maxZ: b.minZ + 0.7 });
  // Corner plants.
  out.push(at(b.minX + 0.8, b.minZ + 0.8, 1.1, 1.1), at(b.maxX - 0.8, b.minZ + 0.8, 0.9, 0.9), at(b.minX + 0.8, b.maxZ - 0.8, 0.8, 0.8));

  // Roadmap 3c-i-a: the office's sidewalk furniture (StreetFurniture.tsx). Footprints by kind, a bit larger
  // than the meshes (a 0.14 m pole → 0.3) so a glancing walk doesn't clip it on screen; the player's radius is
  // added in moveWithCollisions.
  for (const s of frontageSlots(layout).slots) out.push(at(s.x, s.z, SLOT_SIZE[s.kind], SLOT_SIZE[s.kind]));

  // The curb ring: out of the door and round both sides, but not onto the street (no gravity yet).
  // Phase 3 replaces it with the real street. There's no sidewalk behind the building.
  const x0 = b.minX - SIDEWALK;
  const x1 = b.maxX + SIDEWALK;
  const zBack = b.minZ - 0.2;
  const zFront = b.maxZ + 0.2 + SIDEWALK;
  out.push(
    { minX: x0 - RING, maxX: x0, minZ: zBack - RING, maxZ: zFront + RING },
    { minX: x1, maxX: x1 + RING, minZ: zBack - RING, maxZ: zFront + RING },
    { minX: x0 - RING, maxX: x1 + RING, minZ: zFront, maxZ: zFront + RING },
    { minX: x0 - RING, maxX: x1 + RING, minZ: zBack - RING, maxZ: zBack },
  );
  return out;
}

const inside = (x: number, z: number, b: Box, r: number) =>
  x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r;

const EPS = 1e-4;

/**
 * One step from (x, z) by (dx, dz), sliding along whatever it meets. Every box is grown by `r` and the
 * move is resolved one axis at a time: move along x and clamp back to the side you came from, then z.
 * A box you're already inside (a bad spawn) doesn't hold you, so you can always walk out. Keep steps
 * short (≤ 0.1): the caller sub-steps.
 */
export function moveWithCollisions(x: number, z: number, dx: number, dz: number, boxes: Box[], r = PLAYER_R): [number, number] {
  let nx = x + dx;
  if (dx !== 0)
    for (const b of boxes) {
      if (inside(x, z, b, r) || !inside(nx, z, b, r)) continue;
      nx = dx > 0 ? b.minX - r - EPS : b.maxX + r + EPS;
    }
  let nz = z + dz;
  if (dz !== 0)
    for (const b of boxes) {
      if (inside(nx, z, b, r) || !inside(nx, nz, b, r)) continue;
      nz = dz > 0 ? b.minZ - r - EPS : b.maxZ + r + EPS;
    }
  return [nx, nz];
}
