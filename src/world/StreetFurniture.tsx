import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, Object3D, SRGBColorSpace, Vector3, type InstancedMesh } from "three";
import { STREET_Y, type OfficeLayout } from "../layout";
import type { Phase } from "../scene/OfficeScene";
import { useStore } from "../store";
import { frontageSlots, streetNames, type CityBlock, type Slot } from "./cityBlock";
import { citySeedFor } from "./rng";
import { signalAt, type Lamp } from "./signals";

// Roadmap 3c-i-a: the office's own sidewalk furniture (lamps, the corner signal pole, a hydrant, a bin) from
// cityBlock's seed-free slots. Lazy (mounted by Exterior inside its hidden group the first time the building is
// seen from outside), so office view never loads it. No lights, no shadows (lamps on the avenue sit at the shadow
// box's edge, and swimming pole shadows look wrong). Colliders: colliders.ts, same slots.
// Roadmap 3c-i-b (round 13): the signal's lenses on a 90 s clock (signals.ts), street-name blades on the pole,
// and warm pools of light under the lamps after dark. Calls: 4 by day, 5 in the evening and at night.

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
    { at: [0, 2.9, 0], size: [0.3, 0.9, 0.3], color: "#2b2f33" }, // the housing (lenses: the third mesh)
    { at: [0, 3.65, 0], size: [0.08, 0.6, 0.08], color: "#2b2f33" }, // round 13: the extension the name blades hang on
  ],
  hydrant: [{ at: [0, 0.33, 0], size: [0.3, 0.6, 0.3], color: "#c92a2a" }],
  bin: [{ at: [0, 0.48, 0], size: [0.5, 0.9, 0.5], color: "#2f4f3a" }],
};
/** The lamp head, at the arm's end. */
const HEAD: Part = { at: [0, 4.4, 0.85], size: [0.5, 0.15, 0.3], color: "" };
/** All heads share one colour per phase, after Exterior's entrance LAMP: warm only after dark. */
export const HEAD_COLOR: Record<Phase, string> = { morning: "#d9d4c8", day: "#d9d4c8", evening: "#ffd9a0", night: "#ffe2b0" };

// Signal lenses: four faces, so the boss sees a lit lamp from the outside camera (+x/+z) and from the door (−x/−z).
// The avenue runs along z, so the faces with a ±z normal face avenue traffic; ±x faces belong to the street.
const FACES: { n: [number, number]; road: "street" | "avenue" }[] = [
  { n: [1, 0], road: "street" },
  { n: [-1, 0], road: "street" },
  { n: [0, 1], road: "avenue" },
  { n: [0, -1], road: "avenue" },
];
const LAMPS: { lamp: Lamp; y: number }[] = [
  { lamp: "red", y: 3.15 },
  { lamp: "yellow", y: 2.9 },
  { lamp: "green", y: 2.65 },
];
export const LIT: Record<Lamp, string> = { red: "#ff3b30", yellow: "#ffb000", green: "#2fd27a" };
export const UNLIT = "#2a2d30";
const LENS_COUNT = FACES.length * LAMPS.length;

/** The name blades dim with the street after dark (Exterior's SIDEWALK_TINT). */
const PLATE_TINT: Record<Phase, string> = { morning: "#ffffff", day: "#ffffff", evening: "#d8d4d0", night: "#9a98a6" };

/** Two 512 × 114 bands (street on top, avenue below) for 0.9 × 0.2 m blades: the same 4.5 : 1 shape, no stretch. */
function plateTexture(names: CityBlock["names"]): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const g = canvas.getContext("2d")!;
  const font = (p: number) => `600 ${p}px system-ui, "Segoe UI", sans-serif`;
  const band = (y: number, text: string) => {
    g.fillStyle = "#1e6b3c";
    g.fillRect(0, y, 512, 114);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 4;
    g.strokeRect(6, y + 6, 500, 102); // a 4 px border, inset 4 px
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    let px = 72;
    g.font = font(px);
    while (px > 18 && g.measureText(text).width > 470) g.font = font((px -= 2));
    g.fillText(text, 256, y + 60);
  };
  band(0, names.street);
  band(128, names.avenue);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Quads from (centre, right, up, half sizes, v range). Counter-clockwise seen from the side right × up points at. */
function quads(list: { c: Vector3; right: Vector3; up: Vector3; hw: number; hh: number; v0: number; v1: number; u0?: number; u1?: number }[]) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = new Vector3();
  list.forEach((q, i) => {
    const corners: [number, number, number, number][] = [
      [-1, -1, q.u0 ?? 0, q.v0],
      [1, -1, q.u1 ?? 1, q.v0],
      [1, 1, q.u1 ?? 1, q.v1],
      [-1, 1, q.u0 ?? 0, q.v1],
    ];
    for (const [a, b, u, v] of corners) {
      p.copy(q.c).addScaledVector(q.right, a * q.hw).addScaledVector(q.up, b * q.hh);
      pos.push(p.x, p.y, p.z);
      uv.push(u, v);
    }
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

const X = new Vector3(1, 0, 0);
const NX = new Vector3(-1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const NZ = new Vector3(0, 0, -1);
// Blade faces stand 0.045 m out from the pole's centre, just outside the 0.08 m extension, so its middle isn't
// buried in the pole. The two blades are at different heights (3.52–3.72, 3.76–3.96), so they never cross.
const BLADE = 0.045;
// With flipY (the default), canvas row y is v = 1 − y/256.
const STREET_V: [number, number] = [1 - 114 / 256, 1];
const AVENUE_V: [number, number] = [1 - 242 / 256, 1 - 128 / 256];
function bladeGeometry() {
  const s = { hw: 0.45, hh: 0.1, v0: STREET_V[0], v1: STREET_V[1] };
  const a = { hw: 0.45, hh: 0.1, v0: AVENUE_V[0], v1: AVENUE_V[1] };
  return quads([
    { ...s, c: new Vector3(0, 3.62, BLADE), right: X, up: Y }, // faces +z, read from the avenue side's walkers
    { ...s, c: new Vector3(0, 3.62, -BLADE), right: NX, up: Y }, // faces −z
    { ...a, c: new Vector3(BLADE, 3.86, 0), right: NZ, up: Y }, // faces +x
    { ...a, c: new Vector3(-BLADE, 3.86, 0), right: Z, up: Y }, // faces −x
  ]);
}

export default function StreetFurniture({ layout, phase, name }: { layout: OfficeLayout; phase: Phase; name: string }) {
  const { slots } = useMemo(() => frontageSlots(layout), [layout]);
  const solids = useRef<InstancedMesh>(null);
  const heads = useRef<InstancedMesh>(null);
  const lenses = useRef<InstancedMesh>(null);
  const solidCount = slots.reduce((n, s) => n + PARTS[s.kind].length, 0);
  const lamps = useMemo(() => slots.filter((s) => s.kind === "lamp"), [slots]);
  const headCount = lamps.length;
  const signal = useMemo(() => slots.find((s) => s.kind === "signal"), [slots]);
  const citySeed = useStore((s) => s.citySeed);
  const names = useMemo(() => streetNames(citySeedFor(name, citySeed)), [name, citySeed]);
  const plates = useMemo(() => plateTexture(names), [names]);
  useEffect(() => () => plates.dispose(), [plates]);
  const blades = useMemo(bladeGeometry, []);
  useEffect(() => () => blades.dispose(), [blades]);

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

  // The lenses: 12 thin boxes on the housing's four faces. Colours for the current light right away, then
  // rewritten only when the light changes (6 times per 90 s, never per frame).
  const lastKey = useRef("");
  const paintLenses = (m: InstancedMesh) => {
    const now = signalAt(Date.now());
    const color = new Color();
    let i = 0;
    for (const f of FACES) for (const l of LAMPS) m.setColorAt(i++, color.set(now[f.road] === l.lamp ? LIT[l.lamp] : UNLIT));
    m.instanceColor!.needsUpdate = true;
    lastKey.current = now.avenue + now.street;
  };
  useLayoutEffect(() => {
    const m = lenses.current;
    if (!m || !signal) return;
    const fresh = !m.instanceColor;
    const dummy = new Object3D();
    const local = new Vector3();
    let i = 0;
    for (const f of FACES)
      for (const l of LAMPS) {
        local.set(f.n[0] * 0.16, l.y, f.n[1] * 0.16).applyAxisAngle(dummy.up, signal.rotY); // housing half-width 0.15
        dummy.position.set(signal.x + local.x, local.y, signal.z + local.z);
        dummy.rotation.set(0, signal.rotY + Math.atan2(f.n[0], f.n[1]), 0); // the thin side faces out
        dummy.scale.set(0.16, 0.16, 0.02);
        dummy.updateMatrix();
        m.setMatrixAt(i++, dummy.matrix);
      }
    m.instanceMatrix.needsUpdate = true;
    paintLenses(m);
    if (fresh) (m.material as { needsUpdate: boolean }).needsUpdate = true;
    m.computeBoundingSphere();
  }, [signal]);
  // Runs while the group is hidden too: cheap, and the light is right the moment the boss zooms out.
  useFrame(() => {
    const m = lenses.current;
    if (!m || !m.instanceColor) return;
    const s = signalAt(Date.now());
    if (s.avenue + s.street === lastKey.current) return;
    paintLenses(m);
  });

  if (!solidCount) return null;
  const night = phase === "evening" || phase === "night";
  return (
    <group>
      {/* calls: +1 (outside/walk only) */}
      <instancedMesh key={`s${solidCount}`} ref={solids} args={[undefined, undefined, solidCount]} castShadow={false} receiveShadow={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.7} />
      </instancedMesh>
      {headCount > 0 && (
        // calls: +1 (outside/walk only)
        <instancedMesh key={`h${headCount}`} ref={heads} args={[undefined, undefined, headCount]} castShadow={false} receiveShadow={false}>
          <boxGeometry args={[1, 1, 1]} />
          {/* Unlit and not tone-mapped, like Facade's glass: the colour above is what the boss sees. */}
          {/* One colour for all heads, so no instance colours: R3F updates `color` on a phase change. */}
          <meshBasicMaterial color={HEAD_COLOR[phase]} toneMapped={false} />
        </instancedMesh>
      )}
      {signal && (
        <>
          {/* calls: +1 (outside/walk only). White base: the instance colours carry the light. */}
          <instancedMesh key="l12" ref={lenses} args={[undefined, undefined, LENS_COUNT]} castShadow={false} receiveShadow={false}>
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial toneMapped={false} />
          </instancedMesh>
          {/* calls: +1 (outside/walk only). The name blades, white on green (MUTCD). No collider: they start at 3.52 m. */}
          <mesh geometry={blades} position={[signal.x, 0, signal.z]} rotation-y={signal.rotY} castShadow={false} receiveShadow={false}>
            <meshBasicMaterial map={plates} color={PLATE_TINT[phase]} toneMapped={false} />
          </mesh>
        </>
      )}
      {night && lamps.length > 0 && <LightPools lamps={lamps} phase={phase} />}
    </group>
  );
}

/** A soft white disc with alpha falling to 0 at the edge, drawn once (like Exterior's groundFade). */
let poolTexture: CanvasTexture | null = null;
function poolMap(): CanvasTexture {
  if (poolTexture) return poolTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255, 255, 255, 1)");
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  poolTexture = new CanvasTexture(canvas);
  poolTexture.colorSpace = SRGBColorSpace;
  return poolTexture;
}

/** Facing up: right = +x, up (in the plane) = −z. A circle of radius R round the lamp head (local z HEAD.at[2]). */
const R = 2;
const CURB = 0.6; // the slot sits 0.6 m inside the curb
function poolGeometry() {
  const hz = HEAD.at[2];
  const vOf = (z: number) => (z - hz + R) / (2 * R);
  const flat = (y: number, z0: number, z1: number) => ({
    c: new Vector3(0, y, (z0 + z1) / 2),
    right: X,
    up: NZ,
    hw: R,
    hh: (z1 - z0) / 2,
    v0: vOf(z1), // the quad's "bottom" edge is its +z side
    v1: vOf(z0),
  });
  return quads([
    flat(0.035, hz - R, CURB), // the sidewalk half: over the joint plane (0.012) and the curb top (0.03)
    flat(STREET_Y + 0.01, CURB, hz + R), // the street half: the curb box covers 0.5–0.7, the right occlusion
  ]);
}

/** Round 13 (3c-i-b): warm pools of light under the lamps, only mounted in the evening and at night (0 calls by
 * day). Normal alpha blending, not additive: the street plane is only fully opaque near the centre, and additive
 * colour over our premultiplied transparent canvas over-brightens. renderOrder 1 draws it after that plane. */
export function LightPools({ lamps, phase }: { lamps: Slot[]; phase: Phase }) {
  const mesh = useRef<InstancedMesh>(null);
  const geo = useMemo(poolGeometry, []);
  useEffect(() => () => geo.dispose(), [geo]);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const dummy = new Object3D();
    lamps.forEach((s, i) => {
      dummy.position.set(s.x, 0, s.z);
      dummy.rotation.set(0, s.rotY, 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [lamps]);
  return (
    // calls: +1 (evening/night, outside/walk only)
    <instancedMesh key={`p${lamps.length}`} ref={mesh} args={[geo, undefined, lamps.length]} renderOrder={1} castShadow={false} receiveShadow={false}>
      {/* City round: a polygon offset beyond the city asphalt's (−1), so the street half stays on top of it. */}
      <meshBasicMaterial map={poolMap()} color="#ffd9a0" transparent opacity={phase === "night" ? 0.55 : 0.35} depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-6} polygonOffsetUnits={-6} />
    </instancedMesh>
  );
}
