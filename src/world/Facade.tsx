import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { Color, Object3D, Vector3, type InstancedMesh } from "three";
import type { OfficeLayout } from "../layout";
import type { Phase } from "../scene/OfficeScene";

// Roadmap step 1c: windows on all four outside walls, as two instanced meshes (glass + frames), so every
// window costs 2 draw calls in total. Rendered inside Exterior's group, so office view never shows it.
// The glass is unlit (meshBasicMaterial): instanceColor only tints the diffuse colour, never `emissive`,
// so the whole day/night look is in the per-instance colour, with no light needed.

const W = 2.6; // the inner Window's sizes (scene/Furniture.tsx)
const H = 1.3;
const Y = 1.85; // the inner windows' centre height, so back and left line up through the wall
const FACE = 0.225; // the brick skin's outer face is 0.22 out; +0.005 against z-fighting

/** Frame pieces in the window's own space: [x, y, z, width, height, depth]. */
const PIECES: [number, number, number, number, number, number][] = [
  [0, H / 2, 0.04, W + 0.12, 0.08, 0.06], // top
  [0, -H / 2, 0.04, W + 0.12, 0.08, 0.06], // bottom
  [-W / 2, 0, 0.04, 0.08, H, 0.06], // sides
  [W / 2, 0, 0.04, 0.08, H, 0.06],
  [0, 0, 0.04, 0.06, H, 0.06], // mullion
  [0, -H / 2 - 0.06, 0.1, W + 0.3, 0.06, 0.2], // sill
];

/** Glass colours per phase: one for daylight; lit and dark ones after dark. */
const GLASS: Record<Phase, { lit: string; dark?: string }> = {
  morning: { lit: "#b9cfdd" },
  day: { lit: "#9fb7c9" },
  evening: { lit: "#f6c08f", dark: "#5a6475" },
  night: { lit: "#ffd9a0", dark: "#2b3446" },
};
/** About 1 in 6 windows stays dark at night, in a fixed pattern (stable screenshots). */
const isDark = (i: number) => (i * 7 + 3) % 6 === 0;

/** Step 1c-iii: the inner glass sits 0.01 off the inner wall face (as Room's own windows, Furniture.tsx). */
const INNER = 0.01;

interface Slot {
  x: number;
  z: number;
  rotY: number;
  /** "out" = the outside skin; "in" = the room side of the front and right walls (walk mode). */
  side: "out" | "in";
  /** The team behind an outer window ("boss" or a department id), or null: lit at night only while it works. */
  zone: string | null;
}

/** Round 10: a window belongs to the nearest zone by 2D distance (the office has two rows), within this. */
const ZONE_REACH = 8;

export const Facade = memo(function Facade({
  layout,
  phase,
  innerGlass,
  busy,
}: {
  layout: OfficeLayout;
  phase: Phase;
  /** The room's own pane colour for this phase (OfficeScene's look.glass): a string, so memo holds. */
  innerGlass: string;
  /** Zones with someone working, comma-joined (a string, so memo holds). */
  busy: string;
}) {
  const glass = useRef<InstancedMesh>(null);
  const frames = useRef<InstancedMesh>(null);
  const { minX, maxX, minZ, maxZ } = layout.bounds;

  const slots = useMemo<Slot[]>(() => {
    // The placeholder isn't a team, so it's never a match.
    const zones: [string, number, number][] = [
      ["boss", ...layout.boss.center],
      ...[...layout.departments].map(([id, { zone }]): [string, number, number] => [id, ...zone.center]),
    ];
    const nearest = (x: number, z: number) => {
      let best: string | null = null;
      let bestD = ZONE_REACH;
      for (const [id, cx, cz] of zones) {
        const d = Math.hypot(x - cx, z - cz);
        if (d <= bestD) {
          best = id;
          bestD = d;
        }
      }
      return best;
    };
    const raw: Omit<Slot, "zone">[] = [
      // Plane normals face +z; rotY turns each one outward.
      ...layout.wallSlots.filter((s) => s.kind === "window").map((s) => ({ x: s.x, z: minZ - FACE, rotY: Math.PI, side: "out" as const })),
      ...layout.frontWindows.map((x) => ({ x, z: maxZ + FACE, rotY: 0, side: "out" as const })),
      ...layout.sideWindows.map((z) => ({ x: minX - FACE, z, rotY: -Math.PI / 2, side: "out" as const })),
      ...layout.sideWindows.map((z) => ({ x: maxX + FACE, z, rotY: Math.PI / 2, side: "out" as const })),
      // Step 1c-iii: the same windows seen from inside (the back and left walls have Room's). Appended last,
      // so the outer windows keep their indices (and the night pattern). rotY turns +z into the room.
      ...layout.frontWindows.map((x) => ({ x, z: maxZ - INNER, rotY: Math.PI, side: "in" as const })),
      ...layout.sideWindows.map((z) => ({ x: maxX - INNER, z, rotY: -Math.PI / 2, side: "in" as const })),
    ];
    return raw.map((s) => ({ ...s, zone: s.side === "out" ? nearest(s.x, s.z) : null }));
  }, [layout, minX, maxX, minZ, maxZ]);
  const n = slots.length;

  // Matrices before the first frame. The meshes are keyed on the count, so a hire re-creates them.
  useLayoutEffect(() => {
    const g = glass.current;
    const f = frames.current;
    if (!g || !f) return;
    const dummy = new Object3D();
    const local = new Vector3();
    slots.forEach((s, i) => {
      dummy.position.set(s.x, Y, s.z);
      dummy.rotation.set(0, s.rotY, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      g.setMatrixAt(i, dummy.matrix);
      PIECES.forEach(([px, py, pz, w, h, d], j) => {
        local.set(px, py, pz).applyAxisAngle(dummy.up, s.rotY);
        dummy.position.set(s.x + local.x, Y + local.y, s.z + local.z);
        dummy.scale.set(w, h, d);
        dummy.updateMatrix();
        f.setMatrixAt(i * PIECES.length + j, dummy.matrix);
      });
    });
    g.instanceMatrix.needsUpdate = true;
    f.instanceMatrix.needsUpdate = true;
    g.computeBoundingSphere();
    f.computeBoundingSphere();
  }, [slots]);

  // R5: the glass colour per phase (no new meshes, the same 2 draw calls).
  useLayoutEffect(() => {
    const g = glass.current;
    if (!g) return;
    const fresh = !g.instanceColor;
    const { lit, dark } = GLASS[phase];
    const litColor = new Color(lit);
    const darkColor = dark ? new Color(dark) : litColor;
    // Inside, the pane is the view out in every phase, as Room's Window shows it.
    const inColor = new Color(innerGlass);
    // Round 10: after dark, a window with a team behind it is lit only while that team works; one with no
    // team keeps the fixed pattern. By day `dark` is unset, so every outer pane is the daylight colour.
    const working = new Set(busy.split(","));
    const outColor = (s: Slot, i: number) => (s.zone ? (working.has(s.zone) ? litColor : darkColor) : isDark(i) ? darkColor : litColor);
    slots.forEach((s, i) => g.setColorAt(i, s.side === "in" ? inColor : outColor(s, i)));
    g.instanceColor!.needsUpdate = true;
    // three only adds instance colours to the shader if they exist when the material compiles.
    if (fresh) (g.material as { needsUpdate: boolean }).needsUpdate = true;
  }, [phase, n, slots, innerGlass, busy]);

  if (!n) return null;
  return (
    <group>
      <instancedMesh key={`g${n}`} ref={glass} args={[undefined, undefined, n]} castShadow={false} receiveShadow={false}>
        <planeGeometry args={[W, H]} />
        {/* Not tone-mapped, so the colours above are what the boss sees. */}
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`f${n}`} ref={frames} args={[undefined, undefined, n * PIECES.length]} castShadow={false} receiveShadow={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#fbf8f2" />
      </instancedMesh>
    </group>
  );
});
