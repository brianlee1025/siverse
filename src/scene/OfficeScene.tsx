import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Department, Snapshot, Task } from "../../shared/types";
import { buildLayout, ZONE_D, ZONE_W, type OfficeLayout, type Zone } from "../layout";
import { useStore } from "../store";
import { Bookshelf, Chair, Desk, DoorFrame, InTray, Plant, WaterCooler } from "./Furniture";
import { Person, type Motion } from "./Person";
import { Worker } from "./Worker";

const LEAVING_WINDOW_MS = 15_000; // finished workers stay on screen this long to walk out

export function OfficeScene({ snapshot }: { snapshot: Snapshot }) {
  // Snapshots arrive many times a second; only rebuild the floor plan when it actually changes,
  // otherwise every worker would be re-placed on each update.
  const floorPlanKey = snapshot.departments.map((d) => `${d.id}:${d.headcount}`).join("|");
  const layout = useMemo(() => buildLayout(snapshot.departments), [floorPlanKey]);
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ fov: 35, near: 0.5, far: 300 }}>
      <color attach="background" args={["#efe9df"]} />
      <hemisphereLight args={["#ffffff", "#d8cbb8", 1.1]} />
      <directionalLight
        position={[12, 22, 10]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-bias={-0.0004}
      />
      <CameraRig layout={layout} />
      <Room layout={layout} />
      <BossOffice zone={layout.boss} busy={snapshot.manager.busy} activity={snapshot.manager.activity} />
      {snapshot.departments.map((department) => (
        <DepartmentZone key={department.id} department={department} layout={layout} tasks={snapshot.tasks} />
      ))}
      {layout.placeholder && <PlaceholderZone zone={layout.placeholder} empty={!snapshot.departments.length} />}
      <Workers snapshot={snapshot} layout={layout} />
    </Canvas>
  );
}

/** Frames the whole office whenever its footprint changes, then leaves the camera to the user. */
function CameraRig({ layout }: { layout: OfficeLayout }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useRef<OrbitControlsImpl>(null);
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const size = Math.max(maxX - minX, (maxZ - minZ) * 1.3);
  // Narrow viewports (phones, a squeezed middle column) need the camera further back.
  const fit = Math.max(1, 1.5 / aspect);
  const roundedFit = Math.round(fit * 4) / 4; // avoid re-framing on every pixel of a resize

  useEffect(() => {
    const distance = (size * 0.78 + 4) * roundedFit;
    camera.position.set(distance * 0.38, distance * 0.66, distance * 0.76);
    controls.current?.target.set(0, 0, 0.5);
    controls.current?.update();
  }, [camera, size, roundedFit]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      minDistance={6}
      maxDistance={(size * 2.5 + 10) * roundedFit}
      maxPolarAngle={Math.PI / 2.25}
    />
  );
}

function Room({ layout }: { layout: OfficeLayout }) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const WALL_H = 3;
  return (
    <group>
      <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#e6d8c3" />
      </mesh>
      <mesh position={[cx, -0.17, cz]}>
        <boxGeometry args={[width + 0.3, 0.3, depth + 0.3]} />
        <meshStandardMaterial color="#b9a68c" />
      </mesh>
      {/* Back and left walls only, so the camera can see in, like a dollhouse. */}
      <mesh position={[cx, WALL_H / 2, minZ - 0.1]} receiveShadow castShadow>
        <boxGeometry args={[width + 0.2, WALL_H, 0.2]} />
        <meshStandardMaterial color="#f7f3ec" />
      </mesh>
      <mesh position={[minX - 0.1, WALL_H / 2, cz]} receiveShadow castShadow>
        <boxGeometry args={[0.2, WALL_H, depth + 0.2]} />
        <meshStandardMaterial color="#f2ede4" />
      </mesh>
      {Array.from({ length: Math.max(1, Math.floor(width / 5)) }, (_, i) => (
        <mesh key={i} position={[minX + 2.5 + i * 5, 1.75, minZ + 0.01]}>
          <planeGeometry args={[2.6, 1.3]} />
          <meshStandardMaterial color="#bcd9ee" emissive="#bcd9ee" emissiveIntensity={0.25} />
        </mesh>
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
      <group position={[layout.door[0] - 1.6, 0, maxZ - 0.6]}>
        <WaterCooler />
      </group>
    </group>
  );
}

function Rug({ zone, color, opacity = 1, onClick }: { zone: Zone; color: string; opacity?: number; onClick?: () => void }) {
  return (
    <mesh
      position={[zone.center[0], 0.01, zone.center[1]]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
      onClick={
        onClick &&
        ((e) => {
          e.stopPropagation();
          onClick();
        })
      }
      onPointerOver={onClick && (() => (document.body.style.cursor = "pointer"))}
      onPointerOut={onClick && (() => (document.body.style.cursor = ""))}
    >
      <planeGeometry args={[ZONE_W, ZONE_D]} />
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  );
}

function BossOffice({ zone, busy, activity }: { zone: Zone; busy: boolean; activity: string | null }) {
  const bossMotion = useRef<Motion>({ walking: false, sitting: true, typing: false });
  const managerMotion = useRef<Motion>({ walking: false, sitting: false, typing: false });
  const [cx, cz] = zone.center;
  const openChat = useStore((s) => s.setChatOpen);
  return (
    <group>
      <Rug zone={zone} color="#d9c7e8" opacity={0.55} />
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
        <Person shirt="#2f3a56" skin="#e0ac8a" hair="#2b1d14" tie="#c0392b" motion={bossMotion} />
        <Html position={[0, 2.1, 0]} center distanceFactor={14} zIndexRange={[30, 0]}>
          <div className="nameplate nameplate--boss">You · Boss</div>
        </Html>
      </group>
      {/* The manager stands beside the desk; their bubble shows what they're doing right now. */}
      <group position={[cx + 1.5, 0, cz + 0.4]} rotation={[0, -0.6, 0]}>
        <Person shirt="#5b8c85" skin="#c68863" hair="#121212" longHair motion={managerMotion} />
        <Html position={[0, 2.1, 0]} center distanceFactor={14} zIndexRange={[30, 0]}>
          <div className="bubble bubble--manager" onClick={() => openChat(true)}>
            <span className="bubble__name">Manager</span>
            <span className="bubble__text">{busy ? (activity ?? "Thinking…") : "Ready for orders"}</span>
          </div>
        </Html>
      </group>
    </group>
  );
}

function DepartmentZone({ department, layout, tasks }: { department: Department; layout: OfficeLayout; tasks: Task[] }) {
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
      <Rug zone={zone} color={department.color} opacity={0.28} onClick={open} />
      <Html position={[zone.center[0], 2.3, zone.center[1] - ZONE_D / 2 + 0.3]} center distanceFactor={16} zIndexRange={[20, 0]}>
        <button className="zone-sign" style={{ borderColor: department.color }} onClick={open}>
          <strong style={{ color: department.color }}>
            {department.source === "claude-code" ? `⚡ ${department.name}` : department.name}
          </strong>
          <span>
            {department.source === "claude-code"
              ? `Claude Code · ${working.length} at work`
              : `${working.length}/${department.headcount} working${queued ? ` · ${queued} waiting` : ""}${department.webAccess ? " · 🌐" : ""}`}
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
}

function PlaceholderZone({ zone, empty }: { zone: Zone; empty: boolean }) {
  const openModal = useStore((s) => s.openModal);
  return (
    <group>
      <Rug zone={zone} color="#ffffff" opacity={0.35} onClick={() => openModal({ type: "department", departmentId: null })} />
      <Html position={[zone.center[0], 0.6, zone.center[1]]} center distanceFactor={16} zIndexRange={[20, 0]}>
        <button className="zone-placeholder" onClick={() => openModal({ type: "department", departmentId: null })}>
          {empty ? "＋ Open your first department" : "＋ New department"}
        </button>
      </Html>
    </group>
  );
}

function Workers({ snapshot, layout }: { snapshot: Snapshot; layout: OfficeLayout }) {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const visible = snapshot.tasks.filter(
    (t) =>
      t.startedAt &&
      (t.status === "working" || (t.finishedAt && now - t.finishedAt < LEAVING_WINDOW_MS)),
  );
  return (
    <>
      {visible.map((task) => {
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
