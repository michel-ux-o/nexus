import type { ArtifactMesh, ArtifactScene, Geometry, Vec3 } from './types';

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

function triangle(geometry: Geometry, a: Vec3, b: Vec3, c: Vec3) {
  const normal = normalize(cross(subtract(b, a), subtract(c, a)));
  geometry.positions.push(...a, ...b, ...c);
  geometry.normals.push(...normal, ...normal, ...normal);
}

function emptyGeometry(): Geometry {
  return { positions: [], normals: [] };
}

// A thin six-sided rod gives the crystal a real, illuminated silhouette.
function edge(geometry: Geometry, a: Vec3, b: Vec3, width: number) {
  const direction = normalize(subtract(b, a));
  const reference: Vec3 = Math.abs(direction[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(direction, reference));
  const v = normalize(cross(direction, u));
  const point = (center: Vec3, angle: number): Vec3 => [
    center[0] + width * (u[0] * Math.cos(angle) + v[0] * Math.sin(angle)),
    center[1] + width * (u[1] * Math.cos(angle) + v[1] * Math.sin(angle)),
    center[2] + width * (u[2] * Math.cos(angle) + v[2] * Math.sin(angle)),
  ];
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const next = (i + 1) * Math.PI / 3;
    const p = point(a, angle), q = point(a, next), r = point(b, angle), s = point(b, next);
    triangle(geometry, p, q, r);
    triangle(geometry, q, s, r);
  }
}

const palette: Vec3[] = [
  [0.34, 0.63, 0.84], [0.57, 0.79, 0.93], [0.42, 0.68, 0.88],
  [0.73, 0.88, 0.96], [0.50, 0.75, 0.91], [0.65, 0.85, 0.96],
];

/** A bevelled, asymmetric cut with individually shaded facets and physical edges. */
function crystal(radius: number, height: number, sides: number, position: Vec3, spin: Vec3, small = false,
  center: Vec3 = [0, 0, 0], lean = 0, opacity = 1): ArtifactMesh[] {
  const point = (x: number, y: number, z: number): Vec3 => [center[0] + x + lean * y, center[1] + y, center[2] + z];
  const top = point(0, height * 0.58, 0);
  const bottom = point(0, -height * 0.54, 0);
  const upper: Vec3[] = [], lower: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = i * Math.PI * 2 / sides;
    upper.push(point(Math.cos(angle) * radius * 0.72, height * 0.22, Math.sin(angle) * radius * 0.72));
    lower.push(point(Math.cos(angle) * radius, -height * 0.20, Math.sin(angle) * radius));
  }
  const facets = palette.map(() => emptyGeometry());
  const borders = emptyGeometry();
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    triangle(facets[(i + 1) % palette.length], top, upper[j], upper[i]);
    triangle(facets[(i + 2) % palette.length], upper[i], upper[j], lower[i]);
    triangle(facets[(i + 3) % palette.length], upper[j], lower[j], lower[i]);
    triangle(facets[(i + 4) % palette.length], lower[i], lower[j], bottom);
    const lineWidth = small ? 0.008 : 0.012;
    edge(borders, top, upper[i], lineWidth);
    edge(borders, upper[i], upper[j], lineWidth);
    edge(borders, upper[i], lower[i], lineWidth);
    edge(borders, lower[i], lower[j], lineWidth);
    edge(borders, lower[i], bottom, lineWidth);
  }
  const meshes: ArtifactMesh[] = facets.map((geometry, i) => ({ geometry, color: palette[i], opacity, metallic: 0.48, emissive: 0.08, position, spin }));
  meshes.push({ geometry: borders, color: [0.78, 0.94, 1], metallic: 0.6, emissive: 0.3, position, spin });
  return meshes;
}

export function createDaylightScene(detail: 'low' | 'high'): ArtifactScene {
  const origin: Vec3 = [0, 0, 0], spin: Vec3 = [0.025, 0.11, 0.018];
  // Three interlocking cuts form an architectural crown around a lit inner column.
  // Shared local coordinates and rotation keep the whole sculpture together.
  const meshes = [
    ...crystal(0.26, 1.73, 6, origin, spin, true, [0, 0.02, 0], 0.03),
    ...crystal(0.72, 2.48, 6, origin, spin, false, [0, 0.02, 0], 0.03, 0.57),
    ...crystal(0.30, 1.70, 4, origin, spin, true, [-0.76, -0.11, -0.12], -0.21, 0.68),
    ...crystal(0.27, 1.48, 4, origin, spin, true, [0.77, 0.11, -0.05], 0.23, 0.68),
  ];
  const satellites: [number, number, Vec3, Vec3][] = [
    [0.14, 0.48, [-1.27, 0.69, 0.18], [0.08, -0.18, 0.06]],
    [0.12, 0.39, [1.30, -0.59, 0.12], [-0.07, 0.16, -0.05]],
  ];
  if (detail === 'high') {
    satellites.push([0.10, 0.32, [1.15, 0.91, -0.30], [0.06, 0.20, 0.04]]);
    satellites.push([0.075, 0.25, [-1.16, -0.81, -0.32], [-0.05, -0.14, 0.05]]);
  }
  // Satellites share a compact, merged faceted mesh to keep draw calls low.
  for (const [radius, height, position, spin] of satellites) {
    const parts = crystal(radius, height, 4, position, spin, true);
    const faces = emptyGeometry();
    for (const part of parts.slice(0, -1)) {
      faces.positions.push(...part.geometry.positions);
      faces.normals.push(...part.geometry.normals);
    }
    const orbit: Vec3 = [0.015, 0.065, 0.01];
    meshes.push({ geometry: faces, color: [0.52, 0.77, 0.92], opacity: 0.82, metallic: 0.5, emissive: 0.12, position, spin, orbit });
    meshes.push({ ...parts[parts.length - 1], orbit });
  }
  return { meshes, background: [0.957, 0.969, 0.984], light: [-3, 5, 6], label: 'Lichtprisma' };
}
