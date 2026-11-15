import type { ArtifactScene, Geometry, Vec3 } from './types';

type Point = Vec3;
const point = (r: number, lat: number, lon: number): Point => [r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon)];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Point): Point => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const empty = (): Geometry => ({ positions: [], normals: [] });
function tri(g: Geometry, a: Point, b: Point, c: Point) {
  const n = unit(cross(sub(b, a), sub(c, a)));
  g.positions.push(...a, ...b, ...c);
  g.normals.push(...n, ...n, ...n);
}
function quad(g: Geometry, a: Point, b: Point, c: Point, d: Point) { tri(g, a, b, c); tri(g, a, c, d); }

// A faceted sphere built from triangles, including a little irregularity in the core.
function core(segments: number, rings: number, radius: number): Geometry {
  const g = empty();
  const vertex = (i: number, j: number): Point => {
    const lat = -Math.PI / 2 + Math.PI * i / rings;
    const lon = 2 * Math.PI * j / segments + (i % 2) * Math.PI / segments;
    const uneven = i === 0 || i === rings ? 1 : 1 + 0.065 * Math.sin(i * 7.1 + j * 4.3);
    return point(radius * uneven, lat, lon);
  };
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
    const a = vertex(i, j), b = vertex(i, j + 1), c = vertex(i + 1, j + 1), d = vertex(i + 1, j);
    if (i > 0) tri(g, a, b, d);
    if (i < rings - 1) tri(g, b, c, d);
  }
  return g;
}

// Irregular, inset plates leave wide fractures through which the core remains visible.
function shell(radius: number, rows: number, columns: number, detail: number, seed: number): Geometry {
  const g = empty();
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    if ((row * 7 + col * 11 + seed) % 5 < 2) continue;
    const lat0 = -1.12 + row * 2.24 / rows + 0.055;
    const lat1 = -1.12 + (row + 1) * 2.24 / rows - 0.055;
    const lon0 = (col + (row % 2) * 0.35) * 2 * Math.PI / columns + 0.08;
    const lon1 = (col + 0.83 + (row % 2) * 0.35) * 2 * Math.PI / columns - 0.08;
    const lift = 0.035 * Math.sin(row * 9 + col * 13 + seed);
    // Skew each shard and taper its ends into a crystalline silhouette.
    const surface = (u: number, v: number, inset: number): Point => {
      const lat = lat0 + (lat1 - lat0) * u;
      const taper = 0.11 * Math.abs(2 * u - 1);
      const lon = lon0 + (lon1 - lon0) * (taper + v * (1 - 2 * taper)) + 0.08 * (u - 0.5) * Math.sin(col * 4 + seed);
      return point(radius + lift - inset, lat, lon);
    };
    for (let i = 0; i < detail; i++) for (let j = 0; j < detail; j++) {
      const a = i / detail, b = (i + 1) / detail, c = j / detail, d = (j + 1) / detail;
      quad(g, surface(a, c, 0), surface(a, d, 0), surface(b, d, 0), surface(b, c, 0));
      quad(g, surface(a, d, 0.075), surface(a, c, 0.075), surface(b, c, 0.075), surface(b, d, 0.075));
    }
    for (let i = 0; i < detail; i++) {
      const a = i / detail, b = (i + 1) / detail;
      quad(g, surface(0, a, 0), surface(0, a, 0.075), surface(0, b, 0.075), surface(0, b, 0));
      quad(g, surface(1, b, 0), surface(1, b, 0.075), surface(1, a, 0.075), surface(1, a, 0));
      quad(g, surface(b, 0, 0), surface(b, 0, 0.075), surface(a, 0, 0.075), surface(a, 0, 0));
      quad(g, surface(a, 1, 0), surface(a, 1, 0.075), surface(b, 1, 0.075), surface(b, 1, 0));
    }
  }
  return g;
}

function strut(g: Geometry, a: Point, b: Point, width: number) {
  const axis = unit(sub(b, a));
  const side = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const up = unit(cross(axis, side));
  const corner = (p: Point, x: number, y: number): Point => [p[0] + width * (side[0] * x + up[0] * y), p[1] + width * (side[1] * x + up[1] * y), p[2] + width * (side[2] * x + up[2] * y)];
  const ends = (p: Point) => [corner(p, -1, -1), corner(p, 1, -1), corner(p, 1, 1), corner(p, -1, 1)];
  const x = ends(a), y = ends(b);
  for (let i = 0; i < 4; i++) quad(g, x[i], x[(i + 1) % 4], y[(i + 1) % 4], y[i]);
  quad(g, x[3], x[2], x[1], x[0]); quad(g, y[0], y[1], y[2], y[3]);
}
function framework(): Geometry {
  const g = empty();
  // Broken orbital polygon arcs, in different planes, leave breathing room around the core.
  for (let orbit = 0; orbit < 3; orbit++) {
    const count = 12;
    const p = (i: number): Point => {
      const t = i * 2 * Math.PI / count + orbit * 0.32;
      const x = 1.65 * Math.cos(t), y = 1.65 * Math.sin(t);
      return orbit === 0 ? [x, y, 0] : orbit === 1 ? [x, y * 0.37, y * 0.93] : [x * 0.35, y, x * 0.94];
    };
    for (let i = 0; i < count; i++) if ((i + orbit * 2) % 5 !== 0) strut(g, p(i), p(i + 1), 0.018);
  }
  return g;
}

// Short radial spars and floating faceted splinters make the shell feel constructed,
// while the gaps preserve its open, dimensional silhouette.
function architecture(): Geometry {
  const g = empty();
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI * 2 / 12 + 0.13;
    const y = (i % 3 - 1) * 0.36;
    const at = (r: number): Point => [Math.cos(angle) * r, y, Math.sin(angle) * r];
    strut(g, at(0.86), at(1.23 + (i % 3) * 0.09), 0.015);
    if (i % 2 === 0) strut(g, at(1.30), at(1.47), 0.029);
  }
  return g;
}

function splinters(count: number): Geometry {
  const g = empty();
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count, angle = i * 2.399963 + 0.4;
    const radial: Point = [Math.sqrt(1 - y * y) * Math.cos(angle), y, Math.sqrt(1 - y * y) * Math.sin(angle)];
    const tangent = unit(cross(radial, Math.abs(y) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const binormal = unit(cross(radial, tangent));
    const r = 1.48 + 0.24 * (0.5 + 0.5 * Math.sin(i * 8.3));
    const size = 0.055 + (i % 4) * 0.018;
    const p = (a: number, b: number, c: number): Point => [radial[0] * (r + a * size) + tangent[0] * b * size + binormal[0] * c * size, radial[1] * (r + a * size) + tangent[1] * b * size + binormal[1] * c * size, radial[2] * (r + a * size) + tangent[2] * b * size + binormal[2] * c * size];
    const tip = p(1.7, 0, 0), base = [p(-0.7, -0.6, -0.25), p(-0.7, 0.6, -0.25), p(-0.7, 0.25, 0.55)];
    for (let j = 0; j < 3; j++) tri(g, tip, base[j], base[(j + 1) % 3]);
    tri(g, base[2], base[1], base[0]);
  }
  return g;
}
function particles(count: number): Geometry {
  const g = empty();
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count, angle = i * 2.399963;
    const r = 1.72 + 0.19 * (0.5 + 0.5 * Math.sin(i * 13.7));
    const c: Point = [Math.sqrt(1 - y * y) * Math.cos(angle) * r, y * r, Math.sqrt(1 - y * y) * Math.sin(angle) * r];
    const s = 0.018 + (i % 4) * 0.004;
    const p = (x: number, y1: number, z: number): Point => [c[0] + x * s, c[1] + y1 * s, c[2] + z * s];
    const top = p(0, 1, 0), bottom = p(0, -1, 0), rim = [p(1, 0, 0), p(0, 0, 1), p(-1, 0, 0), p(0, 0, -1)];
    for (let j = 0; j < 4; j++) { tri(g, top, rim[j], rim[(j + 1) % 4]); tri(g, bottom, rim[(j + 1) % 4], rim[j]); }
  }
  return g;
}

export function createNexusScene(detail: 'low' | 'high'): ArtifactScene {
  const high = detail === 'high';
  return {
    label: 'Dimensionskern',
    background: [0.027, 0.035, 0.059],
    light: [0.66, 0.73, 1],
    meshes: [
      { geometry: core(high ? 18 : 12, high ? 10 : 7, 0.49), color: [0.82, 0.65, 1], emissive: 1.05, metallic: 0.22, spin: [0.12, 0.19, 0.07] },
      { geometry: core(high ? 16 : 10, high ? 9 : 6, 0.72), color: [0.47, 0.19, 0.91], opacity: 0.16, emissive: 0.7, additive: true, spin: [-0.09, 0.13, 0.04] },
      { geometry: shell(0.97, 3, 7, high ? 2 : 1, 1), color: [0.58, 0.38, 0.89], metallic: 0.8, emissive: 0.18, rotation: [0.32, 0.1, 0.22], spin: [0.055, 0.12, -0.035] },
      { geometry: shell(1.30, 3, 8, high ? 2 : 1, 3), color: [0.3, 0.2, 0.57], metallic: 0.9, emissive: 0.09, rotation: [0.9, 0.4, 0.1], spin: [-0.065, -0.06, 0.045] },
      { geometry: architecture(), color: [0.66, 0.47, 0.95], metallic: 0.9, emissive: 0.22, rotation: [0.32, 0.1, 0.22], spin: [0.055, 0.12, -0.035] },
      { geometry: framework(), color: [0.71, 0.51, 1], metallic: 0.9, emissive: 0.28, rotation: [0.3, 0.2, 0.1], spin: [0.025, -0.055, 0.035] },
      { geometry: splinters(high ? 32 : 18), color: [0.52, 0.34, 0.83], metallic: 0.8, emissive: 0.2, spin: [-0.025, 0.045, 0.02] },
      { geometry: particles(high ? 90 : 45), color: [0.76, 0.67, 1], emissive: 0.9, spin: [-0.025, 0.045, 0.02] },
    ],
  };
}
