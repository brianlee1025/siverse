import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Department, Snapshot, Task } from "../../shared/types";
import { BUBBLE_Z, buildLayout, SIGN_Z, ZONE_D, ZONE_W, type OfficeLayout, type Zone } from "../layout";
import { inkFor } from "../colors";
import { useStore } from "../store";
import { Bookshelf, Chair, Desk, DoorFrame, InTray, Plant, WaterCooler } from "./Furniture";
import { Person, type Motion } from "./Person";
import { StaffMember, Worker } from "./Worker";

const LEAVING_WINDOW_MS = 15_000; // finished workers stay on screen this long to walk out
const CAMERA_FOV = 35;
const LABEL_DISTANCE_FACTOR = 14; // the distanceFactor of the people's bubbles

export function OfficeScene({ snapshot }: { snapshot: Snapshot }) {
  // Snapshots arrive many times a second; only rebuild the floor plan when it actually changes,
  // otherwise every worker would be re-placed on each update.
  const floorPlanKey = snapshot.departments.map((d) => `${d.id}:${d.headcount}`).join("|");
  const layout = useMemo(() => buildLayout(snapshot.departments), [floorPlanKey]);
  const [contextLost, setContextLost] = useState(false);
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
      shadows
      dpr={[1, 2]}
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
      <BossOffice
        zone={layout.boss}
        showManager={snapshot.settings.aiOffice}
        busy={snapshot.manager.busy}
        activity={snapshot.manager.activity}
        asking={snapshot.tasks.filter((t) => t.approval).length}
        firstAskingId={snapshot.tasks.find((t) => t.approval)?.id}
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
    </Canvas>
  );
}

/** Frames the occupied part of the office whenever its footprint changes, then leaves the camera to the user. */
function CameraRig({ layout }: { layout: OfficeLayout }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useRef<OrbitControlsImpl>(null);
  const boost = useRef(1);
  const { minX, maxX, minZ, maxZ } = layout.focus;
  const size = Math.max(maxX - minX, (maxZ - minZ) * 1.3);
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  // Zooming out is still limited by the whole room, so the boss can always see every wall.
  const room = layout.bounds;
  const roomSize = Math.max(room.maxX - room.minX, (room.maxZ - room.minZ) * 1.3);
  // Narrow viewports (phones, a squeezed middle column) need the camera further back.
  const fit = Math.max(1, 1.5 / aspect);
  const roundedFit = Math.round(fit * 4) / 4; // avoid re-framing on every pixel of a resize

  useEffect(() => {
    const distance = (size * 0.78 + 4) * roundedFit;
    camera.position.set(centerX + distance * 0.38, distance * 0.66, centerZ + distance * 0.76);
    controls.current?.target.set(centerX, 0, centerZ);
    controls.current?.update();
  }, [camera, size, centerX, centerZ, roundedFit]);

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
      <group position={[layout.cooler[0], 0, layout.cooler[1]]}>
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

function BossOffice({
  zone,
  showManager,
  busy,
  activity,
  asking,
  firstAskingId,
}: {
  zone: Zone;
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
        <Html position={[0, 2.1, 0]} center distanceFactor={14} zIndexRange={BUBBLE_Z}>
          <div className="nameplate nameplate--boss">You · Boss</div>
        </Html>
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
      <Rug zone={zone} color={department.color} opacity={0.28} onClick={open} />
      <Html position={[zone.center[0], 2.3, zone.center[1] - ZONE_D / 2 + 0.3]} center distanceFactor={16} zIndexRange={SIGN_Z}>
        <button className="zone-sign" style={{ borderColor: department.color }} onClick={open}>
          <strong style={{ color: inkFor(department.color) }}>
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
});

function PlaceholderZone({ zone, empty, showLabel }: { zone: Zone; empty: boolean; showLabel: boolean }) {
  const openModal = useStore((s) => s.openModal);
  return (
    <group>
      <Rug zone={zone} color="#ffffff" opacity={0.35} onClick={() => openModal({ type: "department", departmentId: null })} />
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
      <Rug zone={zone} color="#ffffff" opacity={0.35} onClick={open} />
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

  // Permanent employees are always in the office (StaffMember); temps come and go with their task.
  // No clock tick needed: a leaving temp hides itself once it's out the door.
  const now = Date.now();
  // The ring follows the selected task's owner, even once it's finished and they're idle.
  const selectedOwner = snapshot.tasks.find((t) => t.id === selectedTaskId)?.employeeId;
  const staff =new Set(snapshot.employees.map((e) => e.id));
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
        return (
          <StaffMember
            key={employee.id}
            employee={employee}
            department={department}
            layout={layout}
            task={task}
            lastTask={lastTask}
            waiting={waiting}
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
