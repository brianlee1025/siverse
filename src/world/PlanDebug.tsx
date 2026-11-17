import { useEffect, useMemo, useRef } from "react";
import type { Department } from "../../shared/types";
import { buildLayout } from "../layout";
import { useStore } from "../store";
import { buildCityBlock, checkBlock, type CityBlock, type LotUse, type Rect, type Slot } from "./cityBlock";
import { hashSeed } from "./rng";

// ?plan (lazy chunk, roadmap 3a-i): a flat 2D map of the generated street block, top-right of the scene, with
// checkBlock's problems underneath. It's the only importer of cityBlock.ts and rng.ts, so the city code stays
// out of the main bundle. Drawn once per change (no animation loop) and it never touches the 3D scene.

const W = 300;
const H = 150;
const USE_COLOUR: Record<LotUse, string> = { walkup: "#c9a27e", shop: "#e0b36a", office: "#9fb3c8", tower: "#7d8fa6" };
const SLOT_COLOUR: Record<Slot["kind"], string> = { lamp: "#ffffff", signal: "#e03131", hydrant: "#f08c00", bin: "#868e96" };

export default function PlanDebug({ departments, companyName }: { departments: Department[]; companyName: string }) {
  // The same key as OfficeScene, so the plan follows the same floor plan.
  const floorPlanKey = departments.map((d) => `${d.id}:${d.headcount}`).join("|");
  const layout = useMemo(() => buildLayout(departments), [floorPlanKey]);
  const citySeed = useStore((s) => s.citySeed);
  const walking = useStore((s) => s.viewMode === "walk");
  const seed = citySeed ?? hashSeed(companyName.trim() || "Office");
  const block = useMemo(() => buildCityBlock(layout, seed), [layout, seed]);
  const problems = useMemo(() => {
    const out = checkBlock(block);
    if (JSON.stringify(buildCityBlock(layout, seed)) !== JSON.stringify(block)) out.push("not deterministic");
    return out;
  }, [block, layout, seed]);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (el) draw(el, block);
  }, [block, walking]);

  // Walk mode uses the top-right for its own chips.
  if (walking) return null;
  return (
    <div className="plan-debug" aria-hidden="true">
      <canvas ref={canvas} />
      <div className="plan-debug__line">
        seed {block.seed} · {block.lots.length} lots · {block.slots.length} slots · {problems.length} problem{problems.length === 1 ? "" : "s"}
      </div>
      <div className="plan-debug__line">
        {block.names.street} · {block.names.avenue}
      </div>
      {problems.map((p) => (
        <div key={p} className="plan-debug__line plan-debug__problem">
          {p}
        </div>
      ))}
      {block.skipped.map((s) => (
        <div key={s} className="plan-debug__line plan-debug__skipped">
          skipped: {s}
        </div>
      ))}
    </div>
  );
}

function draw(el: HTMLCanvasElement, block: CityBlock) {
  const dpr = window.devicePixelRatio || 1;
  el.width = Math.round(W * dpr);
  el.height = Math.round(H * dpr);
  el.style.aspectRatio = `${W} / ${H}`;
  const g = el.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  // The view: from the far streets' outer edges. +x right, +z down (the street at the bottom, as the office camera sees it).
  const all = block.streets.map((s) => s.rect);
  const minX = Math.min(...all.map((r) => r.x0));
  const maxX = Math.max(...all.map((r) => r.x1));
  const minZ = Math.min(...all.map((r) => r.z0));
  const maxZ = Math.max(...all.map((r) => r.z1));
  const k = Math.min(W / (maxX - minX), H / (maxZ - minZ));
  const ox = (W - (maxX - minX) * k) / 2;
  const oz = (H - (maxZ - minZ) * k) / 2;
  const px = (x: number) => ox + (x - minX) * k;
  const pz = (z: number) => oz + (z - minZ) * k;
  const fill = (r: Rect, colour: string, outline?: string) => {
    g.fillStyle = colour;
    g.fillRect(px(r.x0), pz(r.z0), (r.x1 - r.x0) * k, (r.z1 - r.z0) * k);
    if (!outline) return;
    g.strokeStyle = outline;
    g.lineWidth = 0.5;
    g.strokeRect(px(r.x0), pz(r.z0), (r.x1 - r.x0) * k, (r.z1 - r.z0) * k);
  };

  for (const s of block.streets) fill(s.rect, "#8e8a84");
  for (const s of block.sidewalks) fill(s, "#cfc9bf");
  for (const lot of block.lots) fill(lot.rect, USE_COLOUR[lot.use], "rgba(0, 0, 0, 0.35)");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e07a5f";
  fill(block.office, accent, "rgba(0, 0, 0, 0.5)");
  for (const s of block.slots) {
    g.fillStyle = SLOT_COLOUR[s.kind];
    g.beginPath();
    g.arc(px(s.x), pz(s.z), 1.5, 0, Math.PI * 2);
    g.fill();
  }
}
