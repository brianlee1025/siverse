import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { MathUtils, type Group } from "three";

// A low-poly person built from primitives, so the project needs no 3D asset files. The parent
// drives the pose through a `motion` ref; this component animates limbs to match every frame.

export interface Motion {
  walking: boolean;
  sitting: boolean;
  typing: boolean;
}

const SKIN_TONES = ["#f1c7a5", "#e0ac8a", "#c68863", "#a86c4a", "#7d4e33", "#f6d3b8"];
const HAIR_COLORS = ["#2b1d14", "#4a3020", "#121212", "#8a5a2b", "#c99a5b", "#6b6b6b", "#3b2a4a"];

/** Stable look for a name, so the same worker always looks the same. */
export function lookFor(seed: string) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    skin: SKIN_TONES[hash % SKIN_TONES.length],
    hair: HAIR_COLORS[(hash >> 3) % HAIR_COLORS.length],
    longHair: ((hash >> 6) & 1) === 1,
  };
}

interface PersonProps {
  shirt: string;
  skin: string;
  hair: string;
  longHair?: boolean;
  pants?: string;
  tie?: string;
  motion: RefObject<Motion>;
}

export function Person({ shirt, skin, hair, longHair, pants = "#3d4451", tie, motion }: PersonProps) {
  const body = useRef<Group>(null);
  const legL = useRef<Group>(null);
  const legR = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const clock = useRef(Math.random() * 10);

  useFrame((_, delta) => {
    const m = motion.current;
    if (!m || !body.current || !legL.current || !legR.current || !armL.current || !armR.current) return;
    const t = (clock.current += delta);
    const k = 1 - Math.exp(-delta * 12); // frame-rate independent smoothing
    const swing = m.walking ? Math.sin(t * 9) * 0.55 : 0;
    const legBase = m.sitting ? -Math.PI / 2 : 0;

    legL.current.rotation.x = MathUtils.lerp(legL.current.rotation.x, legBase + swing, k);
    legR.current.rotation.x = MathUtils.lerp(legR.current.rotation.x, legBase - swing, k);

    const armTargetL = m.typing ? -1.15 + Math.sin(t * 16) * 0.09 : -swing * 0.8;
    const armTargetR = m.typing ? -1.15 + Math.sin(t * 16 + 1.7) * 0.09 : swing * 0.8;
    armL.current.rotation.x = MathUtils.lerp(armL.current.rotation.x, armTargetL, k);
    armR.current.rotation.x = MathUtils.lerp(armR.current.rotation.x, armTargetR, k);

    const bob = m.walking ? Math.abs(Math.sin(t * 9)) * 0.05 : m.typing ? Math.sin(t * 2.2) * 0.012 : 0;
    body.current.position.y = MathUtils.lerp(body.current.position.y, (m.sitting ? -0.17 : 0) + bob, k);
  });

  return (
    <group ref={body}>
      {[legL, legR].map((ref, i) => (
        <group key={i} ref={ref} position={[i === 0 ? -0.11 : 0.11, 0.62, 0]}>
          <mesh position={[0, -0.3, 0]} castShadow>
            <boxGeometry args={[0.16, 0.6, 0.18]} />
            <meshStandardMaterial color={pants} />
          </mesh>
          <mesh position={[0, -0.6, 0.05]} castShadow>
            <boxGeometry args={[0.17, 0.08, 0.28]} />
            <meshStandardMaterial color="#26272b" />
          </mesh>
        </group>
      ))}

      <mesh position={[0, 0.96, 0]} castShadow>
        <capsuleGeometry args={[0.24, 0.3, 6, 14]} />
        <meshStandardMaterial color={shirt} />
      </mesh>
      {tie && (
        <mesh position={[0, 1.0, 0.235]} rotation={[0.08, 0, 0]}>
          <boxGeometry args={[0.07, 0.3, 0.02]} />
          <meshStandardMaterial color={tie} />
        </mesh>
      )}

      {[armL, armR].map((ref, i) => (
        <group key={i} ref={ref} position={[i === 0 ? -0.31 : 0.31, 1.16, 0]}>
          <mesh position={[0, -0.22, 0]} castShadow>
            <capsuleGeometry args={[0.07, 0.3, 4, 8]} />
            <meshStandardMaterial color={shirt} />
          </mesh>
          <mesh position={[0, -0.45, 0]}>
            <sphereGeometry args={[0.07, 10, 8]} />
            <meshStandardMaterial color={skin} />
          </mesh>
        </group>
      ))}

      <mesh position={[0, 1.5, 0]} castShadow>
        <sphereGeometry args={[0.22, 22, 16]} />
        <meshStandardMaterial color={skin} />
      </mesh>
      <mesh position={[0, 1.55, -0.015]} scale={[1.06, 0.92, 1.06]}>
        <sphereGeometry args={[0.22, 22, 16, 0, Math.PI * 2, 0, Math.PI / 2.1]} />
        <meshStandardMaterial color={hair} />
      </mesh>
      {longHair && (
        <mesh position={[0, 1.4, -0.12]}>
          <boxGeometry args={[0.4, 0.34, 0.14]} />
          <meshStandardMaterial color={hair} />
        </mesh>
      )}
      {[-0.075, 0.075].map((x) => (
        <mesh key={x} position={[x, 1.52, 0.2]}>
          <sphereGeometry args={[0.024, 8, 8]} />
          <meshStandardMaterial color="#1d1d1f" />
        </mesh>
      ))}
    </group>
  );
}
