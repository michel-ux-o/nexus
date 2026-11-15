export type Vec3 = [number, number, number];
export interface Geometry { positions: number[]; normals: number[] }
export interface ArtifactMesh {
  geometry: Geometry;
  color: Vec3;
  opacity?: number;
  emissive?: number;
  metallic?: number;
  rotation?: Vec3;
  spin?: Vec3;
  /** Angular velocity around the scene origin, in radians per second. */
  orbit?: Vec3;
  position?: Vec3;
  scale?: Vec3;
  wireframe?: boolean;
  additive?: boolean;
}
export interface ArtifactScene {
  /** Relative framing for tall sculptures, independent of canvas size. */
  zoom?: number;
  meshes: ArtifactMesh[];
  background: Vec3;
  light: Vec3;
  label: string;
}
export type ArtifactFactory = (detail: 'low' | 'high') => ArtifactScene;
