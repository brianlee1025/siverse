import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, Object3D, Vector3, type InstancedMesh } from "three";
import type { OfficeLayout } from "../layout";
import type { Phase } from "../scene/OfficeScene";
import { frontageSlots, type Slot } from "./cityBlock";

// Roadmap 3c-i-a: the office's own sidewalk furniture (lamps, the corner signal pole, a hydrant, a bin) from
// cityBlock's seed-free slots. Lazy (mounted by Exterior inside its hidden group the first time the building is
// seen from outside), so office view never loads it. Two draw calls: one instanced box mesh for every solid
// part, one unlit instanced mesh for the lamp heads. No lights, no textures, no shadows (lamps on the avenue sit
// at the shadow box's edge, and swimming pole shadows look wrong). Colliders: colliders.ts, same slots.

/** A part in the slot's own frame: local +z points at the street (rotY turns it), y is the centre. */
type Part = { at: [x: number, y: number, z: number]; size: [w: number, h: number, d: number]; color: string };

const POLE = "#3d4147";
const PARTS: Record<Slot["kind"], Part[]> = {
  lamp: [
    { at: [0, 2.28, 0], size: [0.14, 4.5, 0.14], color: POLE },
    { at: [0, 4.45, 0.45], size: [0.08, 0.08, 0.9], color: POLE }, // the arm, out over the curb
  ],
  signal: [
    { at: [0, 1.63, 0], size: [0.16, 3.2, 0.16], color: "#2b2f33" },
    { at: [0, 2.9, 0], size: [0.3, 0.9, 0.3], color: "#2b2f33" }, // the housing (lenses come with 3c-i-b)
  ],
  hydrant: [{ at: [0, 0.33, 0], size: [0.3, 0.6, 0.3], color: "#c92a2a" }],
  bin: [{ at: [0, 0.48, 0], size: [0.5, 0.9, 0.5], color: "#2f4f3a" }],
};
/** The lamp head, at the arm's end. */
const HEAD: Part = { at: [0, 4.4, 0.85], size: [0.5, 0.15, 0.3], color: "" };
/** All heads share one colour per phase, after Exterior's entrance LAMP: warm only after dark. */
const HEAD_COLOR: Record<Phase, string> = { morning: "#d9d4c8", day: "#d9d4c8", evening: "#ffd9a0", night: "#ffe2b0" };

export default function StreetFurniture({ layout, phase }: { layout: OfficeLayout; phase: Phase }) {
  const { slots } = useMemo(() => frontageSlots(layout), [layout]);
  const solids = useRef<InstancedMesh>(null);
  const heads = useRef<InstancedMesh>(null);
  const solidCount = slots.reduce((n, s) => n + PARTS[s.kind].length, 0);
  const headCount = slots.filter((s) => s.kind === "lamp").length;

  // Matrices and colours before the first frame. The meshes are keyed on their counts, so a hire that
  // changes the slots re-creates them.
  useLayoutEffect(() => {
    const m = solids.current;
    const h = heads.current;
    if (!m) return;
    const fresh = !m.instanceColor;
    const dummy = new Object3D();
    const local = new Vector3();
    const color = new Color();
    const place = (s: Slot, p: Part) => {
      local.set(...p.at).applyAxisAngle(dummy.up, s.rotY);
      dummy.position.set(s.x + local.x, local.y, s.z + local.z);
      dummy.rotation.set(0, s.rotY, 0);
      dummy.scale.set(...p.size);
      dummy.updateMatrix();
      return dummy.matrix;
    };
    let i = 0;
    let j = 0;
    for (const s of slots) {
      for (const p of PARTS[s.kind]) {
        m.setMatrixAt(i, place(s, p));
        m.setColorAt(i, color.set(p.color));
        i++;
      }
      if (s.kind === "lamp" && h) h.setMatrixAt(j++, place(s, HEAD));
    }
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor!.needsUpdate = true;
    // three only adds instance colours to the shader if they exist when the material compiles.
    if (fresh) (m.material as { needsUpdate: boolean }).needsUpdate = true;
    m.computeBoundingSphere();
    if (h) {
      h.instanceMatrix.needsUpdate = true;
      h.computeBoundingSphere();
    }
  }, [slots, solidCount, headCount]);

  if (!solidCount) return null;
  return (
    <group>
      <instancedMesh key={`s${solidCount}`} ref={solids} args={[undefined, undefined, solidCount]} castShadow={false} receiveShadow={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.7} />
      </instancedMesh>
      {headCount > 0 && (
        <instancedMesh key={`h${headCount}`} ref={heads} args={[undefined, undefined, headCount]} castShadow={false} receiveShadow={false}>
          <boxGeometry args={[1, 1, 1]} />
          {/* Unlit and not tone-mapped, like Facade's glass: the colour above is what the boss sees. */}
          {/* One colour for all heads, so no instance colours: R3F updates `color` on a phase change. */}
          <meshBasicMaterial color={HEAD_COLOR[phase]} toneMapped={false} />
        </instancedMesh>
      )}
    </group>
  );
}
