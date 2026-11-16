import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import type { PerspectiveCamera as PerspectiveCameraImpl } from "three";
import type { OfficeLayout } from "../layout";
import { useStore } from "../store";
import { buildColliders, moveWithCollisions } from "./colliders";
import { isTyping } from "./WalkHud";

// Roadmap step 2a-ii: first-person walking (lazy chunk, loaded on the first walk). Its own camera, so the
// office view's camera is never moved; drei puts that one back on unmount. Safety rules (R7): an approval,
// a window or a task card releases the pointer lock, and keys typed into fields or held across Alt-Tab
// never walk.

const EYE = 1.6;
const WALK = 1.4; // m/s
const RUN = 3;
const TURN = 1.8; // rad/s, ← →
const LOOK = 0.0022; // rad per mouse pixel
const PITCH_MAX = 1.4;
const STEP = 0.1; // sub-step length, so a fast frame can't jump through a thin box

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

const askCount = (s: ReturnType<typeof useStore.getState>) => s.snapshot?.tasks.filter((t) => t.approval).length ?? 0;

export default function WalkControls({ layout }: { layout: OfficeLayout }) {
  const cam = useRef<PerspectiveCameraImpl>(null);
  const gl = useThree((s) => s.gl);
  const setEvents = useThree((s) => s.setEvents);
  const boxes = useMemo(() => buildColliders(layout), [layout]);
  const held = useRef(new Set<string>());
  const look = useRef({ yaw: 0, pitch: 0 });
  const onStreet = useRef(false);

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
  const spawned = useRef(false);
  useLayoutEffect(() => {
    const c = cam.current;
    if (!c || spawned.current) return;
    spawned.current = true;
    c.userData.walk = true; // CameraRig waits until this camera is gone (OfficeScene.tsx)
    c.rotation.order = "YXZ";
    c.position.set(spawn.x, EYE, spawn.z);
    look.current = { yaw: spawn.yaw, pitch: 0 };
    c.rotation.set(0, spawn.yaw, 0);
  }, [spawn]);

  // No R3F pointer events while walking: a click to lock the pointer must not open a rug's department
  // window or close the task card. Labels shrink: at FOV 70 a bubble 4 m away is ≈ 2.5× its office size.
  useEffect(() => {
    setEvents({ enabled: false });
    document.documentElement.style.setProperty("--label-boost", "0.5");
    const canvas = gl.domElement.closest(".scene-canvas");
    return () => {
      setEvents({ enabled: true });
      canvas?.classList.remove("scene--street");
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
      if (!MOVE_KEYS.has(e.code) || e.ctrlKey || e.metaKey || isTyping(e.target) || useStore.getState().modal) return;
      keys.add(e.code);
      if (e.code.startsWith("Arrow")) e.preventDefault(); // no page scroll
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.code);
    const clear = () => keys.clear();
    const onVisibility = () => document.hidden && clear();
    const onMouse = (e: MouseEvent) => {
      if (!locked()) return;
      const l = look.current;
      l.yaw -= e.movementX * LOOK;
      l.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, l.pitch - e.movementY * LOOK));
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
    });

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("mousemove", onMouse);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("mousemove", onMouse);
      clear();
      unlock();
    };
  }, [gl]);

  // Dev only: draw calls once, 2 s in (the round-8 change log asks for office vs walk).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = setTimeout(() => console.info(`[walk] draw calls: ${gl.info.render.calls}`), 2000);
    return () => clearTimeout(t);
  }, [gl]);

  useFrame((_, rawDelta) => {
    const c = cam.current;
    if (!c) return;
    const delta = Math.min(rawDelta, 0.05);
    const k = held.current;
    const l = look.current;
    if (k.has("ArrowLeft")) l.yaw += TURN * delta;
    if (k.has("ArrowRight")) l.yaw -= TURN * delta;
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
      for (let i = 0; i < steps; i++) [x, z] = moveWithCollisions(x, z, mx / steps, mz / steps, boxes);
      c.position.set(x, EYE, z);
    }

    // Out on the sidewalk, the walls are between you and the labels: hide them (with a little hysteresis).
    const b = layout.bounds;
    const pad = onStreet.current ? -0.3 : 0.3;
    const { x, z } = c.position;
    const inside = x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad;
    if (inside === !onStreet.current) return;
    onStreet.current = !inside;
    gl.domElement.closest(".scene-canvas")?.classList.toggle("scene--street", !inside);
  });

  // No position prop: a hire re-builds the layout, and a prop would teleport the boss back to the spawn.
  return <PerspectiveCamera ref={cam} makeDefault fov={70} near={0.1} far={150} />;
}
