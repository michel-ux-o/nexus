const MAX_POINTS = 44000
const STRIDE = 7

/** One complete turn during ten minutes of visible, enabled animation. */
export const PARTICLE_ROTATION_SECONDS = 600

/** CPU counterpart of the vertex shader's world motion, before content hollows. */
export function animateParticlePoint(point: readonly [number, number, number], seed: number, seconds: number): [number, number, number] {
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const grain = Number.isFinite(seed) ? seed : .5
  const angle = (time % PARTICLE_ROTATION_SECONDS) * Math.PI * 2 / PARTICLE_ROTATION_SECONDS
  const cosine = Math.cos(angle), sine = Math.sin(angle)
  const [x, y, z] = point
  const phase = grain * Math.PI * 2 + x * .173 + z * .117
  const fx = x + (Math.sin(time * (.62 + grain * .23) + phase) - Math.sin(phase)) * .045
  const fy = y + (Math.sin(time * (.48 + grain * .31) + phase * 1.37) - Math.sin(phase * 1.37)) * .095
  const fz = z + (Math.sin(time * (.39 + grain * .19) + phase * .83) - Math.sin(phase * .83)) * .04
  // The centre of the complete -17..9 depth range stays in place through a turn.
  return [fx * cosine + (fz + 4) * sine, fy, -fx * sine + (fz + 4) * cosine - 4]
}

function seededRandom(initialSeed = 731391) {
  let seed = initialSeed
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    return (seed >>> 0) / 4294967296
  }
}

/** Low wake beneath the open, twisting current; never a second geometry layer. */
export function terrain(x: number, z: number) {
  const t = (z + 17) / 26
  const spine = 5.8 * Math.sin(t * Math.PI * 2 + .35) + 1.2 * Math.cos(t * Math.PI)
  const wake = Math.exp(-Math.pow((x - spine) / 5.8, 2))
  const basin = Math.exp(-x * x * .09 - (z - 1.5) * (z - 1.5) * .055)
  return -1.15 + wake * .38 - basin * .72 + .12 * Math.sin(z * .39 + x * .23)
}

/**
 * Fixed decorative geometry, independent of task/note counts. Each vertex is
 * [x, y, z, alpha, size, colorSeed, motionSeed], matching both landscape renderers.
 * Interleaving all structures preserves their composition at every device budget;
 * a smaller buffer is an exact prefix of the full, deterministic landscape.
 */
export function makePoints(count: number): Float32Array {
  const length = Number.isFinite(count) ? Math.min(MAX_POINTS, Math.max(0, Math.floor(count))) : 0
  const points = new Float32Array(length * STRIDE)
  const random = seededRandom()

  for (let i = 0; i < length; i++) {
    const region = i % 20
    let x: number, y: number, z: number
    let alpha = .3 + random() * .22
    let size = .027 + random() * .022
    let highlight = .04

    if (region < 16) {
      // One swept volume changes direction and rolls across its own spine.
      // Continuous, unequally spaced filaments share that spine. Their cross
      // section folds gradually from a broad veil into a narrow upright curl;
      // no rings, bank shelves, regular lattice or separate particle deck.
      const along = random()
      const strand = random() * 2 - 1
      const filament = strand + .018 * Math.sin(strand * 71 + along * 11)
      const width = 3.5 + Math.sin(along * Math.PI) * 3.5
      const twist = -.7 + along * 2.5 + .33 * Math.sin(along * Math.PI * 2)
      const spineX = 5.8 * Math.sin(along * Math.PI * 2 + .35) + 1.2 * Math.cos(along * Math.PI)
      const spineY = 1 + 1.55 * Math.sin(along * Math.PI + .25) + .45 * Math.cos(along * Math.PI * 2)
      const fold = Math.sin(filament * 7.4 + along * 8.1) * .28
        + Math.sin(filament * 19.3 - along * 4.6) * .075
      const thickness = (random() + random() - 1) * (region < 12 ? .28 : .95)
      const taper = .62 + Math.sin(along * Math.PI) * .38
      x = spineX + filament * width * Math.cos(twist) + fold * Math.sin(twist)
      z = -17 + along * 26
      y = spineY + filament * width * Math.sin(twist) * .62 + fold + thickness
      if (region >= 12) {
        // The body peels into its own wake rather than ending on a bright rim.
        const drift = random()
        y -= drift * 2.3
        x += Math.sin(along * 9 + filament * 3) * drift * .7
      }
      const crest = Math.pow(.5 + .5 * Math.cos(filament * 7.4 + along * 8.1), 6)
      alpha = (.3 + random() * .18 + crest * .12) * taper
      size = .027 + random() * .017 + crest * .004
      highlight = .035 + crest * .2
      // Compress the loose tips smoothly instead of clipping many points onto
      // one screen-edge/height line when the curl approaches its world budget.
      if (Math.abs(x) > 10) x = Math.sign(x) * (10 + 1.95 * Math.tanh((Math.abs(x) - 10) / 1.95))
      if (y > 3.65) y = 3.65 + .83 * (1 - Math.exp(-(y - 3.65) / .83))
    } else {
      // Sparse entrained particles extend the same flow into the complete world
      // volume. This soft wake keeps navigation views populated without a floor.
      x = (random() * 2 - 1) * 12
      z = random() * 26 - 17
      y = terrain(x, z) + (random() - .5) * 2.1
      alpha = .19 + random() * .16
      size = .027 + random() * .016
    }

    // A gradual lowered opening keeps the fixed focus copy in clear air.
    if (Math.abs(x) < 2.4 && z > -1.2 && z < 4.8) {
      y = Math.min(y, -1 - .4 * Math.exp(-x * x * .18 - (z - 1) * (z - 1) * .1))
      alpha = Math.max(.14, alpha * .55)
    }

    const offset = i * STRIDE
    points[offset] = Math.max(-11.99, Math.min(11.99, x))
    points[offset + 1] = Math.max(-3.18, Math.min(4.48, y))
    points[offset + 2] = z
    points[offset + 3] = alpha
    points[offset + 4] = size * (z > 4 ? 1.08 : 1)
    // Ice catches selected ridges; most points stay in graphite/deep blue.
    points[offset + 5] = random() < highlight ? .94 + random() * .06 : random() * .89
    points[offset + 6] = .12 + random() * .88
  }

  return points
}


export interface ScreenDisplacementWindow {
  bounds: readonly [number, number, number, number]
  strength: number
}

/**
 * A shallow recess in camera space. CSS coordinates locate the small content
 * window; the third coordinate is positive eye depth, not an opacity value.
 * Original points sink into its soft floor without being packed onto its rim.
 * All windows are sampled at the unmodified point and combined symmetrically.
 */
export function depressScreenPoint(
  point: readonly [number, number, number], windows: readonly ScreenDisplacementWindow[], seed = .5,
): [number, number, number] {
  const [x, y, depth] = point
  if (![x, y, depth, seed].every(Number.isFinite) || depth <= 0) return [x, y, depth]
  let dx = 0, dy = 0, weightSum = 0, depression = 0
  const grain = Math.min(1, Math.max(0, seed))
  for (const window of windows) {
    const [left, bottom, right, top] = window.bounds
    if (![left, bottom, right, top, window.strength].every(Number.isFinite) || right <= left || top <= bottom) continue
    const strength = Math.min(1, Math.max(0, window.strength))
    const hx = Math.max(20, (right - left) * .5), hy = Math.max(20, (top - bottom) * .5)
    const nx = (x - (left + right) * .5) / hx, ny = (y - (bottom + top) * .5) / hy
    // A fourth-power superellipse has a broad floor and rounded shoulders;
    // compact support leaves the gap between independent windows untouched.
    const envelope = Math.max(0, 1 - (nx ** 4 + ny ** 4) / 1.57351936)
    const weight = envelope ** 2 * strength
    if (!weight) continue
    const tangent = Math.sin(grain * Math.PI * 2) * .8
    dx += (nx * 8 - ny * tangent) * weight * weight
    dy += (ny * 7 - 15 + nx * tangent) * weight * weight
    weightSum += weight
    depression = Math.max(depression, weight)
  }
  const normalization = Math.max(1e-9, weightSum)
  return [x + dx / normalization, y + dy / normalization, depth + 2.4 * depression]
}

/** A bounded elastic deflection, rather than evacuation onto a window rim. */
function screenDeflection(
  point: readonly [number, number], bounds: readonly [number, number, number, number], strength: number, seed: number,
): [number, number, number] {
  const [x, y] = point, [left, bottom, right, top] = bounds
  if (![x, y, left, bottom, right, top, strength, seed].every(Number.isFinite) || right <= left || top <= bottom) return [0, 0, 0]
  const amount = Math.min(1, Math.max(0, strength))
  const hx = Math.max(20, (right - left) * .5), hy = Math.max(20, (top - bottom) * .5)
  const nx = (x - (left + right) * .5) / hx, ny = (y - (bottom + top) * .5) / hy
  const radius2 = nx * nx + ny * ny
  const envelope = Math.max(0, 1 - radius2 / 1.44)
  const weight = envelope * envelope * envelope * amount
  if (!weight) return [0, 0, 0]
  const length = Math.sqrt(radius2 + .09)
  const grain = Math.min(1, Math.max(0, seed))
  const radial = 23 + grain * 11
  const tangent = Math.sin(grain * 6.2831853) * 5
  return [(nx * radial - ny * tangent) / length * weight,
    (ny * radial + nx * tangent) / length * weight, weight]
}

/**
 * CSS pixels, Y upwards. Kept for callers that only need the bounded planar
 * field. The landscape uses depressScreenPoint for a real camera-space hollow;
 * neither helper writes back into the single world buffer.
 */
export function displaceScreenPoint(
  point: readonly [number, number],
  bounds: readonly [number, number, number, number],
  strength = 1,
  seed = .5,
): [number, number] {
  const [dx, dy] = screenDeflection(point, bounds, strength, seed)
  return [point[0] + dx, point[1] + dy]
}

/** Evaluate each independent window at the original position, never in a chain. */
export function displaceScreenPoints(
  point: readonly [number, number], windows: readonly ScreenDisplacementWindow[], seed = .5,
): [number, number] {
  let dx = 0, dy = 0, weight = 0
  for (const window of windows) {
    const field = screenDeflection(point, window.bounds, window.strength, seed)
    dx += field[0] * field[2]; dy += field[1] * field[2]; weight += field[2]
  }
  const normalization = Math.max(1e-9, weight)
  return [point[0] + dx / normalization, point[1] + dy / normalization]
}
