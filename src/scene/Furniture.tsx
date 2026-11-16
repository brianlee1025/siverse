// Simple furniture from boxes and cylinders. Everything sits on the floor at y = 0 and faces +z
// (towards the camera) unless rotated by the caller.

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, type Group, type Mesh, type MeshBasicMaterial } from "three";
import { motion } from "../motion";

const WOOD = "#c89f72";
const WOOD_DARK = "#8f6a47";
const METAL = "#9aa1ab";

/**
 * Three soft puffs rising and fading in a loop, e.g. over a mug or the coffee machine. Mutated in
 * useFrame (no React state), and each puff has its own material so they fade independently.
 */
// Steam is decoration only (the desk glow already says "busy"), so it's left out with reduced motion.
export function Steam({ height = 0.4, size = 0.05 }: { height?: number; size?: number }) {
  const puffs = useRef<(Mesh | null)[]>([]);
  const clock = useRef(Math.random() * 3);
  useFrame((_, delta) => {
    if (motion.reduced) {
      // Hide the puffs, so switching it on mid-puff doesn't freeze a half-visible one.
      puffs.current.forEach((m) => m && ((m.material as MeshBasicMaterial).opacity = 0));
      return;
    }
    const t = (clock.current += Math.min(delta, 0.05));
    puffs.current.forEach((m, i) => {
      if (!m) return;
      const p = (t * 0.45 + i / 3) % 1; // 0 → 1 over ~2.2 s, puffs a third apart
      m.position.set(Math.sin((t + i) * 2.1) * 0.025, p * height, Math.cos((t + i) * 1.7) * 0.015);
      m.scale.setScalar(0.6 + p * 0.9);
      (m.material as MeshBasicMaterial).opacity = 0.55 * Math.sin(p * Math.PI);
    });
  });
  return (
    <group>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => void (puffs.current[i] = m)}>
          <sphereGeometry args={[size, 8, 6]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

export function Desk({ busy, accent }: { busy: boolean; accent: string }) {
  return (
    <group>
      <mesh position={[0, 0.72, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.45, 0.06, 0.8]} />
        <meshStandardMaterial color={WOOD} />
      </mesh>
      {[-0.66, 0.66].map((x) => (
        <mesh key={x} position={[x, 0.36, 0]} castShadow>
          <boxGeometry args={[0.06, 0.72, 0.72]} />
          <meshStandardMaterial color={WOOD_DARK} />
        </mesh>
      ))}
      {/* Monitor faces the worker, who sits on the -z side. */}
      <group position={[0, 0.75, 0.2]}>
        <mesh position={[0, 0.08, 0]}>
          <boxGeometry args={[0.08, 0.16, 0.08]} />
          <meshStandardMaterial color="#3a3d44" />
        </mesh>
        <mesh position={[0, 0.34, 0]} castShadow>
          <boxGeometry args={[0.66, 0.4, 0.05]} />
          <meshStandardMaterial color="#2d3038" />
        </mesh>
        <mesh position={[0, 0.34, -0.027]}>
          <planeGeometry args={[0.6, 0.34]} />
          <meshStandardMaterial
            color={busy ? accent : "#1b1d22"}
            emissive={busy ? accent : "#000000"}
            emissiveIntensity={busy ? 0.6 : 0}
            side={2}
          />
        </mesh>
        {/* The camera sees the monitor's back, so a busy screen also glows around its edges (a halo
            just behind the screen, front side only, so the worker still sees the screen) and its
            power light turns green. An emissive plane, not a light: no extra cost per desk. */}
        {busy && (
          <mesh position={[0, 0.34, -0.035]}>
            <planeGeometry args={[0.92, 0.66]} />
            <meshBasicMaterial color={accent} transparent opacity={0.7} depthWrite={false} toneMapped={false} />
          </mesh>
        )}
        <mesh position={[0.26, 0.18, 0.027]}>
          <circleGeometry args={[0.018, 10]} />
          <meshBasicMaterial color={busy ? "#5ee38a" : "#55585f"} toneMapped={false} />
        </mesh>
      </group>
      <mesh position={[0, 0.76, -0.18]}>
        <boxGeometry args={[0.46, 0.02, 0.15]} />
        <meshStandardMaterial color="#e9e9ec" />
      </mesh>
      {/* A mug on the camera side; it steams while someone works here. */}
      <group position={[0.52, 0.75, 0.22]}>
        <mesh position={[0, 0.055, 0]} castShadow>
          <cylinderGeometry args={[0.05, 0.045, 0.11, 12]} />
          <meshStandardMaterial color={accent} />
        </mesh>
        <mesh position={[0.055, 0.06, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.025, 0.009, 6, 10]} />
          <meshStandardMaterial color={accent} />
        </mesh>
        {busy && (
          <group position={[0, 0.13, 0]}>
            <Steam height={0.32} size={0.035} />
          </group>
        )}
      </group>
    </group>
  );
}

/** A low planter box with shrubs, used as a divider between zones. Runs along z, `length` long. */
export function Planter({ length }: { length: number }) {
  const shrubs = Math.max(2, Math.round(length / 0.75));
  return (
    <group>
      <mesh position={[0, 0.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, 0.5, length]} />
        <meshStandardMaterial color="#b98d64" />
      </mesh>
      <mesh position={[0, 0.505, 0]}>
        <boxGeometry args={[0.42, 0.02, length - 0.08]} />
        <meshStandardMaterial color="#5a4332" />
      </mesh>
      {Array.from({ length: shrubs }, (_, i) => {
        const z = -length / 2 + (length / shrubs) * (i + 0.5);
        const big = i % 2 === 0;
        return (
          <mesh key={i} position={[0, big ? 0.78 : 0.72, z]} castShadow>
            <icosahedronGeometry args={[big ? 0.3 : 0.24, 0]} />
            <meshStandardMaterial color={big ? "#6fa36a" : "#86b97c"} flatShading />
          </mesh>
        );
      })}
    </group>
  );
}

/** A framed glass partition along z, for the manager's office. */
export function GlassPartition({ length }: { length: number }) {
  const H = 1.5;
  return (
    <group>
      <mesh position={[0, H / 2, 0]}>
        <boxGeometry args={[0.04, H, length]} />
        <meshStandardMaterial color="#cfe3ee" transparent opacity={0.35} roughness={0.1} depthWrite={false} />
      </mesh>
      {[-length / 2, 0, length / 2].map((z) => (
        <mesh key={z} position={[0, H / 2, z]} castShadow>
          <boxGeometry args={[0.08, H, 0.08]} />
          <meshStandardMaterial color="#4a4f5a" />
        </mesh>
      ))}
      <mesh position={[0, H, 0]}>
        <boxGeometry args={[0.08, 0.06, length + 0.08]} />
        <meshStandardMaterial color="#4a4f5a" />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.1, 0.1, length + 0.08]} />
        <meshStandardMaterial color="#4a4f5a" />
      </mesh>
    </group>
  );
}

/** A window on a wall (facing +z): frame, two panes, a mullion and a sill. `glass` changes with the time of day. */
export function Window({ glass, glow }: { glass: string; glow: number }) {
  const W = 2.6;
  const H = 1.3;
  return (
    <group>
      <mesh position={[0, 0, 0.01]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color={glass} emissive={glass} emissiveIntensity={glow} />
      </mesh>
      {/* frame: top, bottom, sides, mullion */}
      {(
        [
          [0, H / 2, W + 0.12, 0.08],
          [0, -H / 2, W + 0.12, 0.08],
          [-W / 2, 0, 0.08, H],
          [W / 2, 0, 0.08, H],
          [0, 0, 0.06, H],
        ] as const
      ).map(([x, y, w, h], i) => (
        <mesh key={i} position={[x, y, 0.04]}>
          <boxGeometry args={[w, h, 0.06]} />
          <meshStandardMaterial color="#fbf8f2" />
        </mesh>
      ))}
      <mesh position={[0, -H / 2 - 0.06, 0.1]} castShadow>
        <boxGeometry args={[W + 0.3, 0.06, 0.2]} />
        <meshStandardMaterial color="#fbf8f2" />
      </mesh>
    </group>
  );
}

const ART = [
  ["#e07a5f", "#f2cc8f", "#3d405b"],
  ["#81b29a", "#f4f1de", "#e07a5f"],
  ["#3d85c6", "#f2cc8f", "#9b72cf"],
  ["#f2cc8f", "#81b29a", "#3d405b"],
];

/** A framed abstract print (three colour blocks) on a wall facing +z. */
export function WallArt({ variant }: { variant: number }) {
  const [a, b, c] = ART[variant % ART.length];
  const tall = variant % 2 === 1;
  const w = tall ? 0.7 : 0.95;
  const h = tall ? 0.95 : 0.7;
  return (
    <group>
      <mesh position={[0, 0, 0.03]} castShadow>
        <boxGeometry args={[w + 0.08, h + 0.08, 0.04]} />
        <meshStandardMaterial color={WOOD_DARK} />
      </mesh>
      <mesh position={[0, 0, 0.052]}>
        <planeGeometry args={[w - 0.04, h - 0.04]} />
        <meshStandardMaterial color="#fbf8f2" />
      </mesh>
      <mesh position={[-w * 0.12, h * 0.1, 0.055]}>
        <circleGeometry args={[Math.min(w, h) * 0.26, 20]} />
        <meshStandardMaterial color={a} />
      </mesh>
      <mesh position={[w * 0.14, -h * 0.12, 0.056]}>
        <planeGeometry args={[w * 0.42, h * 0.38]} />
        <meshStandardMaterial color={b} />
      </mesh>
      <mesh position={[w * 0.05, -h * 0.3, 0.057]}>
        <planeGeometry args={[w * 0.7, 0.04]} />
        <meshStandardMaterial color={c} />
      </mesh>
    </group>
  );
}

/** A wall clock (facing +z) that shows the boss's real local time; hands move once a second. */
export function WallClock() {
  const hour = useRef<Group>(null);
  const minute = useRef<Group>(null);
  const last = useRef(-1);
  useFrame(() => {
    const now = new Date();
    const s = now.getSeconds();
    if (s === last.current) return;
    last.current = s;
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;
    if (minute.current) minute.current.rotation.z = -(m / 60) * Math.PI * 2;
    if (hour.current) hour.current.rotation.z = -(h / 12) * Math.PI * 2;
  });
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.03]}>
        <cylinderGeometry args={[0.32, 0.32, 0.05, 28]} />
        <meshStandardMaterial color="#2f3540" />
      </mesh>
      <mesh position={[0, 0, 0.057]}>
        <circleGeometry args={[0.28, 28]} />
        <meshStandardMaterial color="#fbf8f2" />
      </mesh>
      {Array.from({ length: 12 }, (_, i) => (
        <mesh key={i} position={[Math.sin((i / 12) * Math.PI * 2) * 0.23, Math.cos((i / 12) * Math.PI * 2) * 0.23, 0.06]}>
          <circleGeometry args={[i % 3 === 0 ? 0.018 : 0.01, 6]} />
          <meshBasicMaterial color="#2f3540" />
        </mesh>
      ))}
      <group ref={hour} position={[0, 0, 0.062]}>
        <mesh position={[0, 0.07, 0]}>
          <planeGeometry args={[0.03, 0.15]} />
          <meshBasicMaterial color="#2f3540" />
        </mesh>
      </group>
      <group ref={minute} position={[0, 0, 0.064]}>
        <mesh position={[0, 0.1, 0]}>
          <planeGeometry args={[0.02, 0.21]} />
          <meshBasicMaterial color="#c0392b" />
        </mesh>
      </group>
    </group>
  );
}

/** The coffee corner against a wall (facing +z): counter with a steaming machine, fridge, stools. */
export function CoffeeCorner() {
  return (
    <group>
      {/* tiled backsplash on the wall */}
      <mesh position={[-0.4, 1.2, 0.05]}>
        <planeGeometry args={[2.2, 0.55]} />
        <meshStandardMaterial color="#e8f0ef" />
      </mesh>
      {/* counter */}
      <mesh position={[-0.4, 0.45, 0.32]} castShadow receiveShadow>
        <boxGeometry args={[2.1, 0.9, 0.6]} />
        <meshStandardMaterial color="#5f7f7a" />
      </mesh>
      <mesh position={[-0.4, 0.92, 0.33]} castShadow receiveShadow>
        <boxGeometry args={[2.2, 0.05, 0.66]} />
        <meshStandardMaterial color="#efe6d6" />
      </mesh>
      {[-1.0, -0.4, 0.2].map((x) => (
        <mesh key={x} position={[x, 0.68, 0.625]}>
          <boxGeometry args={[0.18, 0.025, 0.02]} />
          <meshStandardMaterial color={METAL} />
        </mesh>
      ))}
      {/* coffee machine */}
      <group position={[-1.05, 0.945, 0.28]}>
        <mesh position={[0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.36, 0.44, 0.34]} />
          <meshStandardMaterial color="#2f3540" />
        </mesh>
        <mesh position={[0, 0.3, 0.172]}>
          <planeGeometry args={[0.2, 0.08]} />
          <meshBasicMaterial color="#ffb347" toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.05, 0.12]}>
          <cylinderGeometry args={[0.045, 0.04, 0.09, 10]} />
          <meshStandardMaterial color="#fbf8f2" />
        </mesh>
        <group position={[0, 0.12, 0.12]}>
          <Steam height={0.35} size={0.04} />
        </group>
      </group>
      {/* fruit bowl and mugs */}
      <mesh position={[-0.3, 0.98, 0.32]}>
        <sphereGeometry args={[0.16, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
        <meshStandardMaterial color="#fbf8f2" side={DoubleSide} />
      </mesh>
      {(
        [
          [-0.35, "#e07a5f"],
          [-0.25, "#f2cc8f"],
          [-0.3, "#81b29a"],
        ] as const
      ).map(([x, c], i) => (
        <mesh key={i} position={[x, 1.0 + (i === 2 ? 0.06 : 0), 0.32 + (i - 1) * 0.04]}>
          <sphereGeometry args={[0.06, 10, 8]} />
          <meshStandardMaterial color={c} />
        </mesh>
      ))}
      {[0.15, 0.27].map((x) => (
        <mesh key={x} position={[x, 0.995, 0.3]} castShadow>
          <cylinderGeometry args={[0.045, 0.04, 0.1, 10]} />
          <meshStandardMaterial color={x < 0.2 ? "#3d85c6" : "#fbf8f2"} />
        </mesh>
      ))}
      {/* fridge */}
      <group position={[1.05, 0, 0.36]}>
        <mesh position={[0, 0.85, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.7, 1.7, 0.66]} />
          <meshStandardMaterial color="#f4f1ea" />
        </mesh>
        <mesh position={[0, 1.18, 0.335]}>
          <planeGeometry args={[0.66, 0.01]} />
          <meshBasicMaterial color="#c9c2b6" />
        </mesh>
        <mesh position={[-0.27, 1.45, 0.35]}>
          <boxGeometry args={[0.03, 0.22, 0.03]} />
          <meshStandardMaterial color={METAL} />
        </mesh>
        <mesh position={[-0.27, 0.9, 0.35]}>
          <boxGeometry args={[0.03, 0.3, 0.03]} />
          <meshStandardMaterial color={METAL} />
        </mesh>
      </group>
      {/* stools */}
      {[-0.95, -0.1].map((x) => (
        <group key={x} position={[x, 0, 0.95]}>
          <mesh position={[0, 0.66, 0]} castShadow>
            <cylinderGeometry args={[0.19, 0.19, 0.06, 14]} />
            <meshStandardMaterial color="#e07a5f" />
          </mesh>
          <mesh position={[0, 0.33, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.62, 8]} />
            <meshStandardMaterial color={METAL} />
          </mesh>
          <mesh position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.17, 0.17, 0.03, 14]} />
            <meshStandardMaterial color="#4a4e57" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Chair({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.44, 0]} castShadow>
        <boxGeometry args={[0.5, 0.08, 0.48]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.78, -0.24]} castShadow>
        <boxGeometry args={[0.5, 0.6, 0.07]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.22, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.42, 8]} />
        <meshStandardMaterial color={METAL} />
      </mesh>
      <mesh position={[0, 0.03, 0]}>
        <cylinderGeometry args={[0.26, 0.26, 0.04, 12]} />
        <meshStandardMaterial color="#4a4e57" />
      </mesh>
    </group>
  );
}

export function Plant({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.24, 0.18, 0.5, 14]} />
        <meshStandardMaterial color="#d9cbb8" />
      </mesh>
      <mesh position={[0, 0.85, 0]} castShadow>
        <icosahedronGeometry args={[0.45, 0]} />
        <meshStandardMaterial color="#6fa36a" flatShading />
      </mesh>
      <mesh position={[0.15, 1.2, 0.05]} castShadow>
        <icosahedronGeometry args={[0.3, 0]} />
        <meshStandardMaterial color="#7fb878" flatShading />
      </mesh>
    </group>
  );
}

export function WaterCooler() {
  return (
    <group>
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[0.4, 1, 0.4]} />
        <meshStandardMaterial color="#eef0f2" />
      </mesh>
      <mesh position={[0, 1.22, 0]} castShadow>
        <cylinderGeometry args={[0.17, 0.17, 0.44, 16]} />
        <meshStandardMaterial color="#8fc6ea" transparent opacity={0.75} />
      </mesh>
    </group>
  );
}

export function Bookshelf() {
  return (
    <group>
      <mesh position={[0, 0.9, 0]} castShadow>
        <boxGeometry args={[1.6, 1.8, 0.4]} />
        <meshStandardMaterial color={WOOD_DARK} />
      </mesh>
      {[0.45, 0.95, 1.45].map((y, row) =>
        [-0.55, -0.3, -0.1, 0.15, 0.4].map((x, i) => (
          <mesh key={`${row}-${i}`} position={[x, y, 0.08]}>
            <boxGeometry args={[0.16, 0.36 - ((i + row) % 3) * 0.05, 0.26]} />
            <meshStandardMaterial color={["#e07a5f", "#3d85c6", "#f2cc8f", "#81b29a", "#9b72cf"][(i + row) % 5]} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** A tray of papers; the stack grows with the number of queued tasks. */
export function InTray({ count, color }: { count: number; color: string }) {
  const sheets = Math.min(count, 12);
  return (
    <group>
      <mesh position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[0.6, 0.8, 0.45]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {Array.from({ length: sheets }, (_, i) => (
        <mesh key={i} position={[(i % 2) * 0.02, 0.82 + i * 0.03, (i % 3) * 0.01]} rotation={[0, (i % 4) * 0.05, 0]}>
          <boxGeometry args={[0.42, 0.02, 0.32]} />
          <meshStandardMaterial color="#fbfaf7" />
        </mesh>
      ))}
    </group>
  );
}

export function DoorFrame() {
  return (
    <group>
      {[-0.75, 0.75].map((x) => (
        <mesh key={x} position={[x, 1.25, 0]} castShadow>
          <boxGeometry args={[0.14, 2.5, 0.2]} />
          <meshStandardMaterial color="#5b6270" />
        </mesh>
      ))}
      <mesh position={[0, 2.5, 0]} castShadow>
        <boxGeometry args={[1.64, 0.14, 0.2]} />
        <meshStandardMaterial color="#5b6270" />
      </mesh>
      <mesh position={[0, 0.011, 0.5]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[1.4, 0.9]} />
        <meshStandardMaterial color="#7a5c4a" />
      </mesh>
    </group>
  );
}
