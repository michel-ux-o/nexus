import { polyhedron, prism, sphere, torus } from './geometry';
import type { ArtifactMesh, ArtifactScene, Vec3 } from './types';

/** A ceremonial astrolabe, built from glazed stone and warm, worked brass. */
export function createSandScene(detail: 'low' | 'high'): ArtifactScene {
  const high = detail === 'high';
  const segments = high ? 48 : 24;
  const tubeSegments = high ? 8 : 6;
  const meshes: ArtifactMesh[] = [];
  const ceramic: Vec3 = [0.68, 0.53, 0.37];
  const ivory: Vec3 = [0.88, 0.79, 0.64];
  const brass: Vec3 = [0.62, 0.39, 0.16];
  const gold: Vec3 = [0.83, 0.59, 0.27];
  const dark: Vec3 = [0.29, 0.20, 0.14];
  const face: Vec3 = [Math.PI / 2, 0, 0];

  const addRing = (radius: number, thickness: number, color: Vec3, rotation: Vec3, position: Vec3, metallic = 0.8, spin: Vec3 = [0, 0, 0]) => {
    meshes.push({ geometry: torus(radius, thickness, segments, tubeSegments), color, rotation, position, metallic, spin });
  };
  const addDisc = (radius: number, height: number, color: Vec3, position: Vec3, metallic = 0.2, sides = segments) => {
    meshes.push({ geometry: prism(radius, height, sides), color, position, metallic });
  };

  // A stepped plinth and two uprights give the floating dial a physical home.
  addDisc(0.91, 0.12, dark, [0, -1.82, 0], 0.55, 12);
  addDisc(0.86, 0.12, brass, [0, -1.72, 0], 0.85, 12);
  addDisc(0.76, 0.14, ceramic, [0, -1.60, 0], 0.25, 12);
  addDisc(0.68, 0.06, ivory, [0, -1.50, 0], 0.2, 12);
  addRing(0.73, 0.025, gold, [0, 0, 0], [0, -1.53, 0]);
  const column = prism(0.095, 0.9, 8);
  const capital = prism(0.15, 0.1, 8);
  for (const x of [-0.53, 0.53]) {
    meshes.push({ geometry: column, color: ceramic, metallic: 0.22, position: [x, -1.05, -0.12] });
    meshes.push({ geometry: capital, color: gold, metallic: 0.85, position: [x, -1.45, -0.12] });
    meshes.push({ geometry: capital, color: brass, metallic: 0.85, position: [x, -0.64, -0.12] });
  }

  // A deep rear meridian, a wide ceramic rim and fine double brass bezels.
  addRing(1.49, 0.075, dark, [1.22, 0.32, 0.05], [0, 0.12, -0.23], 0.55);
  addRing(1.49, 0.025, gold, [1.22, 0.32, 0.05], [0, 0.12, -0.23]);
  addRing(1.38, 0.105, ceramic, face, [0, 0.12, 0], 0.3);
  addRing(1.46, 0.027, brass, face, [0, 0.12, 0.09]);
  addRing(1.30, 0.025, gold, face, [0, 0.12, 0.10]);
  addRing(1.25, 0.028, dark, face, [0, 0.12, 0.02], 0.45);
  addRing(1.11, 0.042, brass, [1.14, 0.48, 0.2], [0, 0.12, -0.01], 0.85, [0.015, 0.035, 0.025]);
  addRing(0.96, 0.055, ivory, [1.45, -0.32, 0.3], [0, 0.12, 0.03], 0.3, [-0.02, 0.025, -0.025]);
  addRing(0.78, 0.024, gold, [0.92, 0.3, -0.35], [0, 0.12, 0.06], 0.9, [0.025, -0.035, 0.02]);

  // Radial graduations and twelve raised hour studs are fixed to the front bezel.
  const tick = prism(0.025, 0.11, 6);
  const stud = sphere(0.046, high ? 10 : 8, high ? 6 : 4);
  const ticks = high ? 48 : 24;
  for (let i = 0; i < ticks; i++) {
    const a = i * Math.PI * 2 / ticks;
    meshes.push({ geometry: tick, color: i % (ticks / 12) === 0 ? gold : dark, metallic: 0.75,
      position: [1.38 * Math.sin(a), 0.12 + 1.38 * Math.cos(a), 0.115], rotation: [0, 0, -a],
      scale: [1, i % (ticks / 12) === 0 ? 1.15 : 0.6, 1] });
  }
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI * 2 / 12;
    meshes.push({ geometry: stud, color: gold, metallic: 0.9,
      position: [1.20 * Math.sin(a), 0.12 + 1.20 * Math.cos(a), 0.13] });
  }

  // The layered core reads as a small celestial instrument within the larger one.
  meshes.push({ geometry: sphere(0.52, high ? 24 : 16, high ? 14 : 10), color: ceramic, metallic: 0.25, position: [0, 0.12, 0] });
  addRing(0.53, 0.026, gold, [0.25, 0.15, 0.25], [0, 0.12, 0], 0.9, [0.025, 0.05, 0.015]);
  addRing(0.55, 0.022, brass, [1.2, 0.35, 0.3], [0, 0.12, 0], 0.9, [-0.025, 0.02, 0.02]);
  meshes.push({ geometry: polyhedron(0.29, 1), color: ivory, metallic: 0.22, position: [0, 0.12, 0.48], rotation: [0.18, 0.3, 0.1], spin: [0.02, 0.035, 0.01] });
  meshes.push({ geometry: prism(0.15, 0.09, 12), color: brass, metallic: 0.9, position: [0, 0.12, 0.7], rotation: face });
  meshes.push({ geometry: sphere(0.075, high ? 12 : 8, high ? 8 : 6), color: gold, metallic: 0.9, position: [0, 0.12, 0.77] });

  // A finial makes the silhouette unmistakable even from a distance.
  meshes.push({ geometry: prism(0.10, 0.25, 8), color: brass, metallic: 0.85, position: [0, 1.68, 0] });
  meshes.push({ geometry: polyhedron(0.17, 0), color: gold, metallic: 0.85, position: [0, 1.88, 0], scale: [0.65, 1.3, 0.65] });
  return { meshes, zoom: 0.78, background: [0.965, 0.945, 0.906], light: [0.94, 0.79, 0.58], label: 'Chronosphäre' };
}
