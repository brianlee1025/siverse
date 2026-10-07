import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Vector3, type Group } from "three";
import type { Department, Task } from "../../shared/types";
import { pathToSeat, type OfficeLayout } from "../layout";
import { lookFor, Person, type Motion } from "./Person";

const WALK_SPEED = 2.6; // units per second
const ARRIVAL_WINDOW_MS = 5000; // tasks started more recently than this walk in from the door

interface WorkerProps {
  task: Task;
  department: Department;
  layout: OfficeLayout;
  selected: boolean;
  onSelect: (taskId: string) => void;
}

export function Worker({ task, department, layout, selected, onSelect }: WorkerProps) {
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
  const look = useMemo(() => lookFor(task.workerName ?? task.id), [task.workerName, task.id]);

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
    const m = motion.current;
    const n = nav.current;
    if (n && n.index < n.waypoints.length) {
      const target = n.waypoints[n.index];
      const toTarget = target.clone().sub(g.position);
      const distance = toTarget.length();
      const step = WALK_SPEED * Math.min(delta, 0.05);
      if (distance <= step) {
        g.position.copy(target);
        n.index++;
      } else {
        g.position.addScaledVector(toTarget.normalize(), step);
        g.rotation.y = Math.atan2(toTarget.x, toTarget.z);
      }
      m.walking = true;
      m.sitting = false;
      m.typing = false;
      return;
    }
    if (leaving) {
      setGone(true);
      return;
    }
    // Seated at the desk, facing the monitor (+z).
    m.walking = false;
    m.sitting = true;
    m.typing = true;
    g.rotation.y = 0;
  });

  if (gone || !placement || !desk) return null;

  const bubble = task.status === "working" ? task.activity.at(-1) : task.status === "done" ? "✅ Done!" : "🚪 Heading out";

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
      <Html position={[0, 2.05, 0]} center distanceFactor={14} zIndexRange={[30, 0]}>
        <div className={`bubble${selected ? " bubble--selected" : ""}`} onClick={() => onSelect(task.id)}>
          <span className="bubble__name" style={{ color: department.color }}>
            {task.workerName}
          </span>
          {bubble && <span className="bubble__text">{bubble}</span>}
        </div>
      </Html>
    </group>
  );
}
