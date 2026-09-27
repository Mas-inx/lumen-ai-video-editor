/**
 * Extruded 3D titles. Glyph outlines come straight from the font files (via
 * opentype.js), become three.js shapes and are extruded with a bevel, then lit
 * by a studio environment so chrome and gold actually reflect.
 */
import * as THREE from 'three'
import { parse, type Font, type Glyph } from 'opentype.js'
import geist600 from '@fontsource/geist/files/geist-latin-600-normal.woff?url'
import geist800 from '@fontsource/geist/files/geist-latin-800-normal.woff?url'
import bricolage700 from '@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff?url'
import bricolage800 from '@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-800-normal.woff?url'
import serifRegular from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff?url'
import serifItalic from '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff?url'
import type { TextStyle } from '@/editor/types'
import { notifyMediaReady } from '@/engine/media'
import { rad, renderStage, type Stage } from './stage'

// ─── Fonts ───────────────────────────────────────────────────────────────

function fontUrl(style: TextStyle) {
  switch (style.font) {
    case 'serif':
      return style.italic ? serifItalic : serifRegular
    case 'display':
    case 'hand':
      return style.weight >= 750 ? bricolage800 : bricolage700
    default:
      return style.weight >= 700 ? geist800 : geist600
  }
}

const fonts = new Map<string, Font | 'loading' | 'error'>()

function getFont(url: string): Font | null {
  const hit = fonts.get(url)
  if (hit === 'loading' || hit === 'error') return null
  if (hit) return hit
  fonts.set(url, 'loading')
  fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => {
      fonts.set(url, parse(buf))
      notifyMediaReady()
    })
    .catch(() => fonts.set(url, 'error'))
  return null
}

// ─── Geometry ────────────────────────────────────────────────────────────

interface TextGeometry {
  geometry: THREE.ExtrudeGeometry
  width: number
  height: number
  /** Face UVs are shape coordinates; this box maps them onto 0–1 for the face ramp. */
  uv: { x: number; y: number; w: number; h: number }
}

const geometries = new Map<string, TextGeometry>()

function glyphShapes(commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]) {
  const sp = new THREE.ShapePath()
  for (const c of commands) {
    if (c.type === 'M') sp.moveTo(c.x!, -c.y!)
    else if (c.type === 'L') sp.lineTo(c.x!, -c.y!)
    else if (c.type === 'Q') sp.quadraticCurveTo(c.x1!, -c.y1!, c.x!, -c.y!)
    else if (c.type === 'C') sp.bezierCurveTo(c.x1!, -c.y1!, c.x2!, -c.y2!, c.x!, -c.y!)
  }
  // three r186 works out holes from geometric nesting, so glyph winding (which
  // differs between TrueType and CFF fonts) doesn't matter.
  return sp.subPaths.length ? sp.toShapes() : []
}

/**
 * Lays glyphs out directly from the character map, advances and kerning.
 * (opentype.js's full shaper chokes on some fonts' substitution tables, and
 * titles don't need ligatures.)
 */
function layoutLine(font: Font, text: string, size: number, tracking: number) {
  const scale = size / font.unitsPerEm
  const glyphs: { glyph: Glyph; x: number }[] = []
  let x = 0
  let prev: Glyph | null = null
  for (const ch of text) {
    const glyph = font.charToGlyph(ch)
    if (prev) x += font.getKerningValue(prev, glyph) * scale
    glyphs.push({ glyph, x })
    x += (glyph.advanceWidth ?? font.unitsPerEm * 0.5) * scale + tracking * size
    prev = glyph
  }
  return { glyphs, width: Math.max(0, x - tracking * size) }
}

function buildGeometry(font: Font, style: TextStyle): TextGeometry {
  const content = style.uppercase ? style.content.toUpperCase() : style.content
  const size = style.size
  const lines = content.split('\n').map((l) => layoutLine(font, l, size, style.letterSpacing))
  const maxW = Math.max(1, ...lines.map((l) => l.width))
  const shapes: THREE.Shape[] = []
  lines.forEach((line, i) => {
    const x0 = style.align === 'left' ? -maxW / 2 : style.align === 'right' ? maxW / 2 - line.width : -line.width / 2
    const y0 = i * size * style.lineHeight
    for (const { glyph, x } of line.glyphs) shapes.push(...glyphShapes(glyph.getPath(x0 + x, y0, size).commands))
  })
  const depth = Math.max(1, size * style.extrude)
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: style.bevel,
    bevelThickness: size * 0.028,
    bevelSize: size * 0.016,
    bevelSegments: 4,
    curveSegments: 8,
  })
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!.clone()
  geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -(box.min.z + box.max.z) / 2)
  geometry.computeVertexNormals()
  const width = box.max.x - box.min.x
  const height = box.max.y - box.min.y
  return { geometry, width, height, uv: { x: box.min.x, y: box.min.y, w: Math.max(1, width), h: Math.max(1, height) } }
}

function geometryFor(style: TextStyle, customUrl?: string | null): TextGeometry | null {
  const url = customUrl ?? fontUrl(style)
  const font = getFont(url)
  if (!font) return null
  const key = [url, style.content, style.uppercase, style.size, style.extrude, style.bevel, style.letterSpacing, style.lineHeight, style.align].join('|')
  let g = geometries.get(key)
  if (!g) {
    if (geometries.size > 40) {
      for (const [k, v] of geometries) {
        v.geometry.dispose()
        geometries.delete(k)
        if (geometries.size < 30) break
      }
    }
    geometries.set(key, (g = buildGeometry(font, style)))
  }
  return g
}

// ─── Materials & scene ───────────────────────────────────────────────────

const materials = new Map<string, THREE.Material[]>()

/**
 * Flat letter faces reflect a single direction, so on their own they read as
 * flat grey. Classic chrome and gold titles get their banding painted on:
 * a vertical ramp with a hard "horizon" across the face.
 */
function faceRamp(stops: [number, string][]) {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  for (const [at, color] of stops) g.addColorStop(at, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const CHROME_RAMP: [number, string][] = [
  [0, '#ffffff'],
  [0.3, '#dfe6f4'],
  [0.49, '#8e9ab2'],
  [0.5, '#262a35'],
  [0.58, '#4b5162'],
  [0.8, '#bcc4d4'],
  [1, '#f6f8fc'],
]

const GOLD_RAMP: [number, string][] = [
  [0, '#fff6d2'],
  [0.32, '#f4c865'],
  [0.49, '#b8852e'],
  [0.5, '#6a4510'],
  [0.6, '#a06d24'],
  [0.84, '#f1c66c'],
  [1, '#ffeab0'],
]

function materialsFor(style: TextStyle): THREE.Material[] {
  const key = `${style.material}|${style.color}|${style.glow}`
  let m = materials.get(key)
  if (m) return m
  const color = new THREE.Color(style.color.slice(0, 7))
  switch (style.material) {
    case 'chrome':
      m = [
        new THREE.MeshStandardMaterial({ map: faceRamp(CHROME_RAMP), metalness: 1, roughness: 0.1, transparent: true }),
        new THREE.MeshStandardMaterial({ color: 0xc4cad6, metalness: 1, roughness: 0.22, transparent: true }),
      ]
      break
    case 'gold':
      m = [
        new THREE.MeshStandardMaterial({ map: faceRamp(GOLD_RAMP), metalness: 1, roughness: 0.16, transparent: true }),
        new THREE.MeshStandardMaterial({ color: 0xc08a36, metalness: 1, roughness: 0.3, transparent: true }),
      ]
      break
    case 'neon': {
      const glow = new THREE.Color((style.glow ?? style.color).slice(0, 7))
      m = [
        new THREE.MeshBasicMaterial({ color: glow.clone().lerp(new THREE.Color(0xffffff), 0.55), transparent: true, toneMapped: false }),
        new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(0.55), transparent: true, toneMapped: false }),
      ]
      break
    }
    default:
      m = [
        new THREE.MeshStandardMaterial({ color, metalness: 0.02, roughness: 0.42, transparent: true }),
        new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.55), metalness: 0.02, roughness: 0.55, transparent: true }),
      ]
  }
  materials.set(key, m)
  return m
}

interface TextScene {
  scene: THREE.Scene
  root: THREE.Group
  mesh: THREE.Mesh
  shine: THREE.PointLight
}

const scenes = new WeakMap<THREE.WebGLRenderer, TextScene>()

/** A photo-studio environment: dark dome, a hot horizon band and softboxes — what chrome needs to look like chrome. */
function studioEnvironment() {
  const scene = new THREE.Scene()
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#0c0d14')
  g.addColorStop(0.36, '#2c3144')
  g.addColorStop(0.47, '#e9edff')
  g.addColorStop(0.5, '#ffffff')
  g.addColorStop(0.54, '#40465c')
  g.addColorStop(0.7, '#101218')
  g.addColorStop(1, '#040406')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })))
  const box = (x: number, y: number, z: number, w: number, h: number, k: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide }))
    m.position.set(x, y, z)
    m.lookAt(0, 0, 0)
    scene.add(m)
  }
  box(-5, 4, 5, 4, 2.2, 3.5)
  box(6, 1.5, 3, 2, 5, 2.4)
  box(0, 7, -2, 6, 1.2, 2)
  return scene
}

function sceneFor(stage: Stage): TextScene {
  let s = scenes.get(stage.renderer)
  if (s) return s
  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(stage.renderer)
  scene.environment = pmrem.fromScene(studioEnvironment(), 0.02).texture
  pmrem.dispose()
  scene.add(new THREE.AmbientLight(0xffffff, 0.35))
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(0.5, 0.9, 1.2)
  const rim = new THREE.DirectionalLight(0xa8b8ff, 1.6)
  rim.position.set(-1, 0.3, -0.8)
  const shine = new THREE.PointLight(0xffffff, 0, 0, 0)
  scene.add(key, rim, shine)
  const root = new THREE.Group()
  const mesh = new THREE.Mesh()
  root.add(mesh)
  scene.add(root)
  s = { scene, root, mesh, shine }
  scenes.set(stage.renderer, s)
  return s
}

export interface Text3D {
  style: TextStyle
  /** The font file for a project font (built-in fonts are found from the style). */
  fontUrl?: string | null
  x: number
  y: number
  z: number
  scale: number
  rotation: number
  rotateX: number
  rotateY: number
  opacity: number
  t: number
}

/** Renders a 3D title; returns null until its font has loaded. */
export function renderText3D(stage: Stage, text: Text3D) {
  const g = geometryFor(text.style, text.fontUrl)
  if (!g) return null
  const s = sceneFor(stage)
  const mats = materialsFor(text.style)
  for (const m of mats) m.opacity = text.opacity
  const ramp = (mats[0] as THREE.MeshStandardMaterial).map
  if (ramp) {
    ramp.repeat.set(1 / g.uv.w, 1 / g.uv.h)
    ramp.offset.set(-g.uv.x / g.uv.w, -g.uv.y / g.uv.h)
  }
  s.mesh.geometry = g.geometry
  s.mesh.material = mats
  s.root.position.set(text.x, -text.y, text.z)
  s.root.rotation.set(-rad(text.rotateX), rad(text.rotateY), -rad(text.rotation), 'YXZ')
  s.root.scale.setScalar(text.scale)
  // A light sweeping across metal titles makes them gleam.
  const metal = text.style.material === 'chrome' || text.style.material === 'gold'
  s.shine.intensity = metal ? 6 : 0
  s.shine.position.set(Math.sin(text.t * 0.9) * stage.pw * 0.55 + text.x, stage.ph * 0.15 - text.y, stage.distance * 0.35)
  const canvas = renderStage(stage, s.scene, text.style.material !== 'neon')
  return { canvas, width: g.width, height: g.height }
}
