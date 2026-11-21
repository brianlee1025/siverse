import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CanvasTexture, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, type Group } from "three";
import { Html } from "@react-three/drei";
import { BUBBLE_Z, DOOR_HALF, FRAMING_LENGTH, framing, SIDEWALK, STREET_Y, WALL_H, type OfficeLayout } from "../layout";
import { useStore } from "../store";
import type { Phase } from "../scene/OfficeScene";
import { Facade } from "./Facade";

// Roadmap 3c-i-a: lamps, signal pole, hydrant and bin. Lazy, so the city code (cityBlock.ts) stays out of main.
const StreetFurniture = lazy(() => import("./StreetFurniture"));
// City round (2026-11-21): the 5 × 5 blocks, towers, street furniture, skyline and sky. Lazy, same gate.
const City = lazy(() => import("./City"));

// Roadmap phase 1 (steps 1a + 1b): the office as a building. Office view stays the open dollhouse; the
// shell, roof, sign, entrance and sidewalk only show once the boss zooms out past 1.5× the framing
// distance (the "outside view"). The office-view camera already sits outside the room's front (z ≈ 20 vs
// bounds.maxZ ≈ 9.5), so a front wall shown at the normal distance would hide the front corridor.

const SHOW_AT = 1.5; // × the framing distance: the building appears
const HIDE_AT = 1.35; // … and goes again (hysteresis, so it doesn't flicker at the edge)
const LINTEL_Y = 2.57;
// DOOR_HALF (the DoorFrame posts are at ±0.75, 0.14 wide), SIDEWALK (a New York sidewalk is about 15 ft) and
// STREET_Y (just under the floor slab, bottom at -0.32) live in layout.ts: the colliders use them too.
const BRICK = "#b5654a";
const STONE = "#8f877d";
const CONCRETE = "#cfc9bf";
const CANVAS_DARK = "#2b2f36";

interface Box {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  shadow?: boolean; // walls cast and receive; trim doesn't
}

/** Wall pieces along x at depth z, from x0 to x1, with a door gap at `door` (if given). */
function alongX(x0: number, x1: number, z: number, h: number, y0: number, t: number, color: string, door?: number): Box[] {
  const spans: [number, number][] =
    door === undefined ? [[x0, x1]] : [[x0, door - DOOR_HALF], [door + DOOR_HALF, x1]];
  return spans
    .filter(([a, b]) => b - a > 0.01)
    .map(([a, b]) => ({ position: [(a + b) / 2, y0 + h / 2, z], size: [b - a, h, t], color, shadow: true }));
}

/** The same along z at x. */
function alongZ(z0: number, z1: number, x: number, h: number, y0: number, t: number, color: string): Box {
  return { position: [x, y0 + h / 2, (z0 + z1) / 2], size: [t, h, z1 - z0], color, shadow: true };
}

/** Sidewalk joints on a 1.5 m grid, drawn once (no image files). One tile = one 1.5 m slab. */
let jointTexture: CanvasTexture | null = null;
function sidewalkTexture(): CanvasTexture {
  if (jointTexture) return jointTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.fillStyle = CONCRETE;
  g.fillRect(0, 0, size, size);
  g.fillStyle = "rgba(90, 82, 72, 0.35)";
  g.fillRect(0, 0, size, 1.5);
  g.fillRect(0, 0, 1.5, size);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  jointTexture = tex;
  return tex;
}

/** Opaque in the middle, transparent at the edge, so the street fades into the CSS backdrop. */
let fadeTexture: CanvasTexture | null = null;
function groundFade(): CanvasTexture {
  if (fadeTexture) return fadeTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(1, "#000000");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  fadeTexture = new CanvasTexture(canvas);
  return fadeTexture;
}

/** The company name in white on dark, sized to fit. System font only. `glow` draws the emissive map:
 * black background, white text, so only the letters light up after dark. */
function signTexture(name: string, glow = false): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const g = canvas.getContext("2d")!;
  g.fillStyle = glow ? "#000000" : CANVAS_DARK;
  g.fillRect(0, 0, 512, 96);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  let px = 56;
  const font = (p: number) => `600 ${p}px system-ui, "Segoe UI", sans-serif`;
  g.font = font(px);
  while (px > 18 && g.measureText(name).width > 470) g.font = font((px -= 2));
  g.fillText(name, 256, 50);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function Sidewalk({ x0, x1, z0, z1, tint }: { x0: number; x1: number; z0: number; z1: number; tint: string }) {
  const w = x1 - x0;
  const d = z1 - z0;
  const map = useMemo(() => {
    const tex = sidewalkTexture().clone(); // same canvas; own repeat per piece
    tex.repeat.set(w / 1.5, d / 1.5);
    tex.needsUpdate = true;
    return tex;
  }, [w, d]);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <group position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
      {/* The slab's body, down to the street. */}
      <mesh position={[0, (STREET_Y - 0.01) / 2, 0]}>
        <boxGeometry args={[w, -STREET_Y - 0.01, d]} />
        <meshStandardMaterial color={CONCRETE} />
      </mesh>
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial map={map} color={tint} roughness={0.95} />
      </mesh>
    </group>
  );
}

/** Step 1c-ii: the entrance lamp and the sign light up after dark (emissive only, no light objects). */
const LAMP: Record<Phase, number> = { morning: 0.3, day: 0.3, evening: 1.2, night: 2.0 };
// Round 10: only the letters glow now (signGlow below), so they can be brighter.
const SIGN_GLOW: Record<Phase, number> = { morning: 0, day: 0, evening: 0.5, night: 0.9 };
/** Round 10 (M8): the street and the sidewalk tops darken after dark. The sidewalk tint multiplies its joint map. */
const STREET: Record<Phase, string> = { morning: "#8e8a84", day: "#8e8a84", evening: "#6e6b6a", night: "#4a4a52" };
const SIDEWALK_TINT: Record<Phase, string> = { morning: "#ffffff", day: "#ffffff", evening: "#d8d4d0", night: "#9a98a6" };

export const Exterior = memo(function Exterior({
  layout,
  name,
  walking,
  phase,
  innerGlass,
  busy,
  asking,
  askId,
}: {
  layout: OfficeLayout;
  name: string;
  walking: boolean;
  phase: Phase;
  innerGlass: string; // Room's pane colour for the phase, for the inner front/right windows (Facade)
  busy: string; // zones with someone working, comma-joined ("boss" for the manager): lit windows at night
  asking: number; // approvals waiting: a ✋ pin over the roof in the outside view (round 11, roadmap 1c-vi)
  askId: string | undefined; // the first one, opened by the pin
}) {
  const group = useRef<Group>(null);
  const outside = useRef(false);
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null; // makeDefault sets it
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const gl = useThree((s) => s.gl);
  // The camera-to-target distance at the normal framing (with the narrow-screen fit), kept current.
  const framed = useRef(0);
  framed.current = framing(layout, aspect).distance * FRAMING_LENGTH;

  // Walk mode has no orbit controls: the shell is always there (the boss walks out through the door), and
  // the labels stay (WalkControls hides them on the street itself). Back in office view, the distance
  // rule below takes over on the next frame.
  // Roadmap 3c-i-a: the sidewalk furniture loads the first time the building is seen from outside (or walked),
  // never in a session that stays in office view. One re-render, once.
  const [seen, setSeen] = useState(false);
  const seenRef = useRef(false);
  const markSeen = () => {
    if (seenRef.current) return;
    seenRef.current = true;
    setSeen(true);
  };
  // ?view=outside: start the furniture chunk with the first frames, not after the first outside frame (headless
  // ?fps lines were stale in round 12). App sets startOutside after our first render and CameraRig clears it,
  // so subscribe (synchronous) instead of reading it once. Office view is unaffected: only that link sets it.
  useEffect(() => {
    if (useStore.getState().startOutside) markSeen();
    return useStore.subscribe((s) => {
      if (s.startOutside) markSeen();
    });
  }, []);

  useEffect(() => {
    outside.current = false;
    if (group.current) group.current.visible = walking;
    if (walking) markSeen();
    gl.domElement.closest(".scene-canvas")?.classList.remove("scene--outside");
  }, [walking, gl]);

  useFrame(({ camera }) => {
    if (walking) return;
    const target = controls?.target;
    if (!target || !group.current) return;
    const d = camera.position.distanceTo(target);
    const next = outside.current ? d > HIDE_AT * framed.current : d > SHOW_AT * framed.current;
    if (next === outside.current) return;
    if (next) markSeen();
    outside.current = next;
    group.current.visible = next;
    // drei <Html> isn't hidden by meshes, so bubbles and signs would float over the roof: hide them too.
    gl.domElement.closest(".scene-canvas")?.classList.toggle("scene--outside", next);
  });
  useEffect(() => () => void gl.domElement.closest(".scene-canvas")?.classList.remove("scene--outside"), [gl]);

  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const door = layout.door[0];

  const boxes = useMemo(() => {
    const out: Box[] = [];
    // The two walls the dollhouse leaves open (the back and left ones are Room's, at minZ/minX − 0.1).
    out.push(...alongX(minX - 0.2, maxX + 0.2, maxZ + 0.1, WALL_H, 0, 0.2, "#f1e9dc", door));
    out.push({ position: [door, (LINTEL_Y + WALL_H) / 2, maxZ + 0.1], size: [DOOR_HALF * 2, WALL_H - LINTEL_Y, 0.2], color: "#f1e9dc", shadow: true });
    out.push(alongZ(minZ - 0.2, maxZ + 0.2, maxX + 0.1, WALL_H, 0, 0.2, "#f1e9dc"));
    // Brick skin on the outer face of all four walls, and a stone base course.
    const skin = (h: number, y0: number, t: number, off: number, color: string) => {
      out.push(...alongX(minX - off, maxX + off, minZ - 0.2 - t / 2, h, y0, t, color));
      out.push(...alongX(minX - off, maxX + off, maxZ + 0.2 + t / 2, h, y0, t, color, door));
      out.push(alongZ(minZ - off, maxZ + off, minX - 0.2 - t / 2, h, y0, t, color));
      out.push(alongZ(minZ - off, maxZ + off, maxX + 0.2 + t / 2, h, y0, t, color));
    };
    skin(WALL_H, 0, 0.02, 0.22, BRICK);
    skin(0.4, 0, 0.06, 0.26, STONE);
    out.push({ position: [door, (LINTEL_Y + WALL_H) / 2, maxZ + 0.21], size: [DOOR_HALF * 2, WALL_H - LINTEL_Y, 0.02], color: BRICK });
    // Roof slab (receives shadow only) and a parapet round its edge.
    const rw = width + 0.44;
    const rd = depth + 0.44;
    out.push({ position: [cx, WALL_H + 0.1, cz], size: [rw, 0.2, rd], color: "#8d8a86" });
    const py = WALL_H + 0.2 + 0.3;
    out.push({ position: [cx, py, minZ - 0.12], size: [rw, 0.6, 0.2], color: BRICK, shadow: true });
    out.push({ position: [cx, py, maxZ + 0.12], size: [rw, 0.6, 0.2], color: BRICK, shadow: true });
    out.push({ position: [minX - 0.12, py, cz], size: [0.2, 0.6, rd - 0.4], color: BRICK, shadow: true });
    out.push({ position: [maxX + 0.12, py, cz], size: [0.2, 0.6, rd - 0.4], color: BRICK, shadow: true });
    // Rooftop units, for scale.
    const top = WALL_H + 0.2;
    for (const [fx, fz, w, h, d] of [
      [-0.25, -0.2, 1.6, 0.8, 1.2],
      [0.15, -0.25, 1.0, 0.6, 1.0],
      [0.3, 0.15, 1.2, 1.0, 0.8],
    ] as const)
      out.push({ position: [cx + fx * width, top + h / 2, cz + fz * depth], size: [w, h, d], color: "#a3a09b", shadow: true });
    // Curbs along the sidewalk's outer edges, down to the street.
    const sx0 = minX - SIDEWALK;
    const sx1 = maxX + SIDEWALK;
    const sz1 = maxZ + 0.2 + SIDEWALK;
    const curbH = 0.03 - STREET_Y;
    const curbY = STREET_Y + curbH / 2;
    out.push({ position: [cx, curbY, sz1], size: [sx1 - sx0 + 0.2, curbH, 0.2], color: "#b9b2a7" });
    out.push({ position: [sx0, curbY, (minZ - 0.2 + sz1) / 2], size: [0.2, curbH, sz1 - minZ + 0.2], color: "#b9b2a7" });
    out.push({ position: [sx1, curbY, (minZ - 0.2 + sz1) / 2], size: [0.2, curbH, sz1 - minZ + 0.2], color: "#b9b2a7" });
    return out;
  }, [minX, maxX, minZ, maxZ, width, depth, cx, cz, door]);

  // One material per colour for all the boxes (about 45 → 6). Draw calls stay the same.
  const mats = useMemo(() => new Map<string, MeshStandardMaterial>(), []);
  const mat = (color: string) => {
    let m = mats.get(color);
    if (!m) mats.set(color, (m = new MeshStandardMaterial({ color })));
    return m;
  };
  // Dispose frees GPU memory only; a material still in use is re-uploaded (safe under StrictMode's re-run).
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats]);

  const sign = useMemo(() => signTexture(name.trim() || "Office"), [name]);
  useEffect(() => () => sign.dispose(), [sign]);
  const signGlow = useMemo(() => signTexture(name.trim() || "Office", true), [name]);
  useEffect(() => () => signGlow.dispose(), [signGlow]);
  // The sign and canopy stay on the front wall even when the door is near the corner.
  const signX = Math.min(door, maxX + 0.22 - 1.5);
  const canopyX = Math.min(door, maxX + 0.22 - 1.2);

  return (
    <>
    {asking > 0 && (
      // Outside view only: CSS shows it under .scene--outside (drei <Html> ignores the group's `visible`).
      // No distanceFactor: it keeps one size at 45–86 m.
      <Html position={[cx, WALL_H + 2.6, cz]} center zIndexRange={BUBBLE_Z}>
        <button className="roof-ask" onClick={() => askId && useStore.getState().selectTask(askId)}>
          ✋ {asking} need{asking === 1 ? "s" : ""} your OK
        </button>
      </Html>
    )}
    <group ref={group} visible={false}>
      {boxes.map((b, i) => (
        <mesh key={i} position={b.position} castShadow={b.shadow} receiveShadow material={mat(b.color)}>
          <boxGeometry args={b.size} />
        </mesh>
      ))}
      {/* Step 1c-iii: a ceiling for walk mode, under the roof slab (y 3.0–3.2). Facing down, it's lit by the
          hemisphere's ground colour (tan by day, mauve at night), hence the emissive lift. No shadows: it would
          darken the whole floor. */}
      <mesh position={[cx, WALL_H - 0.01, cz]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#f7f2ea" emissive="#f7f2ea" emissiveIntensity={0.3} />
      </mesh>
      <Facade layout={layout} phase={phase} innerGlass={innerGlass} busy={busy} />
      {/* The company name over the door, above the canopy; its letters glow after dark. */}
      <mesh position={[signX, 2.8, maxZ + 0.225]}>
        <planeGeometry args={[3, 0.45]} />
        <meshStandardMaterial
          map={sign}
          emissiveMap={signGlow}
          emissive="#ffffff"
          emissiveIntensity={SIGN_GLOW[phase]}
          roughness={0.6}
        />
      </mesh>
      {/* Entrance: canopy, a lamp under it (emissive only, no light object), and a doorstep. */}
      <mesh position={[canopyX, 2.5, maxZ + 0.9]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 0.1, 1.4]} />
        <meshStandardMaterial color={CANVAS_DARK} />
      </mesh>
      <mesh position={[door, 2.42, maxZ + 0.7]}>
        <boxGeometry args={[0.3, 0.06, 0.3]} />
        <meshStandardMaterial color="#fff3df" emissive="#ffd9a0" emissiveIntensity={LAMP[phase]} />
      </mesh>
      <mesh position={[door, 0.03, maxZ + 0.5]} receiveShadow>
        <boxGeometry args={[2.0, 0.06, 0.6]} />
        <meshStandardMaterial color={STONE} />
      </mesh>
      {/* Sidewalk: an apron in front, and strips down both sides. */}
      <Sidewalk x0={minX - SIDEWALK} x1={maxX + SIDEWALK} z0={maxZ + 0.2} z1={maxZ + 0.2 + SIDEWALK} tint={SIDEWALK_TINT[phase]} />
      <Sidewalk x0={minX - SIDEWALK} x1={minX - 0.2} z0={minZ - 0.2} z1={maxZ + 0.2} tint={SIDEWALK_TINT[phase]} />
      <Sidewalk x0={maxX + 0.2} x1={maxX + SIDEWALK} z0={minZ - 0.2} z1={maxZ + 0.2} tint={SIDEWALK_TINT[phase]} />
      {/* The street: one plane that fades out at the edge into the backdrop. */}
      <mesh position={[cx, STREET_Y, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color={STREET[phase]} alphaMap={groundFade()} transparent depthWrite={false} />
      </mesh>
      {/* Meshes only (no <Html>), so the group's `visible` hides them in office view. */}
      {seen && (
        <Suspense fallback={null}>
          <StreetFurniture layout={layout} phase={phase} name={name} />
        </Suspense>
      )}
      {seen && (
        <Suspense fallback={null}>
          <City layout={layout} phase={phase} name={name} />
        </Suspense>
      )}
    </group>
    </>
  );
});
