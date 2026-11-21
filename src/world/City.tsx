import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BackSide,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Fog,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Group,
  type Material,
  type Object3D,
  type PerspectiveCamera,
} from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { STREET_Y, type OfficeLayout } from "../layout";
import type { Phase } from "../scene/OfficeScene";
import { useStore } from "../store";
import { cityFor, STYLE, type CityGrid, type Cyl, type Glow } from "./cityGrid";
import { citySeedFor } from "./rng";
import { signalAt } from "./signals";
import { HEAD_COLOR, LightPools, LIT, UNLIT } from "./StreetFurniture";

// City round (2026-11-21): the 5 × 5 blocks round the office (3 × 3 walkable), drawn from cityGrid.ts.
// Lazy: Exterior mounts it inside its hidden group the first time the building is seen from outside or walked,
// so office view never loads it, never draws it, and its first load is unchanged.
//
// Draw calls (outside view and walk only), all instanced or single meshes, none casting shadows:
//   solids (buildings, slabs, curbs, furniture, cars: one shader) 1 · cylinders 1 · tank roofs 1 · tree crowns 1
//   · glows (lamp heads, signal lenses, globes, cab lights, beacons) 1 · road markings 1 · asphalt 1 · skyline 1
//   · sky 1 · light pools 1 (evening/night) = 9 by day, 10 after dark.
// Windows are drawn by the shader from the box's own size (no textures), so a 200 m tower costs the same 12
// triangles as a newsstand. In the outside view, buildings between the camera and the office are cut away
// (dithered), so the office is never hidden.

const FAR = 2500; // the camera's far plane while the city shows (office view keeps its own 300)
const SKY: Record<Phase, { top: string; horizon: string; far: string }> = {
  morning: { top: "#9fc0e0", horizon: "#f1dcc4", far: "#a49ea4" },
  day: { top: "#7aa8d6", horizon: "#dde4e8", far: "#9aa6b4" },
  evening: { top: "#4d5d93", horizon: "#eeb084", far: "#6f6178" },
  night: { top: "#070b1a", horizon: "#232842", far: "#15182b" },
};
const LIT_SHARE: Record<Phase, number> = { morning: 0.06, day: 0, evening: 0.3, night: 0.4 };
const DIM: Record<Phase, number> = { morning: 0.95, day: 1, evening: 0.75, night: 0.42 };
const PAVE_TINT: Record<Phase, string> = { morning: "#ffffff", day: "#ffffff", evening: "#d8d4d0", night: "#9a98a6" }; // Exterior's SIDEWALK_TINT
const ASPHALT: Record<Phase, string> = { morning: "#5f5f62", day: "#646467", evening: "#4b4b50", night: "#2c2d34" };
const FOG = { walk: [40, 700], outside: [160, 1200] } as const;

const GLOW_COLOR = (kind: Glow["kind"], phase: Phase): string => {
  const dark = phase === "evening" || phase === "night";
  switch (kind) {
    case "head":
      return HEAD_COLOR[phase];
    case "globe":
      return dark ? "#62e38f" : "#3f8f5a";
    case "cab":
      return dark ? "#fff1b8" : "#e9e1c2";
    case "crown":
      return dark ? "#ffd27a" : "#d9cfbd";
    case "beacon":
      return "#ff3326";
    default:
      return UNLIT;
  }
};

// ---- The shader patch: a MeshStandardMaterial that knows the box it's drawing ----------------------------

const VERT_HEAD = /* glsl */ `
attribute vec4 aCity;
flat varying vec4 vCity;
varying vec3 vCityLocal;
flat varying vec3 vCitySize;
flat varying vec3 vCityN;
varying vec3 vCityWorld;
`;
const VERT_BODY = /* glsl */ `
vCity = aCity;
vec3 cSz = vec3(1.0);
vec4 cW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  cSz = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  cW = instanceMatrix * cW;
#endif
vCitySize = cSz;
vCityLocal = (position + 0.5) * cSz;
vCityN = normal;
vCityWorld = (modelMatrix * cW).xyz;
`;
const FRAG_HEAD = /* glsl */ `
uniform float uLit;
uniform float uDim;
uniform vec3 uPaveTint;
uniform float uCutOn;
uniform vec3 uCutCam;
uniform vec3 uCutTarget;
uniform float uCutR0;
uniform float uCutR1;
// flat: per-instance values must not be interpolated. Interpolating a "constant" jitters it by an ulp per pixel,
// and the window hash turns that into speckles (seen in this round's first captures).
flat varying vec4 vCity;
varying vec3 vCityLocal;
flat varying vec3 vCitySize;
flat varying vec3 vCityN;
varying vec3 vCityWorld;
float cityHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float cityRect(vec2 f, vec2 halfSize, vec2 aa) {
  vec2 d = abs(f - 0.5) - halfSize;
  vec2 m = 1.0 - smoothstep(-aa, aa, d);
  return m.x * m.y;
}
`;
// Outside view only: a corridor from the office to the camera. Anything above the line of sight inside it is
// dropped with a dithered edge, the way a sim cuts away walls. Behind the office (t < 0) nothing is cut.
const FRAG_CUT = /* glsl */ `
if (uCutOn > 0.5 && vCity.x > 1.5) {
  vec2 cutA = uCutTarget.xz;
  vec2 cutAB = uCutCam.xz - cutA;
  float cutT = dot(vCityWorld.xz - cutA, cutAB) / max(dot(cutAB, cutAB), 1.0);
  if (cutT > 0.0) {
    float cutC = min(cutT, 1.0);
    float cutR = mix(uCutR0, uCutR1, cutC);
    float cutD = length(vCityWorld.xz - (cutA + cutAB * cutC));
    float cutY = mix(uCutTarget.y, uCutCam.y, cutC) - cutR * 0.6;
    float cutSoft = clamp((cutD - cutR) / 3.0, 0.0, 1.0);
    if (vCityWorld.y > cutY && cutSoft < cityHash(floor(gl_FragCoord.xy))) discard;
  }
}
`;
// Windows by style, from the face's own size (whole bays, so no window is cut at a corner), a shopfront band on
// boxes that start at the ground, a parapet, lit windows after dark (whole floors more often than not), and an
// average colour once a window is smaller than a pixel (no moiré far away). Pavement joints on slab tops.
const FRAG_FACADE = /* glsl */ `
{
  float cStyle = vCity.x;
  vec3 cN = vCityN;
  bool cX = abs(cN.x) > 0.5;
  float cU = cX ? vCityLocal.z : vCityLocal.x;
  float cSU = max(cX ? vCitySize.z : vCitySize.x, 0.01);
  float cFloorH = max(vCity.y, 0.5);
  float cBay = max(vCity.z, 0.5);
  float cSeed = floor(vCity.w * 997.0 + 0.5) / 997.0;
  float cNb = max(1.0, floor(cSU / cBay + 0.5));
  vec2 cCell = vec2(cU / cSU * cNb, (vCityWorld.y - 4.2) / cFloorH);
  // Never a zero-width smoothstep (undefined in GLSL: some drivers return NaN, which shows as speckles).
  vec2 cAA = max(fwidth(cCell) * 0.75, vec2(0.002));
  float cNs = max(1.0, floor(cSU / (cBay * 1.7) + 0.5));
  vec2 cShop = vec2(cU / cSU * cNs, (vCityWorld.y - 0.45) / 2.9);
  vec2 cShopAA = max(fwidth(cShop) * 0.75, vec2(0.002));
  vec2 cPave = vCityWorld.xz / 1.5;
  vec2 cPaveAA = max(fwidth(cPave), vec2(0.002));
  if (cStyle > 0.5 && cStyle < 1.5) {
    if (cN.y > 0.5) {
      vec2 cF = abs(fract(cPave) - 0.5);
      vec2 cJ = smoothstep(0.485 - cPaveAA, 0.485 + cPaveAA * 0.5, cF);
      float cJoint = max(cJ.x, cJ.y) * (1.0 - clamp(max(cPaveAA.x, cPaveAA.y) * 4.0 - 1.0, 0.0, 1.0));
      diffuseColor.rgb *= 1.0 - 0.3 * cJoint;
    }
    diffuseColor.rgb *= uPaveTint;
  } else if (cStyle > 1.5 && cStyle < 6.5) {
    vec3 cWall = diffuseColor.rgb;
    if (cN.y > 0.5) {
      diffuseColor.rgb = cWall * 0.5 * uDim;
    } else if (cN.y > -0.5) {
      vec2 cHalf = cStyle < 2.5 ? vec2(0.22, 0.27) : cStyle < 3.5 ? vec2(0.25, 0.3) : cStyle < 4.5 ? vec2(0.46, 0.42) : cStyle < 5.5 ? vec2(0.5, 0.24) : vec2(0.19, 0.36);
      float cTop = step(vCityLocal.y, vCitySize.y - 0.9);
      float cBottom = vCityWorld.y - vCityLocal.y;
      float cFar = clamp(max(cAA.x, cAA.y) * 3.0 - 0.6, 0.0, 1.0);
      float cMask;
      float cLit;
      vec2 cId;
      if (vCityWorld.y < 4.2 && cBottom < 0.5) {
        cId = vec2(floor(cShop.x), -7.0);
        float cBand = step(0.0, cShop.y) * step(cShop.y, 1.0);
        cMask = cityRect(vec2(fract(cShop.x), clamp(cShop.y, 0.0, 1.0)), vec2(0.44, 0.5), cShopAA) * cBand;
        cLit = step(cityHash(cId + cSeed * 17.0 + (cX ? 3.1 : 7.7)), 0.8) * step(0.01, uLit);
      } else {
        cId = floor(cCell);
        cMask = cityRect(fract(cCell), cHalf, cAA) * cTop * step(0.0, cCell.y);
        cMask = mix(cMask, 4.0 * cHalf.x * cHalf.y * cTop, cFar);
        float cFloorOn = cityHash(vec2(cId.y + 0.5, cSeed * 31.0 + 1.7));
        float cH = cityHash(cId + vec2(cSeed * 13.0, cX ? 5.0 : 11.0));
        cLit = step(cH, uLit * (0.4 + 1.2 * cFloorOn));
        cLit = mix(cLit, uLit, cFar);
      }
      bool cGlassy = cStyle > 3.5 && cStyle < 4.5;
      vec3 cPane = cGlassy ? mix(cWall * 0.55, cWall * 1.3 + 0.04, clamp(vCityLocal.y / vCitySize.y, 0.0, 1.0)) : vec3(0.1, 0.12, 0.15);
      vec3 cSpandrel = cGlassy ? cWall * 0.7 : cWall;
      vec3 cWarm = mix(vec3(1.0, 0.6, 0.26), vec3(0.62, 0.72, 0.9), step(0.72, cityHash(cId + cSeed)));
      // Panes keep the wall's rough finish: a glossy pane gave a noisy sun glint (round's first capture).
      diffuseColor.rgb = mix(cSpandrel, cPane, cMask) * uDim;
      totalEmissiveRadiance += cWarm * cLit * cMask * 0.7;
    }
  } else {
    diffuseColor.rgb *= uDim;
  }
}
`;

type Uniforms = ReturnType<typeof makeUniforms>;
function makeUniforms() {
  return {
    uLit: { value: 0 },
    uDim: { value: 1 },
    uPaveTint: { value: new Color("#ffffff") },
    uCutOn: { value: 0 },
    uCutCam: { value: new Vector3() },
    uCutTarget: { value: new Vector3() },
    uCutR0: { value: 18 },
    uCutR1: { value: 9 },
  };
}

function cityMaterial(U: Uniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_HEAD}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_HEAD}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${FRAG_CUT}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${FRAG_FACADE}`);
  };
  m.customProgramCacheKey = () => "siverse-city-1";
  return m;
}

// ---- Building the meshes, once per grid ---------------------------------------------------------------------

const m4 = new Matrix4();
const col = new Color();

function finish(mesh: InstancedMesh, receive = true): InstancedMesh {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = false;
  mesh.receiveShadow = receive;
  return mesh;
}

function instanced(geo: BufferGeometry, mat: Material, count: number, fill: (i: number) => { m: Matrix4; color: string; city?: number[] }) {
  const mesh = new InstancedMesh(geo, mat, Math.max(1, count));
  const city = new Float32Array(Math.max(1, count) * 4);
  for (let i = 0; i < count; i++) {
    const f = fill(i);
    mesh.setMatrixAt(i, f.m);
    mesh.setColorAt(i, col.set(f.color)); // before the first render, so the shader has instance colours
    if (f.city) city.set(f.city, i * 4);
  }
  mesh.count = count;
  geo.setAttribute("aCity", new InstancedBufferAttribute(city, 4));
  return mesh;
}

interface Built {
  list: Object3D[];
  glows: InstancedMesh;
  marks: InstancedMesh;
  crowns: InstancedMesh;
  far: InstancedMesh;
  asphalt: Mesh;
  sky: Mesh;
  skyMat: ShaderMaterial;
  lensesByCrossing: number[][]; // glow indices per intersection
  dispose: () => void;
}

function build(grid: CityGrid, U: Uniforms): Built {
  const mat = cityMaterial(U);
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [mat];
  const keep = <T extends BufferGeometry>(g: T) => (geos.push(g), g);
  const keepM = <T extends Material>(m: T) => (mats.push(m), m);

  // calls: +1. Buildings, slabs, curbs, furniture, cars, barriers. No shadows received either: the sun's shadow
  // box is fitted to the office (±21 m), and sampling it on 200 m facades only adds noise at its edge.
  const solids = finish(
    instanced(keep(new BoxGeometry(1, 1, 1)), mat, grid.solids.length, (i) => {
      const s = grid.solids[i];
      return { m: m4.makeScale(s.w, s.h, s.d).setPosition(s.x, s.y + s.h / 2, s.z), color: s.color, city: [STYLE[s.style], s.floorH ?? 3.5, s.bay ?? 2, s.seed ?? 0] };
    }),
    false,
  );
  const cylFill = (list: Cyl[]) => (i: number) => {
    const c = list[i];
    return { m: m4.makeScale(c.r, c.h, c.r).setPosition(c.x, c.y + c.h / 2, c.z), color: c.color, city: [c.cut ? STYLE.roof : STYLE.plain, 0, 0, 0] };
  };
  // calls: +1 (trunks, hydrants, tanks, posts) and +1 (tank roofs).
  const cyls = finish(instanced(keep(new CylinderGeometry(1, 1, 1, 10)), mat, grid.cyls.length, cylFill(grid.cyls)), false);
  const cones = finish(instanced(keep(new ConeGeometry(1, 1, 10)), mat, grid.cones.length, cylFill(grid.cones)), false);

  // calls: +1. Tree crowns, low-poly, flat shaded; the material colour dims them after dark.
  const crowns = finish(
    instanced(keep(new IcosahedronGeometry(1, 0)), keepM(new MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, flatShading: true })), grid.crowns.length, (i) => {
      const c = grid.crowns[i];
      return { m: m4.makeScale(c.r, c.r * 0.85, c.r).setPosition(c.x, c.y, c.z), color: c.color };
    }),
    false,
  );

  // calls: +1. Everything that glows: unlit and not tone-mapped, like the office's lamp heads and lenses.
  const lensesByCrossing: number[][] = grid.intersections.map(() => []);
  const glows = finish(
    instanced(keep(new BoxGeometry(1, 1, 1)), keepM(new MeshBasicMaterial({ toneMapped: false })), grid.glows.length, (i) => {
      const g = grid.glows[i];
      if (g.lens) lensesByCrossing[g.lens.at].push(i);
      return { m: m4.makeScale(g.w, g.h, g.d).setPosition(g.x, g.y, g.z), color: GLOW_COLOR(g.kind, "day") };
    }),
    false,
  );

  // calls: +1. Lane lines, bus lanes, crosswalks and stop bars: flat quads just over the asphalt, with a
  // polygon offset so they never flicker against it far away.
  const plane = keep(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const marks = finish(
    instanced(
      plane,
      keepM(new MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })),
      grid.marks.length,
      (i) => {
        const k = grid.marks[i];
        return { m: m4.makeScale(k.w, 1, k.d).setPosition(k.x, STREET_Y + 0.006, k.z), color: k.color };
      },
    ),
  );

  // calls: +1. The asphalt under the whole city and out to the haze. Over Exterior's fading street plane.
  const asphaltMat = keepM(new MeshStandardMaterial({ color: ASPHALT.day, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const asphalt = new Mesh(keep(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), asphaltMat);
  asphalt.position.set(grid.centre[0], STREET_Y + 0.003, grid.centre[1]);
  asphalt.scale.set(4000, 1, 4000);
  asphalt.receiveShadow = true;

  // calls: +1. The skyline: plain boxes, no fog (they are the haze), coloured per phase.
  const far = finish(
    instanced(keep(new BoxGeometry(1, 1, 1)), keepM(new MeshBasicMaterial({ fog: false, toneMapped: false })), grid.far.length, (i) => {
      const f = grid.far[i];
      return { m: m4.makeScale(f.w, f.h, f.d).setPosition(f.x, STREET_Y + f.h / 2, f.z), color: "#9aa6b4" };
    }),
    false,
  );

  // calls: +1. The sky: a small sphere that follows the camera, drawn at the far plane, behind everything.
  const skyMat = keepM(
    new ShaderMaterial({
      uniforms: { uTop: { value: new Color() }, uHorizon: { value: new Color() } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        varying vec3 vDir;
        void main() {
          float h = normalize(vDir).y;
          gl_FragColor = vec4(mix(uHorizon, uTop, smoothstep(0.0, 0.5, h)), 1.0);
          #include <colorspace_fragment>
        }`,
      side: BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  const sky = new Mesh(keep(new SphereGeometry(50, 24, 12)), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;

  return {
    list: [sky, asphalt, solids, cyls, cones, crowns, glows, marks, far],
    glows,
    marks,
    crowns,
    far,
    asphalt,
    sky,
    skyMat,
    lensesByCrossing,
    dispose: () => {
      for (const m of [solids, cyls, cones, crowns, glows, marks, far]) m.dispose();
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}

export default function City({ layout, phase, name }: { layout: OfficeLayout; phase: Phase; name: string }) {
  const citySeed = useStore((s) => s.citySeed);
  const grid = useMemo(() => cityFor(layout, citySeedFor(name, citySeed)), [layout, name, citySeed]);
  const U = useMemo(makeUniforms, []);
  const built = useMemo(() => build(grid, U), [grid, U]);
  useEffect(() => () => built.dispose(), [built]);
  const root = useRef<Group>(null);
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const scene = useThree((s) => s.scene);
  const fog = useMemo(() => new Fog("#dde4e8", FOG.outside[0], FOG.outside[1]), []);

  // The office's size sets the cutaway near it: half its longer side, plus a margin.
  useEffect(() => {
    const b = layout.bounds;
    U.uCutR0.value = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 3;
  }, [layout, U]);

  // Phase: uniforms and the per-phase colours (a few hundred writes, only when the phase changes).
  useEffect(() => {
    U.uLit.value = LIT_SHARE[phase];
    U.uDim.value = DIM[phase];
    U.uPaveTint.value.set(PAVE_TINT[phase]);
    const sky = SKY[phase];
    built.skyMat.uniforms.uTop.value.set(sky.top);
    built.skyMat.uniforms.uHorizon.value.set(sky.horizon);
    fog.color.set(sky.horizon);
    (built.asphalt.material as MeshStandardMaterial).color.set(ASPHALT[phase]);
    const dim = DIM[phase];
    (built.marks.material as MeshStandardMaterial).color.setScalar(dim);
    (built.crowns.material as MeshStandardMaterial).color.setScalar(dim);
    const horizon = new Color(sky.horizon);
    const tone = new Color(sky.far);
    grid.far.forEach((f, i) => built.far.setColorAt(i, col.copy(tone).lerp(horizon, 0.15 + 0.6 * f.t)));
    built.far.instanceColor!.needsUpdate = true;
    grid.glows.forEach((g, i) => {
      if (!g.lens) built.glows.setColorAt(i, col.set(GLOW_COLOR(g.kind, phase)));
    });
    built.glows.instanceColor!.needsUpdate = true;
  }, [phase, built, grid, U, fog]);

  // Lenses: each intersection's light on its own offset of the 90 s clock (a green wave up the avenues).
  // Colours are rewritten only for a crossing whose light changed.
  const lensKeys = useRef<string[]>([]);
  const paintLenses = (now: number) => {
    let changed = false;
    grid.intersections.forEach((x, at) => {
      const s = signalAt(now - x.offset);
      const key = s.avenue + s.street;
      if (lensKeys.current[at] === key) return;
      lensKeys.current[at] = key;
      changed = true;
      for (const i of built.lensesByCrossing[at]) {
        const l = grid.glows[i].lens!;
        built.glows.setColorAt(i, col.set(s[l.road] === l.lamp ? LIT[l.lamp] : UNLIT));
      }
    });
    if (changed) built.glows.instanceColor!.needsUpdate = true;
  };
  useEffect(() => {
    lensKeys.current = [];
    paintLenses(Date.now());
  }, [built]);

  // Fog, the far plane and the sky follow the outside view / walk mode (Exterior's group `visible`); office view
  // gets its own camera far plane and no fog back, so it renders exactly as before.
  const shown = useRef(false);
  const stretched = useRef<{ cam: PerspectiveCamera; far: number } | null>(null);
  const prevFog = useRef(scene.fog);
  useEffect(
    () => () => {
      scene.fog = prevFog.current;
      const s = stretched.current;
      if (s) {
        s.cam.far = s.far;
        s.cam.updateProjectionMatrix();
      }
      stretched.current = null;
    },
    [scene],
  );
  useFrame(({ camera }) => {
    const vis = !!root.current?.parent?.visible;
    const cam = camera as PerspectiveCamera;
    const walk = !!cam.userData.walk;
    if (vis !== shown.current) {
      shown.current = vis;
      scene.fog = vis ? fog : prevFog.current;
    }
    if (vis && !walk && cam.far < FAR && !stretched.current) {
      stretched.current = { cam, far: cam.far };
      cam.far = FAR;
      cam.updateProjectionMatrix();
    } else if (!vis && stretched.current) {
      const s = stretched.current;
      s.cam.far = s.far;
      s.cam.updateProjectionMatrix();
      stretched.current = null;
    }
    if (!vis) return;
    const [near, farD] = walk ? FOG.walk : FOG.outside;
    fog.near = near;
    fog.far = farD;
    built.sky.position.copy(cam.position);
    const target = controls?.target;
    if (!walk && target) {
      U.uCutOn.value = 1;
      U.uCutCam.value.copy(cam.position);
      U.uCutTarget.value.set(target.x, 1.5, target.z);
    } else U.uCutOn.value = 0;
    paintLenses(Date.now());
  });

  const night = phase === "evening" || phase === "night";
  return (
    <group ref={root}>
      {built.list.map((o) => (
        <primitive key={o.uuid} object={o} />
      ))}
      {/* calls: +1 at evening/night: the same two-level pools as the office's own lamps. */}
      {night && grid.lamps.length > 0 && <LightPools lamps={grid.lamps} phase={phase} />}
    </group>
  );
}
