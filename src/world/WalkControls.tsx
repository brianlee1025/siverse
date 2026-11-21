import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import type { PerspectiveCamera as PerspectiveCameraImpl } from "three";
import { walkSpot, ZONE_D, ZONE_W, type OfficeLayout } from "../layout";
import { useStore, type WalkTarget } from "../store";
import { motion } from "../motion";
import { buildColliders, moveWithCollisions, type Box } from "./colliders";
import { cityFor } from "./cityGrid";
import { citySeedFor } from "./rng";
import { isTyping } from "./WalkHud";

// Roadmap step 2a-ii: first-person walking (lazy chunk, loaded on the first walk). Its own camera, so the
// office view's camera is never moved; drei puts that one back on unmount. Safety rules (R7): an approval,
// a window or a task card releases the pointer lock, and keys typed into fields or held across Alt-Tab
// never walk.

const EYE = 1.6;
const WALK = 1.4; // m/s
const RUN = 3;
const TURN = 1.8; // rad/s, ← → (× the look speed setting, kept within 0.8–3)
const LOOK = 0.0022; // rad per mouse pixel (× the look speed setting, store.walkPrefs)
const PITCH_MAX = 1.4;
const STEP = 0.1; // sub-step length, so a fast frame can't jump through a thin box

// Step 2b-i, "E to use": the boss's chair sits at (cx − 0.6, cz − 0.6) behind the desk; coming round the
// desk's end gets you to 1.45 m, so 1.6. A zone counts with half the corridor in front (0.9) and 0.4 at
// the sides; zones never overlap (1.8 m gaps), so you stand in at most one.
const DESK_REACH = 1.6;
const ZONE_FRONT_MARGIN = 0.9;
const ZONE_SIDE_MARGIN = 0.4;

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

const askCount = (s: ReturnType<typeof useStore.getState>) => s.snapshot?.tasks.filter((t) => t.approval).length ?? 0;

/** Step 2b-ii-a: where the boss last stood, kept in memory only (a reload starts at the desk). Tied to the
 * layout object: OfficeScene keeps it until the floor plan changes, so a hire falls back to the spawn. */
let lastWalk: { layout: OfficeLayout; x: number; z: number; yaw: number; pitch: number } | null = null;

export default function WalkControls({ layout, name }: { layout: OfficeLayout; name: string }) {
  const cam = useRef<PerspectiveCameraImpl>(null);
  // Round 13 (R6): look speed, field of view, invert up/down. Read through a ref so the [gl] effect never re-runs.
  const prefs = useStore((s) => s.walkPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // Round 13 (R5): the 📍 chip names the street you stand on. One seed formula (citySeedFor), as ?plan.
  // City round: the whole grid (the same cached one City draws) gives the names, the ground and the colliders.
  const citySeed = useStore((s) => s.citySeed);
  const grid = useMemo(() => cityFor(layout, citySeedFor(name, citySeed)), [layout, name, citySeed]);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const placeKey = useRef<string | null>("");
  const gl = useThree((s) => s.gl);
  const setEvents = useThree((s) => s.setEvents);
  // The office's own boxes (no curb ring) + the city's (≈ 1,300). Each frame only tests the boxes within 25 m,
  // re-picked after every 5 m walked, so a step costs the same as before the city.
  const allBoxes = useMemo(() => [...buildColliders(layout, false), ...grid.colliders], [layout, grid]);
  const near = useRef<{ x: number; z: number; boxes: Box[] } | null>(null);
  const nearBoxes = (x: number, z: number) => {
    const n = near.current;
    if (n && Math.hypot(x - n.x, z - n.z) < 5) return n.boxes;
    const r = 25;
    const boxes = allBoxes.filter((b) => b.maxX > x - r && b.minX < x + r && b.maxZ > z - r && b.minZ < z + r);
    near.current = { x, z, boxes };
    return boxes;
  };
  useEffect(() => void (near.current = null), [allBoxes]);
  const floorY = useRef(0); // eased: down the curb to the street (STREET_Y) and back up
  const held = useRef(new Set<string>());
  const look = useRef({ yaw: 0, pitch: 0 });
  const onStreet = useRef(false);
  const dragging = useRef(false);
  const targetKey = useRef("");

  // Spawn beside the boss's desk at eye height, facing the middle of the departments.
  const spawn = useMemo(() => {
    const [bx, bz] = layout.boss.center;
    const x = bx + 0.9;
    const z = bz + 1.6;
    const { minX, maxX, minZ, maxZ } = layout.focus;
    const tx = (minX + maxX) / 2;
    const tz = (minZ + maxZ) / 2;
    return { x, z, yaw: Math.atan2(-(tx - x), -(tz - z)) };
  }, [layout]);
  const spawnRef = useRef(spawn); // for R, whose key effect only depends on [gl]
  spawnRef.current = spawn;
  // Step 2b-ii-b, "Walk there": the department's corridor spot, or null if it's gone (closed, or hidden while
  // the AI office is off). Read through a ref in the [gl] effect, which would otherwise keep a stale layout.
  const spotFor = (to: { departmentId: string } | null) => {
    const zone = to && layout.departments.get(to.departmentId)?.zone;
    return zone ? walkSpot(zone) : null;
  };
  const spotForRef = useRef(spotFor);
  spotForRef.current = spotFor;
  const spawned = useRef(false);
  useLayoutEffect(() => {
    const c = cam.current;
    if (!c || spawned.current) return;
    spawned.current = true;
    c.userData.walk = true; // CameraRig waits until this camera is gone (OfficeScene.tsx)
    c.rotation.order = "YXZ";
    // "Walk there" first, then back where the boss left off (unless the floor plan changed since), then the
    // desk. A box you start inside doesn't hold you (colliders.ts), and the first frame's inside check sets
    // scene--street on the sidewalk.
    const walkTo = useStore.getState().walkTo;
    const to = spotForRef.current(walkTo);
    if (walkTo) useStore.setState({ walkTo: null }); // used (or gone): a later V doesn't re-teleport
    const from = lastWalk?.layout === layout ? lastWalk : null;
    const pose = to ?? from ?? { ...spawn, pitch: 0 };
    c.position.set(pose.x, EYE, pose.z);
    look.current = { yaw: pose.yaw, pitch: pose.pitch };
    c.rotation.set(pose.pitch, pose.yaw, 0);
  }, [spawn, layout]);

  // Save the pose on leaving (or when a hire swaps the layout). The camera is captured now: the ref can be
  // detached by the time an unmount's cleanup runs.
  useEffect(() => {
    const c = cam.current;
    return () => {
      if (c) lastWalk = { layout, x: c.position.x, z: c.position.z, yaw: look.current.yaw, pitch: look.current.pitch };
    };
  }, [layout]);

  // No R3F pointer events while walking: a click to lock the pointer must not open a rug's department
  // window or close the task card. Labels shrink: at FOV 70 a bubble 4 m away is ≈ 2.5× its office size.
  useEffect(() => {
    setEvents({ enabled: false });
    document.documentElement.style.setProperty("--label-boost", "0.5");
    const canvas = gl.domElement.closest(".scene-canvas");
    return () => {
      setEvents({ enabled: true });
      canvas?.classList.remove("scene--street");
      useStore.setState({ walkTarget: null, walkPlace: null });
      // --label-boost is rewritten by CameraRig on its first frame (its boost ref starts at 0).
    };
  }, [setEvents, gl]);

  // Keys, mouse look, and the rules that keep walking from hiding anything.
  useEffect(() => {
    const canvas = gl.domElement;
    const keys = held.current;
    const locked = () => document.pointerLockElement === canvas;
    const unlock = () => locked() && document.exitPointerLock();

    const onDown = (e: KeyboardEvent) => {
      if (e.code === "KeyE") {
        const s = useStore.getState();
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || s.modal || s.selectedTaskId) return;
        const t = s.walkTarget;
        if (t?.kind === "department") s.openModal({ type: "department", departmentId: t.id }); // the lock is released below
        else if (t?.kind === "desk") {
          document.exitPointerLock?.();
          s.setViewMode("office"); // CameraRig restores the orbit pose the boss left (lastOrbit)
        }
        return;
      }
      // Step 2b-ii-a: R takes you back beside your desk. Same guards as E, so Ctrl+R still reloads.
      if (e.code === "KeyR") {
        const s = useStore.getState();
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || s.modal || s.selectedTaskId) return;
        const c = cam.current;
        const home = spawnRef.current;
        if (c) c.position.set(home.x, EYE, home.z);
        look.current = { yaw: home.yaw, pitch: 0 };
        return;
      }
      if (!MOVE_KEYS.has(e.code) || e.ctrlKey || e.metaKey || isTyping(e.target) || useStore.getState().modal) return;
      keys.add(e.code);
      if (e.code.startsWith("Arrow")) e.preventDefault(); // no page scroll
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.code);
    const clear = () => keys.clear();
    const onVisibility = () => document.hidden && clear();
    // Drag to look where pointer lock is refused (the HUD then shows no lock layer, so drags reach the
    // canvas). R3F events are off, so a drag can't hit a rug.
    const onPress = (e: MouseEvent) => {
      if (e.button === 0 && !locked()) dragging.current = true;
    };
    const onRelease = () => (dragging.current = false);
    const onMouse = (e: MouseEvent) => {
      if (!locked() && !dragging.current) return;
      const l = look.current;
      const p = prefsRef.current;
      const k = LOOK * p.look;
      l.yaw -= e.movementX * k;
      l.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, l.pitch - e.movementY * k * (p.invertY ? -1 : 1)));
    };

    // R7: an ask arriving (count rises), a window or a task card opening all release the lock; a window
    // also drops the held keys. Done and failed toasts don't.
    let asks = askCount(useStore.getState());
    const unsubscribe = useStore.subscribe((s, prev) => {
      const now = askCount(s);
      if (now > asks) unlock();
      asks = now;
      if (s.modal && !prev.modal) {
        unlock();
        clear();
      }
      if (s.selectedTaskId && !prev.selectedTaskId) unlock();
      // "Walk there" while already walking: jump to the team. Clearing walkTo notifies again with null,
      // which the first check ignores.
      if (s.walkTo && s.walkTo !== prev.walkTo) {
        const to = spotForRef.current(s.walkTo);
        useStore.setState({ walkTo: null });
        const c = cam.current;
        if (to && c) {
          c.position.set(to.x, EYE, to.z);
          look.current = { yaw: to.yaw, pitch: to.pitch };
          clear(); // held keys don't carry over the jump
        }
      }
    });

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("mousemove", onMouse);
    canvas.addEventListener("mousedown", onPress);
    window.addEventListener("mouseup", onRelease);
    window.addEventListener("blur", onRelease);
    return () => {
      unsubscribe();
      canvas.removeEventListener("mousedown", onPress);
      window.removeEventListener("mouseup", onRelease);
      window.removeEventListener("blur", onRelease);
      onRelease();
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("mousemove", onMouse);
      clear();
      unlock();
    };
  }, [gl]);

  useFrame((_, rawDelta) => {
    const c = cam.current;
    if (!c) return;
    const delta = Math.min(rawDelta, 0.05);
    const k = held.current;
    const l = look.current;
    const turn = Math.min(3, Math.max(0.8, TURN * prefsRef.current.look));
    if (k.has("ArrowLeft")) l.yaw += turn * delta;
    if (k.has("ArrowRight")) l.yaw -= turn * delta;
    c.rotation.set(l.pitch, l.yaw, 0);

    const forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const strafe = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    if (forward || strafe) {
      const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN : WALK;
      const len = Math.hypot(forward, strafe);
      const sin = Math.sin(l.yaw);
      const cos = Math.cos(l.yaw);
      // Camera forward is −z rotated by yaw: (−sin, −cos); right is (cos, −sin).
      const mx = ((-sin * forward + cos * strafe) / len) * speed * delta;
      const mz = ((-cos * forward - sin * strafe) / len) * speed * delta;
      const steps = Math.max(1, Math.ceil(Math.hypot(mx, mz) / STEP));
      let x = c.position.x;
      let z = c.position.z;
      const boxes = nearBoxes(x, z);
      for (let i = 0; i < steps; i++) [x, z] = moveWithCollisions(x, z, mx / steps, mz / steps, boxes);
      c.position.x = x;
      c.position.z = z;
    }

    const { x, z } = c.position;
    // City round (roadmap 3a-ii-c): step down off the curb to the street and back up. A short ease (a cut under
    // reduced motion), so the 0.33 m step reads as a step, not a jolt.
    const ground = gridRef.current.groundAt(x, z);
    floorY.current = motion.reduced ? ground : floorY.current + (ground - floorY.current) * Math.min(1, delta * 14);
    c.position.y = floorY.current + EYE;
    // What E would use here. A store write only when it changes, not every frame.
    const [bx, bz] = layout.boss.center;
    let next: WalkTarget = null;
    if (Math.hypot(x - (bx - 0.6), z - (bz - 0.6)) < DESK_REACH) next = { kind: "desk" };
    else
      for (const [id, { zone }] of layout.departments) {
        const [zx, zz] = zone.center;
        if (Math.abs(x - zx) < ZONE_W / 2 + ZONE_SIDE_MARGIN && z > zz - ZONE_D / 2 && z < zone.front + ZONE_FRONT_MARGIN) {
          next = { kind: "department", id };
          break;
        }
      }
    const key = next ? (next.kind === "desk" ? "desk" : next.id) : "";
    if (key !== targetKey.current) {
      targetKey.current = key;
      useStore.setState({ walkTarget: next });
    }

    // Out on the sidewalk, the walls are between you and the labels: hide them (with a little hysteresis).
    const b = layout.bounds;
    const pad = onStreet.current ? -0.3 : 0.3;
    const inside = x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad;
    // Round 13 (R5): which street you're on, for the 📍 chip. A store write only on a change, like walkTarget.
    // The `inside` hysteresis already stops flicker at the door. City round: the grid names every street and
    // avenue (and corner) in the 3 × 3 blocks; the office's left strip is still its service passage.
    const passage = x < b.minX && x > b.minX - 4.6 && z > b.minZ - 0.2 && z < b.maxZ + 0.2;
    const place = inside ? null : passage ? "Service passage" : gridRef.current.placeAt(x, z);
    if (place !== placeKey.current) {
      placeKey.current = place;
      useStore.setState({ walkPlace: place });
    }
    if (inside === !onStreet.current) return;
    onStreet.current = !inside;
    gl.domElement.closest(".scene-canvas")?.classList.toggle("scene--street", !inside);
  });

  // No position prop: a hire re-builds the layout, and a prop would teleport the boss back to the spawn.
  // far 2500 (was 150): the city and its skyline; fog (City.tsx) fades the blocks long before that.
  return <PerspectiveCamera ref={cam} makeDefault fov={prefs.fov} near={0.1} far={2500} />;
}
