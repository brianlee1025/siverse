import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import {
  CanvasTexture,
  Color,
  RepeatWrapping,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  type DirectionalLight,
  type Vector3,
} from "three";
import type { Department, Snapshot, Task } from "../../shared/types";
import {
  BUBBLE_Z,
  buildLayout,
  FRAMING_DIR,
  framing,
  SIGN_Z,
  WALL_H,
  ZONE_D,
  ZONE_W,
  type OfficeLayout,
  type Zone,
} from "../layout";
import { inkFor } from "../colors";
import { NEEDS_YOU_WINDOW_MS } from "../failures";
import { useStore } from "../store";
import {
  Bookshelf,
  Chair,
  CoffeeCorner,
  Desk,
  DoorFrame,
  GlassPartition,
  InTray,
  Plant,
  Planter,
  WallArt,
  WallClock,
  WaterCooler,
  Window,
} from "./Furniture";
import { Person, type Motion } from "./Person";
import { StaffMember, Worker } from "./Worker";
import { Exterior } from "../world/Exterior";

// The open-world pieces load on first use, in their own chunks (roadmap: lazy city).
const ColliderDebug = lazy(() => import("../world/ColliderDebug"));
const WalkControls = lazy(() => import("../world/WalkControls"));
const FpsDebug = lazy(() => import("../world/FpsDebug"));

const LEAVING_WINDOW_MS = 18_000; // finished workers stay on screen this long to walk out (to the sidewalk)
const CAMERA_FOV = 35;
const LABEL_DISTANCE_FACTOR = 14; // the distanceFactor of the people's bubbles

// ---- Time of day: one warm "sun" plus a sky fill, tinted by the boss's local clock ----

export type Phase = "morning" | "day" | "evening" | "night";
interface PhaseLook {
  sun: string;
  sunIntensity: number;
  sunPosition: [number, number, number];
  sky: string;
  ground: string;
  fill: number;
  glass: string; // window panes
  glassGlow: number;
  backdrop: string; // CSS behind the transparent canvas
}
const PHASES: Record<Phase, PhaseLook> = {
  morning: {
    sun: "#ffe0b5",
    sunIntensity: 1.5,
    sunPosition: [-10, 16, 12],
    sky: "#fff4e4",
    ground: "#cdb9a0",
    fill: 1.0,
    glass: "#d6ecf7",
    glassGlow: 0.4,
    backdrop: "radial-gradient(ellipse at 50% 38%, #fbf4ea 0%, #efe5d7 55%, #e3d6c4 100%)",
  },
  day: {
    sun: "#fff0d9",
    sunIntensity: 1.7,
    sunPosition: [12, 22, 10],
    sky: "#fdf6ec",
    ground: "#c9b8a0",
    fill: 1.05,
    glass: "#bfe0f5",
    glassGlow: 0.35,
    backdrop: "radial-gradient(ellipse at 50% 38%, #f9f3e9 0%, #ede3d4 55%, #e0d2bf 100%)",
  },
  evening: {
    sun: "#ffb36b",
    sunIntensity: 1.35,
    sunPosition: [20, 11, 8],
    sky: "#ffe7cf",
    ground: "#b39a86",
    fill: 0.9,
    glass: "#f6b98a",
    glassGlow: 0.55,
    backdrop: "radial-gradient(ellipse at 50% 38%, #f8e8d8 0%, #ecd3bd 55%, #dcbfa6 100%)",
  },
  night: {
    // Dark outside, lamps on inside: a cool moon and a warm indoor fill.
    sun: "#9fb3ea",
    sunIntensity: 0.55,
    sunPosition: [8, 20, 6],
    sky: "#ffe9cc",
    ground: "#6f6070",
    fill: 0.95,
    glass: "#2f4675",
    glassGlow: 0.6,
    backdrop: "radial-gradient(ellipse at 50% 38%, #ece6e3 0%, #d8cfd2 55%, #c4bac2 100%)",
  },
};
const phaseAt = (hour: number): Phase =>
  hour >= 6 && hour < 10 ? "morning" : hour >= 10 && hour < 17 ? "day" : hour >= 17 && hour < 20 ? "evening" : "night";

/**
 * The current day phase, re-checked every 5 minutes (a re-render only when the phase changes).
 * The boss can pin one phase in Settings (this browser only) or for one visit with `?phase=day`.
 */
function useDayPhase(): Phase {
  const [phase, setPhase] = useState(() => phaseAt(new Date().getHours()));
  const pin = useStore((s) => s.lightPin);
  useEffect(() => {
    const timer = setInterval(() => setPhase(phaseAt(new Date().getHours())), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  return pin === "auto" ? phase : pin;
}

export function OfficeScene({ snapshot }: { snapshot: Snapshot }) {
  // Snapshots arrive many times a second; only rebuild the floor plan when it actually changes,
  // otherwise every worker would be re-placed on each update.
  const floorPlanKey = snapshot.departments.map((d) => `${d.id}:${d.headcount}`).join("|");
  const layout = useMemo(() => buildLayout(snapshot.departments), [floorPlanKey]);
  const [contextLost, setContextLost] = useState(false);
  const phase = useDayPhase();
  const look = PHASES[phase];
  const showColliders = useStore((s) => s.showColliders);
  const showFps = useStore((s) => s.showFps);
  const walking = useStore((s) => s.viewMode === "walk");
  // Which zones have someone working, as a sorted string (unchanged snapshots give the same value, so
  // Exterior's memo holds). The façade lights those teams' windows at night.
  const busy = [...new Set(snapshot.tasks.filter((t) => t.status === "working").map((t) => t.departmentId))]
    .sort()
    .concat(snapshot.manager.busy ? ["boss"] : [])
    .join(",");
  // Approvals waiting: the manager's ✋ in the room and (round 11) the pin over the roof outside. Primitives, so memo holds.
  const asking = snapshot.tasks.filter((t) => t.approval).length;
  const askId = snapshot.tasks.find((t) => t.approval)?.id;
  // The "＋ New department" label only shows when its row is framed by the camera (or the office is empty).
  const showPlaceholderLabel = useMemo(() => {
    const row = layout.placeholder?.center[1];
    return (
      !layout.departments.size ||
      [layout.boss, ...[...layout.departments.values()].map((d) => d.zone)].some((z) => z.center[1] === row)
    );
  }, [layout]);

  // The GPU can drop the context (driver reset, too many tabs). Swap in a note instead of a blank canvas.
  if (contextLost) {
    return (
      <div className="panel-error panel-error--center" role="alert">
        <strong>3D view paused.</strong>
        <small className="muted">The board and chat still work.</small>
        <button className="btn btn--ghost btn--sm" onClick={() => setContextLost(false)}>
          Reload 3D
        </button>
      </div>
    );
  }

  return (
    <Canvas
      className="scene-canvas"
      style={{ background: look.backdrop }}
      shadows
      dpr={[1, 2]}
      gl={{ alpha: true }}
      camera={{ fov: CAMERA_FOV, near: 0.5, far: 300 }}
      onCreated={({ gl }) =>
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          setContextLost(true);
        })
      }
      // A click on the floor or walls (not a drag) closes the task card.
      onPointerMissed={() => useStore.getState().selectTask(null)}
    >
      {/* No clear colour: the warm gradient behind the transparent canvas shows through. */}
      <hemisphereLight args={[look.sky, look.ground, look.fill]} />
      <Sun layout={layout} look={look} />
      {walking ? (
        <Suspense fallback={null}>
          <WalkControls layout={layout} />
        </Suspense>
      ) : (
        <CameraRig layout={layout} />
      )}
      <Room layout={layout} look={look} />
      <Exterior layout={layout} name={snapshot.settings.companyName} walking={walking} phase={phase} innerGlass={look.glass} busy={busy} asking={asking} askId={askId} />
      <BossOffice
        zone={layout.boss}
        walking={walking}
        showManager={snapshot.settings.aiOffice}
        busy={snapshot.manager.busy}
        activity={snapshot.manager.activity}
        asking={asking}
        firstAskingId={askId}
      />
      {snapshot.departments.map((department) => (
        <DepartmentZone key={department.id} department={department} layout={layout} tasks={snapshot.tasks} />
      ))}
      {layout.placeholder &&
        (snapshot.settings.aiOffice ? (
          <PlaceholderZone
            zone={layout.placeholder}
            empty={!snapshot.departments.length}
            showLabel={showPlaceholderLabel}
          />
        ) : (
          <ClaudeCodePlaceholder
            zone={layout.placeholder}
            connected={snapshot.claudeCode.hooksInstalled || snapshot.claudeCode.lastEventAt !== null}
          />
        ))}
      <Workers snapshot={snapshot} layout={layout} />
      {showColliders && (
        <Suspense fallback={null}>
          <ColliderDebug layout={layout} />
        </Suspense>
      )}
      {showFps && (
        <Suspense fallback={null}>
          <FpsDebug />
        </Suspense>
      )}
    </Canvas>
  );
}

/** The orbit view the boss left for walk mode, keyed on the framing, so V comes back to the same angle. */
let lastOrbit: { key: string; position: Vector3; target: Vector3 } | null = null;

/** Frames the occupied part of the office whenever its footprint changes, then leaves the camera to the user. */
function CameraRig({ layout }: { layout: OfficeLayout }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useRef<OrbitControlsImpl>(null);
  // 0, not 1: walk mode sets --label-boost to 0.5, and the first frame back must always rewrite it.
  const boost = useRef(0);
  const { minX, maxX, minZ, maxZ } = layout.focus;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  // Zooming out is still limited by the whole room, so the boss can always see every wall.
  const room = layout.bounds;
  const roomSize = Math.max(room.maxX - room.minX, (room.maxZ - room.minZ) * 1.3);
  // Narrow viewports (phones, a squeezed middle column) need the camera further back.
  const { distance, fit: roundedFit } = framing(layout, aspect);
  const key = `${centerX}|${centerZ}|${distance}`;

  useEffect(() => {
    // Coming back from walk mode, the first render still sees the walk camera (drei puts the office camera
    // back in a layout effect a moment later). Wait for that; this effect runs again with it.
    if (camera.userData.walk) return;
    const target = controls.current?.target;
    if (lastOrbit?.key === key) {
      // Back from walk mode with the same floor plan: the boss's own angle, not the default framing.
      camera.position.copy(lastOrbit.position);
      target?.copy(lastOrbit.target);
    } else {
      const [dx, dy, dz] = FRAMING_DIR;
      camera.position.set(centerX + distance * dx, distance * dy, centerZ + distance * dz);
      target?.set(centerX, 0, centerZ);
    }
    lastOrbit = null;
    // ?view=outside: start 1.8× further back, past the outside-view threshold (Exterior), once. Here, after
    // the framing, so a re-frame can't cancel it.
    if (useStore.getState().startOutside) {
      if (target) camera.position.sub(target).multiplyScalar(1.8).add(target);
      useStore.setState({ startOutside: false });
    }
    controls.current?.update();
  }, [camera, distance, centerX, centerZ, key]);

  // Walk mode unmounts this rig: remember the angle to come back to.
  useEffect(
    () => () => {
      const target = controls.current?.target;
      if (target && !camera.userData.walk) lastOrbit = { key, position: camera.position.clone(), target: target.clone() };
    },
    [camera, key],
  );

  // drei's <Html> shrinks labels with distance (scale = distanceFactor / (2·tan(fov/2)·d)). Far out, names
  // drop to ~7 px, so scale them back up via a CSS variable. Written straight to the DOM, not React state,
  // so orbiting never re-renders the scene.
  useFrame(() => {
    const target = controls.current?.target;
    if (!target) return;
    const d = camera.position.distanceTo(target);
    const scale = LABEL_DISTANCE_FACTOR / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360) * d);
    const next = Math.min(1.6, Math.max(1, 0.9 / scale));
    if (Math.abs(next - boost.current) > 0.02) {
      boost.current = next;
      document.documentElement.style.setProperty("--label-boost", next.toFixed(2));
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      minDistance={6}
      maxDistance={(roomSize * 2.5 + 10) * roundedFit}
      maxPolarAngle={Math.PI / 2.25}
    />
  );
}

/** The key light. Its shadow camera is fitted to the room (not ±40), so shadows stay crisp but soft. */
function Sun({ layout, look }: { layout: OfficeLayout; look: PhaseLook }) {
  const light = useRef<DirectionalLight>(null);
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  // The light looks at the origin (the room's centre); walls are 3 high, so leave a little slack.
  const half = Math.max(maxX - minX, maxZ - minZ) * 0.6 + 3;
  useLayoutEffect(() => {
    const cam = light.current?.shadow.camera;
    if (!cam) return;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
  }, [half]);
  return (
    <directionalLight
      ref={light}
      position={look.sunPosition}
      color={look.sun}
      intensity={look.sunIntensity}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.02}
    />
  );
}

/** Light oak planks, drawn once into a small canvas (no image files). One tile covers 4 × 4 m. */
let plankTexture: CanvasTexture | null = null;
function floorTexture(): CanvasTexture {
  if (plankTexture) return plankTexture;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const rows = 8; // 0.5 m planks
  const h = size / rows;
  const tones = ["#e2cba8", "#dcc39f", "#e6d0ae", "#d8bf9a", "#e0c8a4"];
  for (let r = 0; r < rows; r++) {
    // Staggered joints: each row's planks start at a different offset.
    const offset = ((r * 97) % 5) * (size / 5) * 0.6;
    for (let k = -1; k < 3; k++) {
      const x = offset + k * (size / 2);
      g.fillStyle = tones[(r * 3 + k + 5) % tones.length];
      g.fillRect(x, r * h, size / 2, h);
      g.fillStyle = "rgba(120, 88, 56, 0.35)";
      g.fillRect(x, r * h, 1.5, h); // end joint
    }
    g.fillStyle = "rgba(120, 88, 56, 0.4)";
    g.fillRect(0, r * h, size, 1.5); // long seam
    g.fillStyle = "rgba(255, 255, 255, 0.08)";
    g.fillRect(0, r * h + 2, size, 2); // soft highlight
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  plankTexture = tex;
  return tex;
}

const WAINSCOT_H = 0.95;

/** A wall's lower panel, rail and skirting, along x, in front of the wall face at z = 0. */
function WallTrim({ length }: { length: number }) {
  return (
    <group>
      <mesh position={[0, WAINSCOT_H / 2, 0.02]} receiveShadow>
        <boxGeometry args={[length, WAINSCOT_H, 0.04]} />
        <meshStandardMaterial color="#dcc7aa" />
      </mesh>
      <mesh position={[0, WAINSCOT_H, 0.035]}>
        <boxGeometry args={[length, 0.05, 0.07]} />
        <meshStandardMaterial color="#fbf8f2" />
      </mesh>
      <mesh position={[0, 0.06, 0.045]}>
        <boxGeometry args={[length, 0.12, 0.05]} />
        <meshStandardMaterial color="#8f6a47" />
      </mesh>
    </group>
  );
}

function Room({ layout, look }: { layout: OfficeLayout; look: PhaseLook }) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const floorMap = useMemo(() => {
    const tex = floorTexture().clone(); // same canvas; own repeat per floor size
    tex.repeat.set(width / 4, depth / 4);
    tex.needsUpdate = true;
    return tex;
  }, [width, depth]);
  useEffect(() => () => floorMap.dispose(), [floorMap]);

  // Coffee corner, wall slots and side windows come from the layout (colliders read them too).
  const { kitchenX, wallSlots: slots, sideWindows } = layout;

  return (
    <group>
      <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={floorMap} roughness={0.85} />
      </mesh>
      <mesh position={[cx, -0.17, cz]}>
        <boxGeometry args={[width + 0.3, 0.3, depth + 0.3]} />
        <meshStandardMaterial color="#a88d6e" />
      </mesh>
      {/* Back and left walls only, so the camera can see in, like a dollhouse. */}
      <mesh position={[cx, WALL_H / 2, minZ - 0.1]} receiveShadow castShadow>
        <boxGeometry args={[width + 0.2, WALL_H, 0.2]} />
        <meshStandardMaterial color="#f6efe4" />
      </mesh>
      <mesh position={[minX - 0.1, WALL_H / 2, cz]} receiveShadow castShadow>
        <boxGeometry args={[0.2, WALL_H, depth + 0.2]} />
        <meshStandardMaterial color="#f1e9dc" />
      </mesh>
      {/* Wall tops, so the cut walls read as solid. */}
      <mesh position={[cx, WALL_H + 0.02, minZ - 0.1]}>
        <boxGeometry args={[width + 0.24, 0.04, 0.24]} />
        <meshStandardMaterial color="#8f6a47" />
      </mesh>
      <mesh position={[minX - 0.1, WALL_H + 0.02, cz]}>
        <boxGeometry args={[0.24, 0.04, depth + 0.24]} />
        <meshStandardMaterial color="#8f6a47" />
      </mesh>
      <group position={[cx, 0, minZ]}>
        <WallTrim length={width} />
      </group>
      <group position={[minX, 0, cz]} rotation={[0, Math.PI / 2, 0]}>
        <WallTrim length={depth} />
      </group>
      {slots.map(({ x, kind }, i) =>
        kind === "window" ? (
          <group key={i} position={[x, 1.85, minZ]}>
            <Window glass={look.glass} glow={look.glassGlow} />
          </group>
        ) : (
          <group key={i} position={[x, 1.8, minZ]}>
            <WallArt variant={i} />
          </group>
        ),
      )}
      {sideWindows.map((z) => (
        <group key={z} position={[minX, 1.85, z]} rotation={[0, Math.PI / 2, 0]}>
          <Window glass={look.glass} glow={look.glassGlow} />
        </group>
      ))}
      {kitchenX !== undefined && (
        <>
          <group position={[kitchenX, 0, minZ]}>
            <CoffeeCorner />
          </group>
          <group position={[kitchenX - 0.4, 2.25, minZ]}>
            <WallClock />
          </group>
        </>
      )}
      {layout.dividers.map((d, i) => (
        <group key={i} position={[d.position[0], 0, d.position[1]]}>
          {d.glass ? <GlassPartition length={d.length} /> : <Planter length={d.length} />}
        </group>
      ))}
      <group position={[minX + 0.8, 0, minZ + 0.8]}>
        <Plant scale={1.2} />
      </group>
      <group position={[maxX - 0.8, 0, minZ + 0.8]}>
        <Plant />
      </group>
      <group position={[minX + 0.8, 0, maxZ - 0.8]}>
        <Plant scale={0.9} />
      </group>
      <group position={[layout.door[0], 0, maxZ - 0.05]}>
        <DoorFrame />
      </group>
      <group position={[layout.cooler[0], 0, layout.cooler[1]]}>
        <WaterCooler />
      </group>
    </group>
  );
}

/** A rounded rectangle in the XY plane, cached per size (rugs of the same size share one geometry). */
const roundedRects = new Map<string, ShapeGeometry>();
function roundedRect(w: number, h: number, r: number): ShapeGeometry {
  const key = `${w}|${h}|${r}`;
  let geo = roundedRects.get(key);
  if (!geo) {
    const s = new Shape();
    const x = -w / 2;
    const y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    geo = new ShapeGeometry(s, 6);
    roundedRects.set(key, geo);
  }
  return geo;
}

const RUG_BORDER = 0.28;
const FLOOR_TONE = new Color("#d9c09c");
const CREAM = new Color("#fbf6ee");

/**
 * A zone's rug: a rounded border in the zone's colour around a lighter field of the same hue, both
 * opaque (R3F's ACES tone mapping washes out see-through tints). `ghost` is the dashed-look placeholder.
 */
function Rug({ zone, color, ghost, onClick }: { zone: Zone; color: string; ghost?: boolean; onClick?: () => void }) {
  const [border, field] = useMemo(() => {
    const base = new Color(color);
    // A pale department colour (lightness > 0.8) would melt into cream: mix less, and darken the border more.
    const pale = base.getHSL({ h: 0, s: 0, l: 0 }).l > 0.8;
    return [
      `#${base.clone().lerp(FLOOR_TONE, pale ? 0.25 : 0.15).getHexString()}`,
      `#${base.clone().lerp(CREAM, pale ? 0.4 : 0.68).getHexString()}`,
    ];
  }, [color]);
  const handlers = onClick
    ? {
        onClick: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          onClick();
        },
        onPointerOver: () => void (document.body.style.cursor = "pointer"),
        onPointerOut: () => void (document.body.style.cursor = ""),
      }
    : {};
  return (
    <group position={[zone.center[0], 0, zone.center[1]]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh position={[0, 0, 0.01]} geometry={roundedRect(ZONE_W, ZONE_D, 0.6)} receiveShadow {...handlers}>
        <meshStandardMaterial color={ghost ? "#cbbfa9" : border} transparent={ghost} opacity={ghost ? 0.5 : 1} />
      </mesh>
      <mesh
        position={[0, 0, 0.016]}
        geometry={roundedRect(ZONE_W - RUG_BORDER * 2, ZONE_D - RUG_BORDER * 2, 0.4)}
        receiveShadow
        {...handlers}
      >
        <meshStandardMaterial color={ghost ? "#fbf8f2" : field} transparent={ghost} opacity={ghost ? 0.55 : 1} />
      </mesh>
    </group>
  );
}

function BossOffice({
  zone,
  walking,
  showManager,
  busy,
  activity,
  asking,
  firstAskingId,
}: {
  zone: Zone;
  walking: boolean; // the boss is up and walking: the chair stays, the seated boss and nameplate go
  showManager: boolean;
  busy: boolean;
  activity: string | null;
  asking: number; // tasks waiting for the boss's OK
  firstAskingId: string | undefined;
}) {
  const bossMotion = useRef<Motion>({ walking: false, sitting: true, typing: false });
  const managerMotion = useRef<Motion>({ walking: false, sitting: false, typing: false });
  const [cx, cz] = zone.center;
  const openChat = useStore((s) => s.setChatOpen);
  const selectTask = useStore((s) => s.selectTask);
  // While idle, the manager points the boss at approvals waiting on them.
  const nagging = !busy && asking > 0;
  return (
    <group>
      <Rug zone={zone} color="#9d86c0" />
      <group position={[cx - 1.4, 0, cz - 2.6]}>
        <Bookshelf />
      </group>
      <group position={[cx + 2.6, 0, cz - 2.4]}>
        <Plant scale={1.1} />
      </group>
      {/* The boss's big desk */}
      <group position={[cx - 0.6, 0, cz + 0.2]}>
        <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
          <boxGeometry args={[2.4, 0.08, 1.1]} />
          <meshStandardMaterial color="#6f4e37" />
        </mesh>
        <mesh position={[0, 0.36, 0.3]} castShadow>
          <boxGeometry args={[2.3, 0.72, 0.08]} />
          <meshStandardMaterial color="#5a3f2c" />
        </mesh>
        <mesh position={[0.6, 0.8, -0.1]}>
          <boxGeometry args={[0.3, 0.04, 0.22]} />
          <meshStandardMaterial color="#fbfaf7" />
        </mesh>
      </group>
      <group position={[cx - 0.6, 0, cz - 0.6]}>
        <Chair color="#2f3540" />
        {!walking && (
          <>
            <Person shirt="#2f3a56" skin="#e0ac8a" hair="#2b1d14" tie="#c0392b" motion={bossMotion} />
            <Html position={[0, 2.1, 0]} center distanceFactor={14} zIndexRange={BUBBLE_Z}>
              <div className="nameplate nameplate--boss">You · Boss</div>
            </Html>
          </>
        )}
      </group>
      {/* The manager stands beside the desk; their bubble shows what they're doing right now. */}
      {showManager && (
        <group position={[cx + 1.5, 0, cz + 0.4]} rotation={[0, -0.6, 0]}>
          <Person shirt="#5b8c85" skin="#c68863" hair="#121212" longHair motion={managerMotion} />
          <Html position={[0, 2.1, 0]} center distanceFactor={14} zIndexRange={BUBBLE_Z}>
            <div
              className={`bubble bubble--manager${nagging ? " bubble--ask" : ""}`}
              onClick={() => (nagging && firstAskingId ? selectTask(firstAskingId) : openChat(true))}
            >
              <span className="bubble__name">Manager</span>
              <span className="bubble__text">
                {busy ? (activity ?? "Thinking…") : nagging ? `✋ ${asking} need${asking === 1 ? "s" : ""} your OK` : "Ready for orders"}
              </span>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

const DepartmentZone = memo(function DepartmentZone({
  department,
  layout,
  tasks,
}: {
  department: Department;
  layout: OfficeLayout;
  tasks: Task[];
}) {
  const placement = layout.departments.get(department.id);
  const openModal = useStore((s) => s.openModal);
  if (!placement) return null;
  const { zone, desks } = placement;
  const mine = tasks.filter((t) => t.departmentId === department.id);
  const working = mine.filter((t) => t.status === "working");
  const queued = mine.filter((t) => t.status === "queued").length;
  const busyDesks = new Set(working.map((t) => t.deskIndex));
  const open = () => openModal({ type: "department", departmentId: department.id });

  return (
    <group>
      <Rug zone={zone} color={department.color} onClick={open} />
      <Html position={[zone.center[0], 2.3, zone.center[1] - ZONE_D / 2 + 0.3]} center distanceFactor={16} zIndexRange={SIGN_Z}>
        <button
          className="zone-sign"
          style={{ "--zone": department.color } as CSSProperties}
          onClick={open}
          title={department.codeAccess ? "Workers may change Siverse's own code" : undefined}
        >
          <strong style={{ color: inkFor(department.color) }}>
            {department.source === "claude-code" ? `⚡ ${department.name}` : department.name}
          </strong>
          <span>
            {department.source === "claude-code"
              ? `Claude Code · ${working.length} at work`
              : `${working.length}/${department.headcount} working${queued ? ` · ${queued} waiting` : ""}${department.webAccess ? " · 🌐" : ""}${department.codeAccess ? " · 🔧" : ""}`}
          </span>
        </button>
      </Html>
      {desks.map((desk, i) => (
        <group key={i}>
          <group position={[desk.position[0], 0, desk.position[1]]}>
            <Desk busy={busyDesks.has(i)} accent={department.color} />
          </group>
          <group position={[desk.seat[0], 0, desk.seat[1] - 0.12]}>
            <Chair color="#4a4f5a" />
          </group>
        </group>
      ))}
      <group position={[zone.center[0] - ZONE_W / 2 + 0.6, 0, zone.front - 0.6]}>
        <InTray count={queued} color={department.color} />
      </group>
    </group>
  );
});

function PlaceholderZone({ zone, empty, showLabel }: { zone: Zone; empty: boolean; showLabel: boolean }) {
  const openModal = useStore((s) => s.openModal);
  return (
    <group>
      <Rug zone={zone} color="#ffffff" ghost onClick={() => openModal({ type: "department", departmentId: null })} />
      {showLabel && (
        <Html position={[zone.center[0], 0.6, zone.center[1]]} center distanceFactor={16} zIndexRange={SIGN_Z}>
          <button className="zone-placeholder" onClick={() => openModal({ type: "department", departmentId: null })}>
            {empty ? "＋ Open your first department" : "＋ New department"}
          </button>
        </Html>
      )}
    </group>
  );
}

function ClaudeCodePlaceholder({ zone, connected }: { zone: Zone; connected: boolean }) {
  const setChatTab = useStore((s) => s.setChatTab);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const open = () => {
    setChatTab("claude-code");
    setChatOpen(true);
  };
  return (
    <group>
      <Rug zone={zone} color="#ffffff" ghost onClick={open} />
      <Html position={[zone.center[0], 0.6, zone.center[1]]} center distanceFactor={16} zIndexRange={SIGN_Z}>
        <button className="zone-placeholder" onClick={open}>
          {connected ? "⚡ Next Claude Code project goes here" : "⚡ Connect Claude Code"}
        </button>
      </Html>
    </group>
  );
}

function Workers({ snapshot, layout }: { snapshot: Snapshot; layout: OfficeLayout }) {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const seenFailed = useStore((s) => s.seenFailed);

  // Permanent employees are always in the office (StaffMember); temps come and go with their task.
  // No clock tick needed: a leaving temp hides itself once it's out the door.
  const now = Date.now();
  // The ring follows the selected task's owner, even once it's finished and they're idle.
  const selectedOwner = snapshot.tasks.find((t) => t.id === selectedTaskId)?.employeeId;
  const staff = new Set(snapshot.employees.map((e) => e.id));
  const temps = snapshot.tasks.filter(
    (t) =>
      t.startedAt &&
      !(t.employeeId && staff.has(t.employeeId)) &&
      (t.status === "working" || (t.finishedAt && now - t.finishedAt < LEAVING_WINDOW_MS)),
  );
  return (
    <>
      {snapshot.employees.map((employee) => {
        const department = snapshot.departments.find((d) => d.id === employee.departmentId);
        if (!department) return null;
        const task = snapshot.tasks.find((t) => t.employeeId === employee.id && t.status === "working");
        let lastTask: Task | undefined;
        let waiting = 0;
        for (const t of snapshot.tasks) {
          if (t.employeeId !== employee.id) continue;
          if (t.status === "queued") waiting++;
          else if ((t.status === "done" || t.status === "failed") && t.finishedAt) {
            if (!lastTask || t.finishedAt > (lastTask.finishedAt ?? 0)) lastTask = t;
          }
        }
        // Same rule as the board's "Needs you" (TaskBoard.tsx), so the two never disagree. A boolean, for memo.
        const unseenFailure =
          lastTask?.status === "failed" &&
          now - (lastTask.finishedAt ?? 0) < NEEDS_YOU_WINDOW_MS &&
          !seenFailed.includes(lastTask.id);
        return (
          <StaffMember
            key={employee.id}
            employee={employee}
            department={department}
            layout={layout}
            task={task}
            lastTask={lastTask}
            waiting={waiting}
            unseenFailure={unseenFailure}
            selected={employee.id === selectedOwner}
            onSelect={selectTask}
          />
        );
      })}
      {temps.map((task) => {
        const department = snapshot.departments.find((d) => d.id === task.departmentId);
        if (!department) return null;
        return (
          <Worker
            key={task.id}
            task={task}
            department={department}
            layout={layout}
            selected={task.id === selectedTaskId}
            onSelect={selectTask}
          />
        );
      })}
    </>
  );
}
