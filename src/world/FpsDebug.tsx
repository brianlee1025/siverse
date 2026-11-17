import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

// ?fps (lazy chunk): frame rate, draw calls and triangles, bottom-right of the scene. A plain DOM node
// written twice a second, so it costs no React renders. gl.info resets on each render, so inside useFrame
// it holds the last frame's totals (the shadow pass included). Since round 11 it also shows GPU memory counts
// (gl.info.memory: geometries and textures alive): a number that only grows while you move about means a leak.

const EVERY_MS = 500;

export default function FpsDebug() {
  const gl = useThree((s) => s.gl);
  const box = useRef<HTMLDivElement | null>(null);
  const tally = useRef({ frames: 0, time: 0 });

  useEffect(() => {
    const host = gl.domElement.closest(".scene-canvas");
    if (!host) return;
    const div = document.createElement("div");
    div.className = "fps-debug";
    div.setAttribute("aria-hidden", "true");
    div.textContent = "… fps";
    host.appendChild(div);
    box.current = div;
    return () => {
      div.remove();
      box.current = null;
    };
  }, [gl]);

  useFrame((_, delta) => {
    const t = tally.current;
    t.frames++;
    t.time += delta;
    if (t.time * 1000 < EVERY_MS || !box.current) return;
    const { calls, triangles } = gl.info.render;
    const { geometries, textures } = gl.info.memory;
    box.current.textContent = `${Math.round(t.frames / t.time)} fps · ${calls} calls · ${(triangles / 1000).toFixed(1)}k tris · ${geometries} geo · ${textures} tex`;
    t.frames = 0;
    t.time = 0;
  });

  return null;
}
