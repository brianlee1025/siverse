// Simple furniture from boxes and cylinders. Everything sits on the floor at y = 0 and faces +z
// (towards the camera) unless rotated by the caller.

const WOOD = "#c89f72";
const WOOD_DARK = "#8f6a47";
const METAL = "#9aa1ab";

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
      </group>
      <mesh position={[0, 0.76, -0.18]}>
        <boxGeometry args={[0.46, 0.02, 0.15]} />
        <meshStandardMaterial color="#e9e9ec" />
      </mesh>
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
