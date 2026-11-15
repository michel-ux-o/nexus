import { sphere } from './geometry';
import type { ArtifactMesh, ArtifactScene, Geometry, Vec3 } from './types';

// Each curtain follows the same closed, undulating field, but has its own
// radius and phase. The changing radial lean makes its folds visible in depth.
function curtain(radius: number, width: number, phase: number, segments: number, rows: number): Geometry {
  const positions: number[] = [], normals: number[] = [];
  const point = (u: number, v: number): Vec3 => {
    const a = u * Math.PI * 2;
    const edge = (v - 0.5) * width;
    const wave = Math.sin(2 * a + phase);
    const r = radius + 0.16 * Math.sin(3 * a + phase) + edge * (0.26 * Math.sin(a + phase) + 0.12 * wave);
    const height = 0.43 * Math.sin(a + phase * 0.45) + 0.16 * Math.sin(3 * a - phase)
      + edge * (0.85 + 0.15 * Math.cos(2 * a + phase));
    return [r * Math.cos(a), height, r * Math.sin(a)];
  };
  const add = (u: number, v: number) => {
    const p = point(u, v), a = point(u + 0.0001, v), b = point(u, v + 0.0001);
    const x: Vec3 = [a[0] - p[0], a[1] - p[1], a[2] - p[2]];
    const y: Vec3 = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
    const n: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const length = Math.hypot(...n) || 1;
    positions.push(...p); normals.push(n[0] / length, n[1] / length, n[2] / length);
  };
  for (let i = 0; i < segments; i++) for (let j = 0; j < rows; j++) {
    const u = i / segments, U = (i + 1) / segments, v = j / rows, V = (j + 1) / rows;
    add(u, v); add(U, v); add(U, V); add(u, v); add(U, V); add(u, V);
  }
  return { positions, normals };
}

export function createAuroraScene(detail: 'low' | 'high'): ArtifactScene {
  const high = detail === 'high';
  const meshes: ArtifactMesh[] = [];
  const bands: Array<[number, number, number, Vec3, number, Vec3]> = [
    [1.36, 1.03, 0.0, [0.04, 0.65, 0.60], 0.19, [0.18, 0, -0.22]],
    [1.23, 0.86, 1.2, [0.04, 0.48, 0.78], 0.19, [-0.18, 0.24, 0.20]],
    [1.48, 0.62, 2.4, [0.10, 0.78, 0.58], 0.17, [0.30, -0.18, -0.08]],
    [1.08, 0.66, 3.5, [0.19, 0.76, 0.76], 0.20, [-0.30, 0.12, 0.16]],
    [1.55, 0.32, 4.8, [0.15, 0.68, 0.81], 0.17, [0.05, 0.20, 0.28]],
  ];
  for (const [radius, width, phase, color, opacity, rotation] of bands) {
    meshes.push({ geometry: curtain(radius, width, phase, high ? 112 : 48, high ? 5 : 3), color, opacity, emissive: 0.65, metallic: 0.12, additive: true, rotation, spin: [0, 0.025, 0] });
  }
  // Narrow strands trace the folds instead of forming separate flat rings.
  for (let i = 0; i < 7; i++) {
    meshes.push({ geometry: curtain(1.08 + i * 0.075, 0.014 + (i % 2) * 0.006, i * 0.82, high ? 96 : 40, 1), color: i % 3 === 0 ? [0.35, 0.95, 0.77] : [0.16, 0.75, 0.87], opacity: 0.42, emissive: 0.9, additive: true, rotation: [0.18 - i * 0.055, i * 0.12, -0.20 + i * 0.06], spin: [0, 0.025, 0] });
  }
  const count = high ? 30 : 14;
  const particle = sphere(1, high ? 8 : 6, high ? 6 : 4);
  for (let i = 0; i < count; i++) {
    const a = i * 2.399963, r = 0.95 + 0.72 * ((i * 7 % count) / count);
    const size = 0.009 + (i % 4) * 0.004;
    meshes.push({ geometry: particle, color: i % 3 === 0 ? [0.49, 1, 0.75] : [0.25, 0.88, 1], opacity: 0.75, emissive: 1, additive: true, position: [r * Math.cos(a), 0.56 * Math.sin(a * 2.1), r * Math.sin(a)], scale: [size, size, size], orbit: [0.015, 0.035, 0.01] });
  }
  return { meshes, background: [0.039, 0.067, 0.071], light: [0.48, 0.95, 0.85], label: 'Aurora-Torus' };
}
