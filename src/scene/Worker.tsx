import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Vector3, type Group } from "three";
import type { Department, Employee, Task } from "../../shared/types";
import {
  aisle,
  BUBBLE_Z,
  DESK_COLS,
  floorRoute,
  homeSpots,
  inZone,
  pathToSeat,
  strollSpots,
  type OfficeLayout,
  type Vec2,
} from "../layout";
import { inkFor } from "../colors";
import { useStore } from "../store";
import { lookFor, Person, type Motion } from "./Person";

const WALK_SPEED = 2.6; // units per second
const ARRIVAL_WINDOW_MS = 5000; // tasks started more recently than this walk in from the door

/** Bubbles over the middle desk column sit higher, so neighbours' bubbles don't overlap. */
const bubbleHeight = (deskIndex: number) => 2.05 + (deskIndex % DESK_COLS === 1 ? 0.5 : 0);

interface WorkerProps {
  task: Task;
  department: Department;
  layout: OfficeLayout;
  selected: boolean;
  onSelect: (taskId: string) => void;
}

/** Moves a group one frame along its waypoints. Returns true while there is still somewhere to go. */
function walk(g: Group, nav: { waypoints: Vector3[]; index: number }, delta: number): boolean {
  if (nav.index >= nav.waypoints.length) return false;
  const target = nav.waypoints[nav.index];
  const toTarget = target.clone().sub(g.position);
  const distance = toTarget.length();
  const step = WALK_SPEED * Math.min(delta, 0.05);
  if (distance <= step) {
    g.position.copy(target);
    nav.index++;
  } else {
    g.position.addScaledVector(toTarget.normalize(), step);
    g.rotation.y = Math.atan2(toTarget.x, toTarget.z);
  }
  return true;
}

function pose(m: Motion, state: "walking" | "typing" | "sitting" | "standing") {
  m.walking = state === "walking";
  m.sitting = state === "typing" || state === "sitting";
  m.typing = state === "typing";
}

/** A temp: walks in from the door for one task, works at a free desk, then walks out again. */
export const Worker = memo(function Worker({ task, department, layout, selected, onSelect }: WorkerProps) {
  const placement = layout.departments.get(department.id);
  const desk = placement?.desks[task.deskIndex ?? 0] ?? placement?.desks[0];
  const leaving = task.status !== "working";

  const route = useMemo(
    () => (placement && desk ? pathToSeat(layout, placement.zone, desk.seat).map(([x, z]) => new Vector3(x, 0, z)) : []),
    [layout, placement, desk],
  );

  const group = useRef<Group>(null);
  const motion = useRef<Motion>({ walking: false, sitting: false, typing: false });
  const nav = useRef<{ waypoints: Vector3[]; index: number } | null>(null);
  const [gone, setGone] = useState(false);
  // Claude Code subagents share names like "Explore", so give each one its own look.
  const seed = task.source === "claude-code" ? task.id : (task.workerName ?? task.id);
  const look = useMemo(() => lookFor(seed), [seed]);

  // Place the worker before the first paint: walking in from the door, or already seated.
  useLayoutEffect(() => {
    const g = group.current;
    if (!g || !route.length) return;
    const seat = route[route.length - 1];
    const fresh = Date.now() - (task.startedAt ?? 0) < ARRIVAL_WINDOW_MS;
    if (!leaving && fresh) {
      g.position.copy(route[0]);
      nav.current = { waypoints: route, index: 1 };
    } else {
      g.position.copy(seat);
    }
    // Runs once per route; later status changes are handled by the effect below.
  }, [route]);

  useEffect(() => {
    if (leaving) nav.current = { waypoints: [...route].reverse(), index: 0 };
  }, [leaving, route]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g || gone) return;
    if (nav.current && walk(g, nav.current, delta)) {
      pose(motion.current, "walking");
      return;
    }
    if (leaving) {
      setGone(true);
      return;
    }
    // Seated at the desk, facing the monitor (+z).
    pose(motion.current, "typing");
    g.rotation.y = 0;
  });

  if (gone || !placement || !desk) return null;

  const asking = Boolean(task.approval);
  const failed = task.status === "failed";
  const bubble = asking
    ? "✋ Needs your OK"
    : task.status === "working"
      ? task.activity.at(-1)
      : task.status === "done"
        ? "✅ Done!"
        : failed
          ? "⚠️ Couldn't finish"
          : "🚪 Heading out";

  return (
    <group
      ref={group}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect(task.id);
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <Person shirt={department.color} skin={look.skin} hair={look.hair} longHair={look.longHair} motion={motion} />
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.42, 0.52, 32]} />
          <meshBasicMaterial color={department.color} />
        </mesh>
      )}
      <Html position={[0, bubbleHeight(task.deskIndex ?? 0), 0]} center distanceFactor={14} zIndexRange={BUBBLE_Z}>
        <div
          className={`bubble${asking ? " bubble--ask" : failed ? " bubble--failed" : ""}${selected ? " bubble--selected" : ""}`}
          onClick={() => onSelect(task.id)}
        >
          <span className="bubble__name" style={{ color: inkFor(department.color) }}>
            {task.workerName}
          </span>
          {bubble && <span className="bubble__text">{bubble}</span>}
        </div>
      </Html>
    </group>
  );
});

const CHILL_CHANCE = 0.35; // when free, how often they go and sit at their own desk instead of strolling
const HOME_CHANCE = 0.7; // when strolling, how often they stay in front of their own zone
const between = (min: number, max: number) => min + Math.random() * (max - min);
const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;

interface StaffMemberProps {
  employee: Employee;
  department: Department;
  layout: OfficeLayout;
  task: Task | undefined; // what they are working on right now
  lastTask: Task | undefined; // their latest finished (done or failed) task
  waiting: number; // their tasks still in the queue
  selected: boolean;
  onSelect: (taskId: string) => void;
}

const DONE_MOMENT_MS = 15_000; // how long "✅ Done: …" stays up after a task finishes
const shorten = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A permanent employee is always in the office. With a task they go to their own desk and work.
 * Without one they take it easy: strolling the corridors, or sitting back at their desk.
 */
export const StaffMember = memo(function StaffMember({
  employee,
  department,
  layout,
  task,
  lastTask,
  waiting,
  selected,
  onSelect,
}: StaffMemberProps) {
  const openModal = useStore((s) => s.openModal);
  // The "done" moment ends on its own timer: there is no scene-wide clock tick to re-render us.
  const [, setMomentOver] = useState(0);
  const momentEnds = (lastTask?.finishedAt ?? 0) + DONE_MOMENT_MS;
  useEffect(() => {
    const left = momentEnds - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setMomentOver((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [momentEnds]);
  const placement = layout.departments.get(department.id);
  const seat = placement?.desks[employee.deskIndex]?.seat;
  const working = Boolean(task);
  const spots = useMemo(() => strollSpots(layout), [layout]);
  const home = useMemo(() => (placement ? homeSpots(layout, placement.zone) : spots), [layout, placement, spots]);
  const look = useMemo(() => lookFor(employee.id), [employee.id]);

  const group = useRef<Group>(null);
  const motion = useRef<Motion>({ walking: false, sitting: false, typing: false });
  const nav = useRef({ waypoints: [] as Vector3[], index: 0 });
  const restUntil = useRef(0);

  const here = (): Vec2 => [group.current?.position.x ?? 0, group.current?.position.z ?? 0];
  const go = (points: Vec2[]) => {
    nav.current = { waypoints: points.map(([x, z]) => new Vector3(x, 0, z)), index: 0 };
  };

  /** The way from where they stand to their seat, or to a spot on the open floor. */
  const routeTo = (target: "seat" | Vec2): Vec2[] => {
    if (!placement || !seat) return [];
    const from = here();
    const { lane, top } = aisle(placement.zone, seat);
    const inside = inZone(placement.zone, from);
    if (target === "seat") {
      if (near(from, seat)) return [];
      return inside ? [top, seat] : [...floorRoute(layout, from, lane), top, seat];
    }
    const out: Vec2[] = !inside ? [] : near(from, seat) ? [top, lane] : [[lane[0], from[1]], lane];
    return [...out, ...floorRoute(layout, out.at(-1) ?? from, target)];
  };

  const randomSpot = (): Vec2 => {
    const pool = Math.random() < HOME_CHANCE ? home : spots;
    const [x, z] = pool[Math.floor(Math.random() * pool.length)];
    return [x + between(-0.4, 0.4), z];
  };

  // First paint: at the desk if working (or, sometimes, relaxing there), otherwise somewhere on the floor.
  useLayoutEffect(() => {
    const g = group.current;
    if (!g || !seat) return;
    const [x, z] = working || Math.random() < CHILL_CHANCE ? seat : randomSpot();
    g.position.set(x, 0, z);
    nav.current = { waypoints: [], index: 0 };
    restUntil.current = Date.now() + between(2000, 8000);
    // Only when their desk or the floor plan changes; tasks coming and going are handled below.
  }, [seat?.[0], seat?.[1], layout]);

  // A task comes in: drop everything and head for the desk. Done: sit back for a moment first.
  useEffect(() => {
    if (working) go(routeTo("seat"));
    else restUntil.current = Date.now() + between(2000, 6000);
  }, [working]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g || !seat) return;
    const m = motion.current;
    const n = nav.current;
    if (n.index < n.waypoints.length) {
      walk(g, n, delta);
      pose(m, "walking");
      if (n.index >= n.waypoints.length && !working) {
        restUntil.current = Date.now() + (near(here(), seat) ? between(8000, 20000) : between(3000, 9000));
      }
      return;
    }
    const atSeat = near(here(), seat);
    if (working) {
      if (!atSeat) return go(routeTo("seat"));
      pose(m, "typing");
      g.rotation.y = 0;
      return;
    }
    if (atSeat) {
      pose(m, "sitting");
      g.rotation.y = 0;
    } else {
      pose(m, "standing");
    }
    if (Date.now() >= restUntil.current) {
      go(routeTo(!atSeat && Math.random() < CHILL_CHANCE ? "seat" : randomSpot()));
    }
  });

  if (!placement || !seat) return null;

  const recent = !task && lastTask && Date.now() < momentEnds ? lastTask : undefined;
  const recentFailed = recent?.status === "failed";
  const click = () =>
    task
      ? onSelect(task.id)
      : recent
        ? onSelect(recent.id)
        : openModal({ type: "department", departmentId: department.id });
  const asking = Boolean(task?.approval);
  const text = asking
    ? "✋ Needs your OK"
    : task
      ? task.activity.at(-1)
      : recent
        ? `${recentFailed ? "⚠️ Couldn't finish" : "✅ Done"}: ${shorten(recent.title)}`
        : waiting > 0
          ? `📋 ${waiting} waiting for me`
          : lastTask
            ? `☕ last: ${shorten(lastTask.title)}`
            : undefined;
  return (
    <group
      ref={group}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        click();
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <Person shirt={department.color} skin={look.skin} hair={look.hair} longHair={look.longHair} motion={motion} />
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.42, 0.52, 32]} />
          <meshBasicMaterial color={department.color} />
        </mesh>
      )}
      <Html position={[0, bubbleHeight(employee.deskIndex), 0]} center distanceFactor={14} zIndexRange={BUBBLE_Z}>
        <div
          className={`bubble${task || recent ? "" : " bubble--idle"}${asking ? " bubble--ask" : recentFailed ? " bubble--failed" : ""}${selected ? " bubble--selected" : ""}`}
          onClick={click}
          title={`${employee.name} · ${employee.focus}`}
        >
          <span className="bubble__name" style={{ color: inkFor(department.color) }}>
            ★ {employee.name}
          </span>
          {text && <span className="bubble__text">{text}</span>}
        </div>
      </Html>
    </group>
  );
});
