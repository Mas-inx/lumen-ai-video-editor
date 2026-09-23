/**
 * The 3D stage: a WebGL renderer whose perspective camera is framed so that a
 * plane of the project's size at z = 0 exactly fills the output. World units
 * are project pixels, so 2D and 3D layers line up perfectly.
 */
import * as THREE from 'three'

export interface Stage {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  /** project size in world units */
  pw: number
  ph: number
  /** camera distance at which a pw×ph plane fills the frame */
  distance: number
}

const FOV = 40

export function createStage(): Stage {
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, 0)
  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 1, 100_000)
  return { renderer, camera, canvas, pw: 0, ph: 0, distance: 0 }
}

/** Sizes the drawing buffer and resets the camera for a pw×ph project. */
export function frameStage(stage: Stage, width: number, height: number, pw: number, ph: number) {
  if (stage.canvas.width !== width || stage.canvas.height !== height) stage.renderer.setSize(width, height, false)
  if (stage.pw !== pw || stage.ph !== ph) {
    stage.pw = pw
    stage.ph = ph
    stage.distance = ph / (2 * Math.tan((FOV * Math.PI) / 360))
    stage.camera.aspect = pw / ph
    stage.camera.near = stage.distance * 0.01
    stage.camera.far = stage.distance * 60
    stage.camera.updateProjectionMatrix()
  }
  stage.camera.position.set(0, 0, stage.distance)
  stage.camera.rotation.set(0, 0, 0)
}

export function renderStage(stage: Stage, scene: THREE.Scene, toneMapped = false) {
  stage.renderer.toneMapping = toneMapped ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping
  stage.renderer.toneMappingExposure = 1.05
  stage.renderer.render(scene, stage.camera)
  return stage.canvas
}

// ─── Canvas textures ─────────────────────────────────────────────────────

const textures = new WeakMap<HTMLCanvasElement, { tex: THREE.CanvasTexture; w: number; h: number }>()

/** A texture that mirrors a canvas; re-uploaded every time it's requested. */
export function canvasTexture(canvas: HTMLCanvasElement, renderer?: THREE.WebGLRenderer) {
  let entry = textures.get(canvas)
  if (!entry || entry.w !== canvas.width || entry.h !== canvas.height) {
    entry?.tex.dispose()
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.generateMipmaps = true
    if (renderer) tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    entry = { tex, w: canvas.width, h: canvas.height }
    textures.set(canvas, entry)
  }
  entry.tex.needsUpdate = true
  return entry.tex
}

export function basicMaterial(opts: THREE.MeshBasicMaterialParameters = {}) {
  return new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, ...opts })
}

/** Remaps a plane geometry's UVs to a sub-rectangle of its texture. */
export function cropUV(geometry: THREE.BufferGeometry, u0: number, v0: number, u1: number, v1: number) {
  const uv = geometry.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0))
  uv.needsUpdate = true
  return geometry
}

export const rad = (deg: number) => (deg * Math.PI) / 180

/** A reusable 2D scratch canvas keyed by name. */
const scratch = new Map<string, HTMLCanvasElement>()
export function scratchCanvas(name: string, w: number, h: number) {
  let c = scratch.get(name)
  if (!c) scratch.set(name, (c = document.createElement('canvas')))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const ctx = c.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.clearRect(0, 0, w, h)
  return { canvas: c, ctx }
}
