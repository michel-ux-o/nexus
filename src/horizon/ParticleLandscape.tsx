import { useEffect, useRef, useState } from 'react'
import { animateParticlePoint, depressScreenPoint, makePoints, PARTICLE_ROTATION_SECONDS } from './particleGeometry'
import { listenHorizonScene, observeHorizonInteraction } from './sceneEvents'
import type { SceneEvent, SceneRegion } from './sceneEvents'
import './ParticleLandscape.css'

export interface ParticleLandscapeProps {
  view: string
  focus?: boolean
  powerSaving?: boolean
  still?: boolean
  /** Increment after a successful data commit, never for each keystroke. */
  pulse?: number
  /** The Nexus particle tint; independent of the surrounding interface theme. */
  particleColor?: string
}

type Point3 = [number, number, number]
type Pose = { eye: Point3; target: Point3; focus: number }
type MotionSettings = { view: string; focus: boolean; powerSaving: boolean; still: boolean; pulse: number; particleColor: Point3 }
type Quality = 'high' | 'balanced' | 'low'
type SceneLight = { origin: Point3; strength: number; commit: number; action: number; direction: number }
type ScreenBounds = { x: number; y: number; width: number; height: number }
type ReadingLayout = { clearances: Float32Array; strengths: Float32Array; count: number; textClearances: Float32Array; textCount: number }
type ContentSample = { id: string; region: SceneRegion; item?: string; kind: string; bounds: ScreenBounds; textBounds: ScreenBounds[] }
type DisplacementWindow = { id: string; bounds: number[]; target: number[]; strength: number; active: boolean }
type Renderer = {
  draw: (pose: Pose, time: number, light: SceneLight, count: number, layout: ReadingLayout, particleColor: Point3) => void
  dispose: () => void
}

const FLIGHT_MS = 820
const COMMIT_MS = 880
const DEFAULT_PARTICLE_COLOR = '#8ebed4'

function normalizedParticleColor(value: string): string {
  return /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_PARTICLE_COLOR
}
function particleRgb(value: string): Point3 {
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255) as Point3
}
const REGION_ORIGINS: Record<SceneRegion, Point3> = {
  home: [0, -.3, -2], tasks: [-6.8, 1.3, -3], calendar: [5.8, 2.8, -10.6],
  focus: [0, -1.2, 1], notes: [6.8, 1.1, -1.8], reminders: [7, .6, 3],
}
const QUALITY: Record<Quality, { fraction: number; dpr: number }> = {
  high: { fraction: 1, dpr: 1.65 }, balanced: { fraction: .74, dpr: 1.35 }, low: { fraction: .43, dpr: 1 },
}

const VERTEX_SHADER = `
precision highp float;
attribute vec3 a_position;
attribute vec4 a_detail;
uniform mat4 u_projection;
uniform mat4 u_view;
uniform vec4 u_clearance[16];
uniform float u_clearance_count;
uniform float u_window_strength[16];
uniform vec4 u_text_clearance[64];
uniform float u_text_count;
uniform vec2 u_viewport;
uniform float u_time;
uniform float u_rotation;
uniform float u_focus;
uniform float u_dpr;
uniform float u_selection;
uniform float u_commit;
uniform float u_action;
uniform float u_direction;
uniform vec3 u_origin;
uniform vec3 u_particle_color;
varying vec4 v_color;
varying vec2 v_disc;
float readingMask(vec2 screen, vec4 bounds, float feather) {
  vec2 halfSize = (bounds.zw - bounds.xy) * u_viewport * .5;
  vec2 center = (bounds.xy + bounds.zw) * .5;
  float radius = min(feather * 2.4, min(halfSize.x, halfSize.y) * .72);
  vec2 q = abs((screen - center) * u_viewport) - halfSize + radius;
  float distance = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - radius;
  return 1. - smoothstep(-feather, feather, distance);
}
void main() {
  vec3 p = a_position;
  // Each immutable world point floats with its own phase and then follows the
  // whole volume around its centre. HTML and the single content camera stay put.
  float phaseSeed = a_detail.w * 6.28318530718 + p.x * .173 + p.z * .117;
  p += vec3(
    (sin(u_time * (.62 + a_detail.w * .23) + phaseSeed) - sin(phaseSeed)) * .045,
    (sin(u_time * (.48 + a_detail.w * .31) + phaseSeed * 1.37) - sin(phaseSeed * 1.37)) * .095,
    (sin(u_time * (.39 + a_detail.w * .19) + phaseSeed * .83) - sin(phaseSeed * .83)) * .04
  );
  float rotationCos = cos(u_rotation), rotationSin = sin(u_rotation);
  p.xz = vec2(p.x * rotationCos + (p.z + 4.) * rotationSin,
    -p.x * rotationSin + (p.z + 4.) * rotationCos - 4.);
  vec2 basinPoint = (p.xz - vec2(0., 1.)) * vec2(.22, .19);
  float basin = exp(-dot(basinPoint, basinPoint));
  p.y -= u_focus * basin * .32;
  p.x += u_focus * basin * p.x * .045;
  vec3 delta = p - u_origin;
  vec3 localPoint = delta * vec3(.29, .40, .26);
  float local = exp(-dot(localPoint, localPoint));
  p += (u_origin - p) * local * u_selection * .045;
  float phase = clamp(u_commit, 0., 1.);
  float envelope = sin(phase * 3.14159265) * (1. - phase * .35);
  float ring = exp(-pow(length(delta.xz) - phase * 3.8, 2.) * 2.8) * (1. - phase);
  // Committed actions arrive, settle, return, or reconnect in their own region.
  if (u_action < 1.5) {
    p.xz -= delta.xz * local * envelope * .11;
    p.y += local * envelope * .24;
  } else if (u_action < 2.5) {
    p.y -= local * envelope * .42;
    p.z -= local * envelope * .38;
  } else if (u_action < 3.5) {
    p.y += local * envelope * .42;
    p.z += local * envelope * .38;
  } else {
    p.x += local * envelope * .30 * u_direction;
    p.y += local * envelope * .10;
  }
  vec4 eye = u_view * vec4(p, 1.0);
  vec4 originalClip = u_projection * eye;
  // Content opens shallow hollows in the same volume. Their floors recede in
  // eye-space Z; the final projection and depth test both use that real depth.
  // Small shoulder movement keeps particles in free space inside each window.
  vec2 originalScreen = (originalClip.xy / originalClip.w * .5 + .5) * u_viewport;
  vec2 deflection = vec2(0.);
  vec2 slope = vec2(0.);
  float totalWeight = 0.;
  float depression = 0.;
  for (int i = 0; i < 16; i++) {
    if (float(i) < u_clearance_count && u_window_strength[i] > .0001) {
      vec4 bounds = u_clearance[i] * vec4(u_viewport, u_viewport);
      vec2 halfSize = max(vec2(20.), (bounds.zw - bounds.xy) * .5);
      vec2 localScreen = (originalScreen - (bounds.xy + bounds.zw) * .5) / halfSize;
      vec2 squared = localScreen * localScreen;
      float envelope = max(0., 1. - dot(squared, squared) / 1.57351936);
      float weight = envelope * envelope * clamp(u_window_strength[i], 0., 1.);
      float grain = clamp(a_detail.w, 0., 1.);
      float tangent = sin(grain * 6.2831853) * .8;
      deflection += vec2(localScreen.x * 8. - localScreen.y * tangent,
        localScreen.y * 7. - 15. + localScreen.x * tangent) * weight * weight;
      slope += localScreen * squared * envelope * envelope * weight;
      totalWeight += weight;
      depression = max(depression, weight);
    }
  }
  vec2 displaced = originalScreen + deflection / max(.000000001, totalWeight);
  eye.z -= depression * 2.4;
  // Back-project XY at the new depth. This keeps the hollow tied to its own
  // content opening while preserving a single camera and immutable world data.
  eye.xy = (displaced / u_viewport * 2. - 1.) * (-eye.z) / vec2(u_projection[0][0], u_projection[1][1]);
  gl_Position = u_projection * eye;
  float depth = max(.5, -eye.z);
  // Grain, contrast and selected ridges establish three legible distances.
  // Bright seeds are continuous geometry edges, rather than random stars.
  float near = 1. - smoothstep(9., 29., depth);
  float highlight = smoothstep(.90, .985, a_detail.z);
  float grain = a_detail.y * (390. / depth) * mix(.88, 1.08, near);
  float diameter = clamp(grain * (1. + highlight * .06), .62, 2.15) * u_dpr;
  // A physical-pixel fringe analytically antialiases subpixel grains, including
  // devices where point primitives do not receive multisample antialiasing.
  float spriteSize = ceil(diameter + 2.);
  gl_PointSize = spriteSize;
  v_disc = vec2(diameter * .5, spriteSize);
  // The chosen hue is shared by the entire volume. Luminance, grain and
  // reflected highlights still describe different depths within that hue.
  vec3 graphite = u_particle_color * .31;
  vec3 deepBlue = u_particle_color * .76;
  vec3 ice = mix(u_particle_color, vec3(1.), .36);
  vec3 color = mix(graphite, deepBlue, .30 + abs(a_detail.w) * .32 + near * .18);
  color = mix(color, ice, highlight * .84);
  color = mix(color, ice, local * u_selection * .32 + ring * envelope * .28);
  vec2 hollowSlope = slope / max(.000000001, totalWeight);
  float hollowLight = clamp(dot(hollowSlope, vec2(-2.1, 3.1)), -.32, .30);
  color *= clamp(1. - depression * .32 + hollowLight, .40, 1.25);
  float fog = exp(-max(0., depth - 11.) * .042);
  float alpha = clamp(a_detail.x * fog * (.9 + highlight * .58 + near * .12)
    * (1. + local * u_selection * .33 + ring * envelope * .35), .035, .96);
  // A final safety mask protects copy while a new field is still settling.
  // Visible particles are physically moved above, rather than merely faded out.
  vec2 screen = gl_Position.xy / gl_Position.w * .5 + .5;
  for (int i = 0; i < 64; i++) {
    if (float(i) < u_text_count) alpha *= 1. - .995 * readingMask(screen, u_text_clearance[i], 1.5);
  }
  v_color = vec4(color, alpha);
}`

const FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;
varying vec2 v_disc;
void main() {
  vec2 pixel = (gl_PointCoord - .5) * v_disc.y;
  float distance = length(pixel) - v_disc.x;
  float coverage = 1. - smoothstep(-.55, .55, distance);
  if (coverage * v_color.a < .018) discard;
  gl_FragColor = vec4(v_color.rgb, v_color.a * coverage);
}`

function normalize(v: Point3): Point3 {
  const length = Math.hypot(...v) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}
function cross(a: Point3, b: Point3): Point3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function dot(a: Point3, b: Point3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function mixPoint(a: Point3, b: Point3, t: number): Point3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
function copyPose(pose: Pose): Pose { return { eye: [...pose.eye], target: [...pose.target], focus: pose.focus } }

/** Travel around the opening, then descend into it; every flight has exact ends. */
function flightPose(from: Pose, target: Pose, progress: number): Pose {
  const eased = progress * progress * progress * (10 + progress * (-15 + progress * 6))
  const pose: Pose = { eye: mixPoint(from.eye, target.eye, eased), target: mixPoint(from.target, target.target, eased), focus: from.focus + (target.focus - from.focus) * eased }
  const distance = Math.hypot(...target.eye.map((value, axis) => value - from.eye[axis]))
  // Quadratic arch is zero at both ends and reverses with the same path.
  const arch = 4 * eased * (1 - eased) * Math.min(1.25, distance * .16)
  const dx = target.eye[0] - from.eye[0], dz = target.eye[2] - from.eye[2]
  const horizontal = Math.hypot(dx, dz) || 1
  const orientation = dx < 0 || dx === 0 && dz < 0 ? -1 : 1
  pose.eye[0] += -dz / horizontal * orientation * arch * .52
  pose.eye[1] += arch * .62
  pose.eye[2] += dx / horizontal * orientation * arch * .52
  return pose
}
function viewMatrix(pose: Pose) {
  const { eye, target } = pose
  const back = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]])
  const right = normalize(cross([0, 1, 0], back))
  const up = cross(back, right)
  return new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ])
}
function perspective(aspect: number) {
  const f = 1 / Math.tan(Math.PI / 7)
  const near = .1
  const far = 80
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0])
}

function createWebGL(canvas: HTMLCanvasElement, points: Float32Array): Renderer | null {
  let context: WebGLRenderingContext | null
  try {
    context = canvas.getContext('webgl', { alpha: true, antialias: false, depth: true, powerPreference: 'low-power', preserveDrawingBuffer: false })
  } catch { return null }
  if (!context) return null
  const gl = context
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer)
    if (program) gl.deleteProgram(program)
    for (const shader of shaders) gl.deleteShader(shader)
  }
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Shader unavailable')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed')
    }
    program = gl.createProgram()
    if (!program) throw new Error('Program unavailable')
    for (const shader of shaders) gl.attachShader(program, shader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program linking failed')
    buffer = gl.createBuffer()
    if (!buffer) throw new Error('Buffer unavailable')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW)
    gl.useProgram(program)
    for (const [name, length, offset] of [['a_position', 3, 0], ['a_detail', 4, 12]] as const) {
      const location = gl.getAttribLocation(program, name)
      if (location < 0) throw new Error('Attribute unavailable')
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, length, gl.FLOAT, false, 28, offset)
    }
    const uniforms = Object.fromEntries(['projection', 'view', 'clearance_count', 'text_count', 'viewport', 'time', 'rotation', 'focus', 'dpr', 'selection', 'commit', 'action', 'direction', 'origin', 'particle_color'].map(name => [name, gl.getUniformLocation(program!, `u_${name}`)]))
    const clearance = gl.getUniformLocation(program, 'u_clearance[0]')
    const textClearance = gl.getUniformLocation(program, 'u_text_clearance[0]')
    const windowStrength = gl.getUniformLocation(program, 'u_window_strength[0]')
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.clearColor(0, 0, 0, 0)
    return {
      draw(pose, time, light, count, layout, particleColor) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.depthMask(true)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.useProgram(program)
        gl.uniformMatrix4fv(uniforms.projection, false, perspective(canvas.width / Math.max(1, canvas.height)))
        gl.uniformMatrix4fv(uniforms.view, false, viewMatrix(pose))
        gl.uniform1f(uniforms.clearance_count, layout.count)
        gl.uniform4fv(clearance, layout.clearances)
        gl.uniform1fv(windowStrength, layout.strengths)
        gl.uniform1f(uniforms.text_count, layout.textCount)
        gl.uniform4fv(textClearance, layout.textClearances)
        gl.uniform2f(uniforms.viewport, canvas.parentElement?.clientWidth || canvas.width, canvas.parentElement?.clientHeight || canvas.height)
        gl.uniform1f(uniforms.time, time)
        gl.uniform1f(uniforms.rotation, (time % PARTICLE_ROTATION_SECONDS) * Math.PI * 2 / PARTICLE_ROTATION_SECONDS)
        gl.uniform1f(uniforms.focus, pose.focus)
        gl.uniform1f(uniforms.dpr, canvas.width / Math.max(1, canvas.parentElement?.clientWidth || canvas.clientWidth))
        gl.uniform1f(uniforms.selection, light.strength)
        gl.uniform1f(uniforms.commit, light.commit)
        gl.uniform1f(uniforms.action, light.action)
        gl.uniform1f(uniforms.direction, light.direction)
        gl.uniform3fv(uniforms.origin, light.origin)
        gl.uniform3fv(uniforms.particle_color, particleColor)
        // Resolve overlap independently of unsorted particle order. Discarded disc edges
        // never mask points behind them; no opaque terrain mesh or glow is added.
        gl.colorMask(false, false, false, false)
        gl.drawArrays(gl.POINTS, 0, count)
        gl.colorMask(true, true, true, true)
        gl.depthMask(false)
        gl.drawArrays(gl.POINTS, 0, count)
      },
      dispose,
    }
  } catch {
    dispose()
    return null
  }
}

function regionForView(view: string): SceneRegion {
  if (view === 'tasks' || view === 'notes' || view === 'reminders') return view
  if (view === 'calendar' || view === 'week' || view === 'today') return 'calendar'
  return 'home'
}

function viewPose(view: string, focus: boolean, dayOffset = 0, taskOffset = 0, inlineFocus = false): Pose {
  const views: Record<string, [Point3, Point3]> = {
    home: [[-.4, 5.7, 14.8], [0, .15, -3.4]],
    tasks: [[-7.7, 4.4, 10.2], [-5.6, .5, -4]],
    notes: [[7.5, 4.1, 10.9], [5.7, 1.0, -3.5]],
    reminders: [[8.2, 3.1, 12.6], [6.1, .8, 1.5]],
    calendar: [[4.8, 5.5, 7.3], [4.5, 1.4, -8.6]],
    week: [[2.6, 6.8, 9.6], [3.5, 1.1, -7.8]],
    today: [[-2.6, 4.4, 11.4], [-.8, -.2, -1.4]],
    ai: [[3.6, 6.9, 13.1], [1.6, .1, -4.2]],
    settings: [[-3.8, 7.2, 16.1], [-.9, .6, -5.1]],
  }
  const [eye, target] = focus ? [[.65, 2.1, 7.45], [0, -1.15, .85]] as [Point3, Point3]
    : view === 'home' && inlineFocus ? [[-.15, 4.2, 12.25], [0, -.5, -1.55]] as [Point3, Point3]
      : views[view] ?? views.home
  const localOffset = view === 'home' && !focus ? taskOffset : 0
  return { eye: [eye[0] + dayOffset + localOffset, eye[1], eye[2]], target: [target[0] + dayOffset * .45 + localOffset * .36, target[1], target[2]], focus: focus ? 1 : inlineFocus && view === 'home' ? .35 : 0 }
}

function hasTextFocus() {
  const element = document.activeElement
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly
  if (element instanceof HTMLInputElement) return !element.disabled && !element.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(element.type)
  return element instanceof HTMLElement && element.isContentEditable
}

/** Visible reading windows are force fields, never additional particle geometry. */
function sampleContent(root: Element, viewport: DOMRect): ContentSample[] {
  const samples: ContentSample[] = []
  const rects = new Map<Element, DOMRect>()
  const styles = new Map<Element, CSSStyleDeclaration>()
  const rectFor = (element: Element) => {
    let rect = rects.get(element)
    if (!rect) { rect = element.getBoundingClientRect(); rects.set(element, rect) }
    return rect
  }
  const styleFor = (element: Element) => {
    let style = styles.get(element)
    if (!style) { style = getComputedStyle(element); styles.set(element, style) }
    return style
  }
  function visibleRect(element: Element, original: DOMRect | ScreenBounds): ScreenBounds | null {
    const source = 'left' in original ? original : { left: original.x, top: original.y, right: original.x + original.width, bottom: original.y + original.height }
    let left = Math.max(source.left, viewport.left), right = Math.min(source.right, viewport.right)
    let top = Math.max(source.top, viewport.top), bottom = Math.min(source.bottom, viewport.bottom)
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = styleFor(parent)
      // aria-hidden can describe a visible icon or decorative task number;
      // readability follows painted pixels, independently of accessibility.
      if (style.display === 'none' || style.visibility === 'hidden' || parent.matches('[hidden], .horizon-sr-only, .sr-only')) return null
      const clipX = /(auto|scroll|hidden|clip)/.test(style.overflowX), clipY = /(auto|scroll|hidden|clip)/.test(style.overflowY)
      if (clipX || clipY) {
        const clip = rectFor(parent)
        if (clipX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
        if (clipY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      }
      if (parent === root) break
    }
    return right - left > 1 && bottom - top > 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null
  }
  function contentRects(element: Element): ScreenBounds[] {
    const result: ScreenBounds[] = []
    // Range rectangles follow actual glyph lines, including line clamps and
    // scrolling. Empty panel padding remains part of the visible cloud.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent ?? '', start = value.search(/\S/)
      const parent = node.parentElement
      if (start < 0 || !parent || parent.closest('script, style, textarea, select, svg')) continue
      range.setStart(node, start); range.setEnd(node, value.trimEnd().length)
      for (const rect of range.getClientRects()) {
        const visible = visibleRect(parent, rect)
        if (visible) result.push(visible)
      }
    }
    range.detach()
    for (const control of element.querySelectorAll('input:not([type="hidden"]), textarea, select, button svg, a svg')) {
      const visible = visibleRect(control, rectFor(control))
      if (visible) result.push(visible)
    }
    // Inline text fragments may join along their own line, never vertically
    // across the empty space between independent windows.
    result.sort((a, b) => a.y - b.y || a.x - b.x)
    const lines: ScreenBounds[] = []
    for (const rect of result) {
      const previous = lines.at(-1)
      if (previous && Math.abs(previous.y - rect.y) < 2 && Math.abs(previous.height - rect.height) < 3
        && rect.x - (previous.x + previous.width) < 10) {
        previous.width = Math.max(previous.x + previous.width, rect.x + rect.width) - previous.x
        previous.height = Math.max(previous.height, rect.height)
      } else lines.push({ ...rect })
    }
    return lines
  }
  function add(element: Element | null, id: string, region: SceneRegion) {
    if (!element || samples.length >= 16 || element.closest('[hidden], [aria-hidden="true"]')) return
    const original = rectFor(element)
    if (original.width < 12 || original.height < 8) return
    const textBounds = contentRects(element)
    if (!textBounds.length) return
    const left = Math.max(original.left, Math.min(...textBounds.map(rect => rect.x)))
    const right = Math.min(original.right, Math.max(...textBounds.map(rect => rect.x + rect.width)))
    const top = Math.max(original.top, Math.min(...textBounds.map(rect => rect.y)))
    const bottom = Math.min(original.bottom, Math.max(...textBounds.map(rect => rect.y + rect.height)))
    if (right - left < 8 || bottom - top < 6) return
    samples.push({ id, kind: id, region, item: element.getAttribute('data-scene-item') ?? undefined,
      bounds: { x: left, y: top, width: right - left, height: bottom - top }, textBounds })
  }
  const modal = Array.from(root.querySelectorAll('dialog[open]')).at(-1)
  if (modal) {
    // The immersive dialog is a transparent viewport-sized shell. Its actual
    // central text window opens the cloud; the shell must never clear all space.
    const immersive = modal.classList.contains('horizon-focus-dialog')
    add(immersive ? modal.querySelector('.horizon-focus-dialog-body') : modal, immersive ? 'focus-dialog' : 'dialog', 'focus')
    if (immersive) add(modal.querySelector('.horizon-focus-dialog-top button'), 'focus-close', 'focus')
    return samples
  }
  // The transparent area chooser is a non-modal popover. It needs the same
  // moving-cloud hollow and glyph protection as the content still visible below.
  add(root.querySelector('.horizon-areas-panel'), 'areas', 'home')
  add(root.querySelector('.nexus-login-panel'), 'login', 'home')
  add(root.querySelector('.nexus-login-brand'), 'login-brand', 'home')
  const home = root.querySelector('.horizon-home')
  if (home) {
    for (const [selector, id, region] of [
      ['.horizon-day-tasks', 'tasks', 'tasks'], ['.horizon-day-calendar', 'calendar', 'calendar'],
      ['.horizon-day-notes', 'notes', 'notes'], ['.horizon-day-reminders', 'reminders', 'reminders'],
      ['.horizon-home-focus .horizon-focus-scene', 'focus', 'focus'],
      ['.horizon-home-capture.is-open', 'capture', 'home'],
    ] as const) add(home.querySelector(selector), id, region)
  } else {
    // Work views use the same field and the same particle buffer as the start.
    for (const [selector, region] of [
      ['.horizon-task-collection', 'tasks'], ['.horizon-task-detail', 'tasks'],
      ['.reminders-list', 'reminders'], ['.reminders-detail', 'reminders'],
      ['.today-panel', 'calendar'], ['.week-board', 'calendar'], ['.week-pool', 'tasks'],
      ['.calendar-grid', 'calendar'], ['.calendar-agenda', 'calendar'],
      ['.sidebar', 'notes'], ['.editor', 'notes'],
    ] as const) {
      let index = 0
      for (const element of root.querySelectorAll(selector)) add(element, `${selector.slice(1)}:${index++}`, region)
    }
  }
  return samples
}

function normalizedBounds(bounds: ScreenBounds, viewport: DOMRect): number[] {
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height)
  return [(bounds.x - viewport.left) / width, 1 - (bounds.y + bounds.height - viewport.top) / height,
    (bounds.x + bounds.width - viewport.left) / width, 1 - (bounds.y - viewport.top) / height]
}

/** Actual current text stays readable while an opening is still moving. */
function readingLayout(samples: ContentSample[], viewport: DOMRect): ReadingLayout {
  const textClearances = new Float32Array(64 * 4)
  // Round-robin preserves protection for every independent panel when a long
  // scrolled list contains more visible runs than the bounded shader budget.
  let count = 0, row = 0, more = true
  while (count < 64 && more) {
    more = false
    for (const sample of samples) {
      const rect = sample.textBounds[row]
      if (rect && count < 64) { textClearances.set(normalizedBounds(rect, viewport), count++ * 4); more = true }
    }
    row++
  }
  return { clearances: new Float32Array(16 * 4), strengths: new Float32Array(16), count: 0,
    textClearances, textCount: count }
}

/** Convert only interaction origins; all visible geometry uses the single camera. */
function worldAtScreen(bounds: ScreenBounds, viewport: DOMRect, pose: Pose): Point3 {
  const matrix = viewMatrix(pose)
  const distance = 14
  const scale = 2 * distance * Math.tan(Math.PI / 7) / Math.max(1, viewport.height)
  const horizontal = (bounds.x + bounds.width / 2 - viewport.left - viewport.width / 2) * scale
  const vertical = (viewport.top + viewport.height / 2 - bounds.y - bounds.height / 2) * scale
  return [0, 1, 2].map(axis => pose.eye[axis] - matrix[axis * 4 + 2] * distance
    + matrix[axis * 4] * horizontal + matrix[axis * 4 + 1] * vertical) as Point3
}

function drawFallback(canvas: HTMLCanvasElement, points: Float32Array, pose: Pose, time: number, layout: ReadingLayout, particleColor: Point3) {
  const context = canvas.getContext('2d')
  if (!context) return
  const matrix = viewMatrix(pose)
  const projection = perspective(canvas.width / Math.max(1, canvas.height))
  const dpr = canvas.width / Math.max(1, canvas.parentElement?.clientWidth || canvas.clientWidth)
  context.clearRect(0, 0, canvas.width, canvas.height)
  const projected: { x: number; y: number; z: number; radius: number; alpha: number; color: string }[] = []
  // Same bounded moving volume; a lower cadence keeps the CPU fallback affordable.
  let sampleStep = Math.max(1, Math.ceil(points.length / 7 / 8500))
  // Geometry interleaves twenty strata; a coprime step samples every landmark.
  if (sampleStep % 2 === 0) sampleStep++
  if (sampleStep % 5 === 0) sampleStep += 2
  const stride = sampleStep * 7
  const width = canvas.width / dpr, height = canvas.height / dpr
  const windows = Array.from({ length: layout.count }, (_, zone) => {
    const offset = zone * 4
    return { bounds: [layout.clearances[offset] * width, layout.clearances[offset + 1] * height,
      layout.clearances[offset + 2] * width, layout.clearances[offset + 3] * height] as [number, number, number, number], strength: layout.strengths[zone] }
  })
  for (let i = 0; i < points.length; i += stride) {
    let [x, y, z] = animateParticlePoint([points[i], points[i + 1], points[i + 2]], points[i + 6], time)
    const basin = Math.exp(-Math.pow(x * .22, 2) - Math.pow((z - 1) * .19, 2))
    y -= pose.focus * basin * .32
    x += pose.focus * basin * x * .045
    const ex = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    const ey = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    let ez = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
    if (ez > -.2) continue
    const originalDepth = -ez
    const position = depressScreenPoint([(ex * projection[0] / -ez * .5 + .5) * canvas.width / dpr,
      (ey * projection[5] / -ez * .5 + .5) * canvas.height / dpr, originalDepth], windows, points[i + 6])
    ez = -position[2]
    const px = position[0] * dpr, py = canvas.height - position[1] * dpr
    if (px < -5 || px > canvas.width + 5 || py < -5 || py > canvas.height + 5) continue
    {
      const sx = px / canvas.width, sy = 1 - py / canvas.height
      let behindText = false
      for (const [zones, count] of [[layout.textClearances, layout.textCount]] as [Float32Array, number][]) {
        for (let zone = 0; zone < count; zone++) {
          const offset = zone * 4
          if (sx > zones[offset] && sx < zones[offset + 2] && sy > zones[offset + 1] && sy < zones[offset + 3]) { behindText = true; break }
        }
        if (behindText) break
      }
      if (behindText) continue
    }
    const near = 1 - Math.min(1, Math.max(0, (-ez - 9) / 20))
    const highlight = Math.min(1, Math.max(0, (points[i + 5] - .90) / .085))
    const hollow = (position[2] - originalDepth) / 2.4
    const luminance = .31 + .45 * (.30 + Math.abs(points[i + 6]) * .32 + near * .18)
    const color = particleColor.map(channel => Math.round((channel * luminance * (1 - highlight * .84)
      + (channel * .64 + .36) * highlight * .84) * 255)).join(',')
    projected.push({ x: px, y: py, z: ez, radius: Math.min(1.075, Math.max(.31, points[i + 4] * 195 / -ez * (.88 + near * .2) * (1 + highlight * .06))) * dpr,
      alpha: Math.min(.96, points[i + 3] * Math.exp(-Math.max(0, -ez - 11) * .042) * (.9 + highlight * .58 + near * .12)) * (1 - hollow * .32), color })
  }
  projected.sort((a, b) => a.z - b.z)
  for (const point of projected) {
    context.fillStyle = `rgba(${point.color},${point.alpha})`
    context.beginPath()
    context.arc(point.x, point.y, point.radius, 0, Math.PI * 2)
    context.fill()
  }
}

/** Decorative 3D volume. Pointer observation never moves or intercepts the HTML controls. */
export function ParticleLandscape({ view, focus = false, powerSaving = false, still = false, pulse = 0, particleColor = DEFAULT_PARTICLE_COLOR }: ParticleLandscapeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fallbackRef = useRef<HTMLCanvasElement>(null)
  const color = normalizedParticleColor(particleColor)
  const latest = useRef<MotionSettings>({ view, focus, powerSaving, still, pulse, particleColor: particleRgb(color) })
  latest.current = { view, focus, powerSaving, still, pulse, particleColor: particleRgb(color) }
  const requestDraw = useRef<() => void>(() => {})
  const [fallback, setFallback] = useState(false)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const fallbackCanvas = fallbackRef.current
    if (!canvas || !fallbackCanvas || !canvas.parentElement) return
    const container = canvas.parentElement
    const sceneRoot = container.closest('.nexus-horizon') ?? document.body
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reducedMotion = media.matches
    setReduced(reducedMotion)
    const mobile = window.matchMedia('(max-width: 700px)').matches
    // Allocation stays fixed; actual draw count and pixel density follow measured frames.
    const maxCount = powerSaving ? 12000 : mobile ? 32000 : 44000
    const points = makePoints(maxCount)
    canvas.dataset.particleCapacity = String(maxCount)
    let quality: Quality = powerSaving ? 'low' : 'balanced'
    let particleCount = powerSaving ? maxCount : Math.round(maxCount * QUALITY[quality].fraction)
    let renderer = createWebGL(canvas, points)
    setFallback(!renderer)
    let lost = false
    let disposed = false
    let frame = 0
    let lastFrame = -Infinity
    let previousRaf = 0
    let previousTime = 0
    let animationTime = 0
    let inlineFocus = sceneRoot.querySelector('.horizon-home')?.getAttribute('data-focus-stage') === 'steps'
    let settingsKey = `${view}:${focus}:0:0:${inlineFocus}`
    let pose = viewPose(view, focus, 0, 0, inlineFocus)
    let from = copyPose(pose)
    let target = copyPose(pose)
    let transitionStart = -Infinity
    let dayOffset = 0
    let taskOffset = 0
    let activeRegion: SceneRegion = focus ? 'focus' : regionForView(view)
    let selectedOrigin: Point3 = [...REGION_ORIGINS[activeRegion]]
    let hoverOrigin: Point3 = [...selectedOrigin]
    let commitOrigin: Point3 = [...selectedOrigin]
    let selectedStrength = 0
    let hoverStrength = 0
    let selection = 0
    let typing = false
    let calm = 0
    let pointer: [number, number] = [0, 0]
    let parallax: [number, number] = [0, 0]
    let lastPulse = pulse
    let pendingPulseAt = 0
    let pendingPulseTimer = 0
    let lastCustomCommit = -Infinity
    let commitStart = -Infinity
    let commitAction = 0
    let commitDirection = 1
    let commitCount = 0
    let drawCount = 0
    let sampleStart = 0
    let sampleFrames = 0
    let sampleRafMs = 0
    let sampleRafCount = 0
    let sampleCost = 0
    let qualitySamples = 0
    let healthySamples = 0
    let slowSamples = 0
    let wasStatic = isStill()
    let contentDirty = true
    let layoutTrackingUntil = 0
    let contentRevision = 0
    let contentSamples: ContentSample[] = []
    let contentLayout: ReadingLayout = { clearances: new Float32Array(64), strengths: new Float32Array(16), count: 0, textClearances: new Float32Array(256), textCount: 0 }
    const displacementWindows = new Map<string, DisplacementWindow>()
    let displacementRevision = 0
    const contentOrigins = new Map<string, Point3>()
    const observedLayout = new Set<Element>()
    let selectedEvent: SceneEvent = { kind: 'select', region: activeRegion }
    let hoverEvent: SceneEvent = { kind: 'hover', region: activeRegion }
    let committedEvent: SceneEvent = { kind: 'commit', region: activeRegion }

    const rounded = (value: number) => Math.round(value * 1000) / 1000
    function isStill() { return reducedMotion || latest.current.still || latest.current.powerSaving }
    function wake() {
      if (!disposed && !document.hidden && !frame) frame = requestAnimationFrame(draw)
    }
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, latest.current.powerSaving ? 1 : QUALITY[quality].dpr)
      const rect = container.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      for (const surface of [canvas!, fallbackCanvas!]) {
        if (surface.width !== width) surface.width = width
        if (surface.height !== height) surface.height = height
      }
      canvas!.dataset.particleCount = String(particleCount)
      container.dataset.quality = quality
      container.dataset.depthTest = String(!!renderer && !lost)
      contentDirty = true
      lastFrame = -Infinity
      wake()
    }
    function invalidateContent() {
      contentDirty = true
      // Follow a bounded DOM transition (or scrolling) at the rendering cadence;
      // idle writing never incurs layout reads in the animation hot path.
      layoutTrackingUntil = performance.now() + 300
      lastFrame = -Infinity
      wake()
    }
    function originFor(event: SceneEvent): Point3 {
      return [...(contentOrigins.get(`${event.region}:${event.item ?? ''}`) ?? contentOrigins.get(event.region) ?? REGION_ORIGINS[event.region])]
    }
    function refreshContent() {
      const viewport = container.getBoundingClientRect()
      contentSamples = sampleContent(sceneRoot, viewport)
      contentLayout = readingLayout(contentSamples, viewport)
      for (const window of displacementWindows.values()) window.active = false
      contentOrigins.clear()
      for (const sample of contentSamples) {
        const bounds = normalizedBounds(sample.bounds, viewport)
        const previous = displacementWindows.get(sample.id)
        if (previous) { previous.target = bounds; previous.active = true }
        else displacementWindows.set(sample.id, { id: sample.id, bounds: [...bounds], target: bounds, strength: 0, active: true })
        const center = worldAtScreen(sample.bounds, viewport, pose)
        contentOrigins.set(sample.region, center)
        if (sample.item) contentOrigins.set(`${sample.region}:${sample.item}`, center)
      }
      selectedOrigin = originFor(selectedEvent)
      hoverOrigin = originFor(hoverEvent)
      commitOrigin = originFor(committedEvent)
      container.dataset.anchorCount = String(contentSamples.length)
      container.dataset.textClearanceCount = String(contentLayout.textCount)
      container.dataset.anchorRevision = String(++contentRevision)
      container.dataset.anchors = JSON.stringify(contentSamples.map(sample => ({ kind: sample.kind, region: sample.region, item: sample.item,
        dom: [sample.bounds.x, sample.bounds.y, sample.bounds.width, sample.bounds.height].map(rounded) })))
      const layoutElements = new Set(sceneRoot.querySelectorAll('.nexus-login-panel, .nexus-login-brand, .horizon-home, .horizon-day-tasks, .horizon-task-list, .horizon-day-calendar, .horizon-day-notes, .horizon-day-reminders, .horizon-day-strip-scroll, .horizon-day-aside, .horizon-focus-scene, .horizon-subtasks, .horizon-home-capture, .horizon-focus-dialog, .horizon-task-detail, .horizon-task-collection, .reminders-detail, .today-panel, .week-board, .sidebar, .editor'))
      for (const element of observedLayout) if (!layoutElements.has(element)) { layoutObserver.unobserve(element); observedLayout.delete(element) }
      for (const element of layoutElements) if (!observedLayout.has(element)) { layoutObserver.observe(element); observedLayout.add(element) }
      contentDirty = false
    }
    function advanceWindows(delta: number, staticMode: boolean) {
      const damping = staticMode ? 1 : 1 - Math.exp(-delta / 145)
      let moving = false, count = 0
      contentLayout.clearances.fill(0)
      contentLayout.strengths.fill(0)
      for (const [id, window] of displacementWindows) {
        const desired = window.active ? 1 : 0
        window.strength += (desired - window.strength) * damping
        if (Math.abs(desired - window.strength) < .001) window.strength = desired
        else moving = true
        for (let axis = 0; axis < 4; axis++) {
          window.bounds[axis] += (window.target[axis] - window.bounds[axis]) * damping
          if (Math.abs(window.target[axis] - window.bounds[axis]) < .00002) window.bounds[axis] = window.target[axis]
          else moving = true
        }
        if (!window.active && window.strength === 0) { displacementWindows.delete(id); continue }
        if (count < 16) {
          contentLayout.clearances.set(window.bounds, count * 4)
          contentLayout.strengths[count++] = window.strength
        }
      }
      contentLayout.count = count
      container.dataset.displacementCount = String(count)
      container.dataset.displacementRevision = String(++displacementRevision)
      container.dataset.displacementWindows = JSON.stringify(Array.from(displacementWindows.values()).slice(0, 16).map(window => ({
        id: window.id, bounds: window.bounds.map(rounded), strength: rounded(window.strength), active: window.active,
      })))
      return moving
    }
    function resetMeasurement() {
      previousRaf = 0
      sampleStart = 0
      sampleFrames = 0
      sampleRafMs = 0
      sampleRafCount = 0
      sampleCost = 0
    }
    function measure(now: number, cost: number) {
      if (!sampleStart) sampleStart = now
      sampleFrames++
      sampleCost += cost
      if (now - sampleStart < 1600 || sampleFrames < 16) return
      const cadence = sampleRafCount ? sampleRafMs / sampleRafCount : 16.7
      const drawMs = sampleCost / sampleFrames
      container.dataset.frameMs = String(rounded(cadence))
      container.dataset.drawMs = String(rounded(drawMs))
      container.dataset.qualitySamples = String(++qualitySamples)
      container.dataset.qualitySource = 'measured'
      // Missed RAF deadlines include GPU/compositor pressure, unlike CPU draw cost alone.
      const overloaded = cadence > 24 || drawMs > 10
      const healthy = cadence < 20 && drawMs < 5
      slowSamples = overloaded ? slowSamples + 1 : 0
      healthySamples = healthy ? healthySamples + 1 : 0
      const next = slowSamples >= 1 ? quality === 'high' ? 'balanced' : 'low'
        : healthySamples >= 3 ? quality === 'low' ? 'balanced' : 'high' : quality
      if (next !== quality) {
        quality = next
        particleCount = Math.round(maxCount * QUALITY[quality].fraction)
        healthySamples = 0
        slowSamples = 0
        resize()
      }
      resetMeasurement()
    }
    function startCommit(event: SceneEvent, now: number) {
      activeRegion = event.region
      committedEvent = event
      commitOrigin = originFor(event)
      commitStart = now
      commitAction = event.action === 'complete' ? 2 : event.action === 'restore' ? 3 : event.action === 'update' ? 4 : 1
      commitDirection = event.direction && event.direction < 0 ? -1 : 1
      container.dataset.commitAction = event.action ?? 'add'
      container.dataset.commitRegion = event.region
      container.dataset.commitCount = String(++commitCount)
    }
    function onScene(event: SceneEvent) {
      if (disposed) return
      const now = performance.now()
      container.dataset.lastEvent = event.kind
      if (event.kind === 'typing') {
        typing = event.active !== false
        container.dataset.typing = String(typing)
      } else if (event.kind === 'commit') {
        lastCustomCommit = now
        pendingPulseAt = 0
        window.clearTimeout(pendingPulseTimer)
        pendingPulseTimer = 0
        lastPulse = latest.current.pulse
        startCommit(event, now)
      } else if (event.kind === 'hover') {
        hoverStrength = event.active === false ? 0 : .34
        if (event.active !== false) {
          activeRegion = event.region
          hoverEvent = event
          hoverOrigin = originFor(event)
        }
      } else {
        activeRegion = event.region
        selectedEvent = event
        selectedOrigin = originFor(event)
        selectedStrength = event.active === false ? 0 : .64
        if (event.kind === 'day') dayOffset = Math.max(-.75, Math.min(.75, dayOffset + (event.direction ?? 0) * .22))
        if (event.kind === 'select' && latest.current.view === 'home') {
          if (event.region === 'tasks' && event.item && event.active !== false) {
            // An explicit task choice is one small step along the same spatial
            // route. Hover and checkbox commits never launch a camera flight.
            taskOffset = Math.max(-.8, Math.min(.8, taskOffset + (event.direction ?? 1) * .42))
          } else if (event.region === 'home') taskOffset = 0
        }
        // Measured rows use their precise centre. Only items without their own
        // visible bank need a small deterministic offset within the parent region.
        if (event.item && !contentOrigins.has(`${event.region}:${event.item}`)) {
          let hash = 0
          for (let i = 0; i < event.item.length; i++) hash = (Math.imul(hash, 31) + event.item.charCodeAt(i)) | 0
          selectedOrigin[0] += ((hash >>> 0) % 11 - 5) * .09
          selectedOrigin[2] += ((hash >>> 8) % 11 - 5) * .09
        }
      }
      lastFrame = -Infinity
      wake()
    }
    function draw(now: number) {
      frame = 0
      if (disposed || document.hidden) return
      const config = latest.current
      const staticMode = isStill()
      if (staticMode !== wasStatic) { resetMeasurement(); previousTime = 0; wasStatic = staticMode }
      if (!staticMode && previousRaf) {
        sampleRafMs += Math.min(now - previousRaf, 250)
        sampleRafCount++
      }
      previousRaf = now
      const framesPerSecond = renderer && !lost ? 30 : 12
      if (!staticMode && now - lastFrame < 1000 / framesPerSecond - .75) { wake(); return }
      const started = performance.now()
      // Rotation follows real visible elapsed time even when a frame is slow.
      // Visibility and motion-mode transitions reset previousTime, avoiding jumps.
      const elapsed = previousTime ? Math.max(0, now - previousTime) : 0
      const delta = Math.min(elapsed || 33, 80)
      previousTime = now
      lastFrame = now
      // The DOM owns whether the inline steps are open. In particular, leaving
      // immersive focus restores that precise stage instead of resetting it.
      const focusStage = sceneRoot.querySelector('.horizon-home')?.getAttribute('data-focus-stage')
      if (focusStage === 'steps' || focusStage === 'selected' || focusStage === 'empty') inlineFocus = focusStage === 'steps'
      const key = `${config.view}:${config.focus}:${dayOffset}:${taskOffset}:${inlineFocus}`
      if (key !== settingsKey) {
        const viewChanged = !settingsKey.startsWith(`${config.view}:`)
        const focusChanged = settingsKey.split(':')[1] !== String(config.focus)
        settingsKey = key
        from = copyPose(pose)
        target = viewPose(config.view, config.focus, dayOffset, taskOffset, inlineFocus)
        transitionStart = now
        if (viewChanged || focusChanged) {
          activeRegion = config.focus ? 'focus' : regionForView(config.view)
          selectedEvent = { kind: 'select', region: activeRegion }
          hoverEvent = { kind: 'hover', region: activeRegion }
          selectedOrigin = originFor(selectedEvent)
          hoverOrigin = [...selectedOrigin]
          selectedStrength = 0
          hoverStrength = 0
          // An unmounted editor does not reliably dispatch focusout. Preserve
          // autofocus in the next view while clearing a detached editing state.
          typing = hasTextFocus()
        }
        contentDirty = true
      }
      const progress = staticMode ? 1 : Math.min(1, Math.max(0, (now - transitionStart) / FLIGHT_MS))
      pose = flightPose(from, target, progress)
      if (staticMode) { from = copyPose(target); transitionStart = -Infinity }
      if (!staticMode && now < layoutTrackingUntil) contentDirty = true
      if (contentDirty) refreshContent()
      advanceWindows(delta, staticMode)
      const damping = staticMode ? 1 : 1 - Math.exp(-delta / 180)
      calm += ((typing ? 1 : 0) - calm) * damping
      const motionScale = staticMode ? 0 : 1 - calm * .96
      parallax[0] += (pointer[0] * motionScale - parallax[0]) * damping
      parallax[1] += (pointer[1] * motionScale - parallax[1]) * damping
      if (staticMode) parallax = [0, 0]
      selection += ((Math.max(hoverStrength, selectedStrength) * (1 - calm * .55)) - selection) * damping
      const camera = copyPose(pose)
      camera.eye[0] += parallax[0] * .48
      camera.eye[1] -= parallax[1] * .23
      camera.target[0] += parallax[0] * .12
      camera.target[1] -= parallax[1] * .07
      if (config.pulse !== lastPulse) {
        lastPulse = config.pulse
        // Compatible legacy pulses share one successful commit with a custom event.
        if (now - lastCustomCommit > 160) {
          pendingPulseAt = now + 120
          window.clearTimeout(pendingPulseTimer)
          // A legacy pulse still receives one draw when animation is disabled.
          pendingPulseTimer = window.setTimeout(() => { pendingPulseTimer = 0; lastFrame = -Infinity; wake() }, 125)
        }
      }
      if (pendingPulseAt && now >= pendingPulseAt) {
        pendingPulseAt = 0
        if (now - lastCustomCommit > 160) startCommit({ kind: 'commit', region: regionForView(config.view), action: 'update' }, now)
      }
      const commitPhase = Math.min(1, Math.max(0, (now - commitStart) / COMMIT_MS))
      if (!staticMode) animationTime += elapsed / 1000
      const light: SceneLight = { origin: commitPhase < 1 ? commitOrigin : hoverStrength > 0 ? hoverOrigin : selectedOrigin, strength: selection, commit: staticMode ? 1 : commitPhase, action: commitAction, direction: commitDirection }
      if (renderer && !lost) renderer.draw(camera, animationTime, light, particleCount, contentLayout, config.particleColor)
      else drawFallback(fallbackCanvas!, points, camera, animationTime, contentLayout, config.particleColor)
      canvas!.dataset.frame = String(++drawCount)
      container.dataset.region = activeRegion
      container.dataset.camera = JSON.stringify({ eye: camera.eye.map(rounded), target: camera.target.map(rounded), focus: rounded(camera.focus) })
      container.dataset.cameraProgress = String(rounded(progress))
      container.dataset.parallax = JSON.stringify(parallax.map(rounded))
      container.dataset.typing = String(typing)
      container.dataset.commitProgress = String(rounded(commitPhase))
      container.dataset.animationTime = String(rounded(animationTime))
      container.dataset.rotation = String(rounded((animationTime % PARTICLE_ROTATION_SECONDS) * Math.PI * 2 / PARTICLE_ROTATION_SECONDS))
      if (!staticMode) {
        if (renderer && !lost) measure(now, performance.now() - started)
        wake()
      }
    }
    function onPointer(event: PointerEvent) {
      if (event.pointerType === 'touch') return
      pointer = [Math.max(-1, Math.min(1, event.clientX / Math.max(1, window.innerWidth) * 2 - 1)), Math.max(-1, Math.min(1, event.clientY / Math.max(1, window.innerHeight) * 2 - 1))]
      if (!isStill()) wake()
    }
    function onPointerLeave() { pointer = [0, 0] }
    function onMedia() {
      reducedMotion = media.matches
      setReduced(reducedMotion)
      previousTime = 0
      resetMeasurement()
      lastFrame = -Infinity
      wake()
    }
    function onVisibility() {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; previousTime = 0; resetMeasurement() }
      else { previousTime = 0; resetMeasurement(); lastFrame = -Infinity; wake() }
    }
    function onLost(event: Event) {
      event.preventDefault()
      lost = true
      renderer?.dispose()
      renderer = null
      container.dataset.depthTest = 'false'
      // Populate the replacement before React exposes it. A scheduled RAF may
      // arrive after the hidden attribute changes, especially in static mode.
      // Recovery must never reveal a blank fallback canvas in that interval.
      drawFallback(fallbackCanvas!, points, pose, animationTime, contentLayout, latest.current.particleColor)
      setFallback(true)
      cancelAnimationFrame(frame)
      frame = 0
      wake()
    }
    function onRestored() {
      lost = false
      renderer = createWebGL(canvas!, points)
      setFallback(!renderer)
      container.dataset.depthTest = String(!!renderer)
      previousTime = 0
      resetMeasurement()
      lastFrame = -Infinity
      wake()
    }
    container.dataset.cloudCount = '1'
    container.dataset.rotationDuration = String(PARTICLE_ROTATION_SECONDS)
    container.dataset.projection = 'single'
    container.dataset.qualitySamples = '0'
    container.dataset.qualitySource = 'initial'
    container.dataset.commitCount = '0'
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    const layoutObserver = new ResizeObserver(invalidateContent)
    layoutObserver.observe(sceneRoot)
    const mutations = new MutationObserver(records => {
      if (records.some(record => !container.contains(record.target))) invalidateContent()
    })
    mutations.observe(sceneRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'data-open', 'data-direction', 'data-scene-item', 'data-scene-selected', 'data-focus-stage'] })
    const stopScene = listenHorizonScene(onScene)
    const stopInteraction = observeHorizonInteraction(onScene)
    window.addEventListener('resize', resize)
    media.addEventListener('change', onMedia)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('pointermove', onPointer, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave, { passive: true })
    document.addEventListener('scroll', invalidateContent, { passive: true, capture: true })
    sceneRoot.addEventListener('animationend', invalidateContent)
    sceneRoot.addEventListener('transitionend', invalidateContent)
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    requestDraw.current = () => { lastFrame = -Infinity; wake() }
    resize()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      window.clearTimeout(pendingPulseTimer)
      requestDraw.current = () => {}
      observer.disconnect()
      layoutObserver.disconnect()
      mutations.disconnect()
      stopScene()
      stopInteraction()
      window.removeEventListener('resize', resize)
      media.removeEventListener('change', onMedia)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('pointermove', onPointer)
      document.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('scroll', invalidateContent, true)
      sceneRoot.removeEventListener('animationend', invalidateContent)
      sceneRoot.removeEventListener('transitionend', invalidateContent)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      renderer?.dispose()
    }
  }, [powerSaving])

  useEffect(() => { requestDraw.current() }, [view, focus, still, pulse, color])

  return <div className="horizon-particle-landscape" aria-hidden="true" data-renderer={fallback ? 'canvas2d' : 'webgl'} data-motion={still || reduced || powerSaving ? 'static' : 'animated'} data-view={view} data-particle-color={color}>
    <canvas ref={canvasRef} className="horizon-particle-landscape__canvas" hidden={fallback} />
    <canvas ref={fallbackRef} className="horizon-particle-landscape__canvas" hidden={!fallback} />
  </div>
}
