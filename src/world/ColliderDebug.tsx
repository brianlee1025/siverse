import { useLayoutEffect, useMemo, useRef } from "react";
import { Object3D, type InstancedMesh } from "three";
import type { OfficeLayout } from "../layout";
import { buildColliders } from "./colliders";

// ?colliders: every collider as a flat red footprint on the floor, in one draw call. Visible in office
// view, so the boxes can be checked without walking. Loaded lazily (its own chunk with colliders.ts).

export default function ColliderDebug({ layout }: { layout: OfficeLayout }) {
  const boxes = useMemo(() => buildColliders(layout), [layout]);
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const o = new Object3D();
    boxes.forEach((b, i) => {
      o.position.set((b.minX + b.maxX) / 2, 0.03, (b.minZ + b.maxZ) / 2);
      o.scale.set(b.maxX - b.minX, 1, b.maxZ - b.minZ);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.count = boxes.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [boxes]);
  return (
    // Keyed on the count: an InstancedMesh can't grow after it's created.
    <instancedMesh key={boxes.length} ref={mesh} args={[undefined, undefined, boxes.length]} renderOrder={10}>
      <boxGeometry args={[1, 0.02, 1]} />
      <meshBasicMaterial color="#e03131" transparent opacity={0.45} depthWrite={false} />
    </instancedMesh>
  );
}
