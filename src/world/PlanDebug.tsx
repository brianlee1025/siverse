import { useEffect, useMemo, useRef } from "react";
import type { Department } from "../../shared/types";
import { buildLayout } from "../layout";
import { useStore } from "../store";
import { buildCityBlock, checkBlock, type CityBlock, type LotUse, type Rect, type Slot } from "./cityBlock";
import { citySeedFor } from "./rng";
import { signalAt } from "./signals";

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
  const seed = citySeedFor(companyName, citySeed);
  const block = useMemo(() => buildCityBlock(layout, seed), [layout, seed]);
  const problems = useMemo(() => {
    const out = checkBlock(block);
    if (JSON.stringify(buildCityBlock(layout, seed)) !== JSON.stringify(block)) out.push("not deterministic");
    // Bigger offices than this one: the deep-office guard and the frontage rule only matter there. buildLayout
    // reads only id and headcount. Three more builds per change (≈ 0.1 ms each), never per frame.
    for (const n of [1, 6, 9]) {
      const fake = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, headcount: 3 })) as unknown as Department[];
      for (const p of checkBlock(buildCityBlock(buildLayout(fake), seed))) out.push(`n=${n}: ${p}`);
    }
    // Round 13: the signal's timing over one 90 s cycle, in 0.5 s steps. Never both green, and green only moves
    // to the other approach through an all-red sample (checked across the wrap too).
    const samples = Array.from({ length: 180 }, (_, i) => signalAt(i * 500));
    const greenOf = (s: (typeof samples)[number]) => (s.avenue === "green" ? "avenue" : s.street === "green" ? "street" : null);
    if (samples.some((s) => s.avenue === "green" && s.street === "green")) out.push("signal: both green");
    const allRed = (s: (typeof samples)[number]) => s.avenue === "red" && s.street === "red";
    // The wrap: start from the cycle's last green, and count any all-red after it (88-90 s comes before sample 0).
    let last = samples.length - 1;
    while (last >= 0 && !greenOf(samples[last])) last--;
    let lastGreen = last >= 0 ? greenOf(samples[last]) : null;
    let sawAllRed = samples.slice(last + 1).some(allRed);
    for (const s of samples) {
      if (allRed(s)) sawAllRed = true;
      const g = greenOf(s);
      if (!g) continue;
      if (g !== lastGreen && !sawAllRed && !out.includes("signal: no all-red between greens")) out.push("signal: no all-red between greens");
      lastGreen = g;
      sawAllRed = false;
    }
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
      <div className="plan-debug__line">
        {(Object.keys(SLOT_COLOUR) as Slot["kind"][]).map((kind, i) => (
          <span key={kind}>
            {i > 0 && " "}
            <span style={{ color: SLOT_COLOUR[kind] }}>●</span> {kind}
          </span>
        ))}
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
  // Round 12: bigger dots with a dark ring, so the white lamp and grey bin read on the concrete.
  g.lineWidth = 0.75;
  g.strokeStyle = "rgba(0, 0, 0, 0.6)";
  for (const s of block.slots) {
    g.fillStyle = SLOT_COLOUR[s.kind];
    g.beginPath();
    g.arc(px(s.x), pz(s.z), 2.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}
