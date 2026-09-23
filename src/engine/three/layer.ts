/**
 * 3D layers: a clip's flat render placed in space with a full 3D transform,
 * plus the 3D effects (tilt card, curved screen, flag wave, photo cube,
 * reflection). Used whenever a clip has rotateX/rotateY/z or a 3D effect.
 */
import * as THREE from 'three'
import type { Effect } from '@/editor/types'
import { basicMaterial, canvasTexture, rad, renderStage, type Stage } from './stage'

export interface Layer3D {
  canvas: HTMLCanvasElement
  x: number
  y: number
  z: number
  scale: number
  rotation: number
  rotateX: number
  rotateY: number
  opacity: number
  effects: Effect[]
  /** seconds since the clip started, for effect motion */
  t: number
}

interface LayerScene {
  scene: THREE.Scene
  root: THREE.Group
  inner: THREE.Group
  material: THREE.MeshBasicMaterial
  flat: THREE.Mesh
  curved: THREE.Mesh
  waving: THREE.Mesh
  cube: THREE.Mesh
  cubeMaterial: THREE.MeshStandardMaterial
  reflection: THREE.Mesh
  reflectionMaterial: THREE.MeshBasicMaterial
  shadow: THREE.Mesh
  shadowMaterial: THREE.MeshBasicMaterial
  roundMask: THREE.Texture
  cubeTex: THREE.Texture | null
  masked: boolean
  curveX: Float32Array
  waveX: Float32Array
  waveY: Float32Array
}

const scenes = new Map<string, LayerScene>()

function gradientTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 256) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!, w, h)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

function build(pw: number, ph: number): LayerScene {
  const scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 1.4))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(0.6, 1, 1.4)
  scene.add(key)

  const root = new THREE.Group()
  const inner = new THREE.Group()
  root.add(inner)
  scene.add(root)

  // Rounded-corner mask for the floating card look.
  const roundMask = gradientTexture((ctx, w, h) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, Math.min(w, h) * 0.045)
    ctx.fill()
  }, 512, 288)

  const material = basicMaterial({ side: THREE.DoubleSide })
  const flat = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), material)
  const curvedGeo = new THREE.PlaneGeometry(pw, ph, 96, 1)
  const curved = new THREE.Mesh(curvedGeo, material)
  const waveGeo = new THREE.PlaneGeometry(pw, ph, 64, 16)
  const waving = new THREE.Mesh(waveGeo, material)
  const cubeMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 })
  const cube = new THREE.Mesh(new THREE.BoxGeometry(ph * 0.62, ph * 0.62, ph * 0.62), cubeMaterial)

  const reflectionMaterial = basicMaterial({
    side: THREE.DoubleSide,
    alphaMap: gradientTexture((ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, '#000')
      g.addColorStop(0.55, '#000')
      g.addColorStop(1, '#6a6a6a')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }),
    depthWrite: false,
  })
  const reflection = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), reflectionMaterial)
  reflection.scale.y = -1

  const shadowMaterial = basicMaterial({
    color: 0x000000,
    alphaMap: gradientTexture((ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
      g.addColorStop(0, '#9a9a9a')
      g.addColorStop(0.6, '#3a3a3a')
      g.addColorStop(1, '#000')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }),
    depthWrite: false,
  })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(pw * 1.25, ph * 1.3), shadowMaterial)
  shadow.renderOrder = -1

  inner.add(shadow, flat, curved, waving, cube, reflection)

  const cpos = curvedGeo.attributes.position as THREE.BufferAttribute
  const wpos = waveGeo.attributes.position as THREE.BufferAttribute
  return {
    scene,
    root,
    inner,
    material,
    flat,
    curved,
    waving,
    cube,
    cubeMaterial,
    reflection,
    reflectionMaterial,
    shadow,
    shadowMaterial,
    roundMask,
    cubeTex: null,
    masked: false,
    curveX: Float32Array.from({ length: cpos.count }, (_, i) => cpos.getX(i)),
    waveX: Float32Array.from({ length: wpos.count }, (_, i) => wpos.getX(i)),
    waveY: Float32Array.from({ length: wpos.count }, (_, i) => wpos.getY(i)),
  }
}

export function renderLayer3D(stage: Stage, layer: Layer3D) {
  const { pw, ph } = stage
  const key = `${pw}x${ph}`
  let s = scenes.get(key)
  if (!s) scenes.set(key, (s = build(pw, ph)))

  const amount = (kind: Effect['kind']) => (layer.effects.find((e) => e.kind === kind && e.enabled)?.amount ?? 0) / 100
  const tilt = amount('tilt3d')
  const curve = amount('curve3d')
  const wave = amount('wave3d')
  const cube = amount('cube3d')
  const mirror = amount('mirror3d')
  const t = layer.t

  const tex = canvasTexture(layer.canvas, stage.renderer)
  s.material.map = tex
  s.material.opacity = layer.opacity
  if (s.masked !== tilt > 0) {
    s.masked = tilt > 0
    s.material.alphaMap = s.masked ? s.roundMask : null
    s.material.needsUpdate = true
  }

  // Transform: project space is y-down, three is y-up.
  s.root.position.set(layer.x, -layer.y, layer.z)
  s.root.rotation.set(-rad(layer.rotateX), rad(layer.rotateY), -rad(layer.rotation), 'YXZ')
  s.root.scale.setScalar(layer.scale)
  s.inner.position.set(0, 0, 0)
  s.inner.rotation.set(0, 0, 0)
  s.inner.scale.setScalar(1)

  s.flat.visible = s.curved.visible = s.waving.visible = s.cube.visible = false
  s.reflection.visible = s.shadow.visible = false

  if (cube > 0) {
    s.cube.visible = true
    // Square centre-crop of the shot on every face.
    if (s.cubeTex?.image !== layer.canvas) {
      s.cubeTex?.dispose()
      s.cubeTex = new THREE.Texture(layer.canvas)
      s.cubeTex.colorSpace = THREE.SRGBColorSpace
      s.cubeTex.repeat.set(ph / pw, 1)
      s.cubeTex.offset.set((1 - ph / pw) / 2, 0)
      s.cubeMaterial.map = s.cubeTex
      s.cubeMaterial.needsUpdate = true
    }
    s.cubeTex.needsUpdate = true
    s.cubeMaterial.opacity = layer.opacity
    s.cubeMaterial.transparent = layer.opacity < 1
    s.cube.rotation.set(0.42 + Math.sin(t * 0.5) * 0.12, t * (0.4 + cube * 0.8), 0.08)
    s.cube.scale.setScalar(0.75 + cube * 0.35)
  } else {
    let mesh = s.flat
    if (wave > 0) {
      mesh = s.waving
      const pos = s.waving.geometry.attributes.position as THREE.BufferAttribute
      const amp = ph * 0.07 * wave
      for (let i = 0; i < pos.count; i++) {
        const x = s.waveX[i]
        const u = (x + pw / 2) / pw
        pos.setZ(i, Math.sin(u * Math.PI * 2.2 - t * 3.2) * amp * u + Math.sin(s.waveY[i] / ph * 3 + t * 2) * amp * 0.15 * u)
        pos.setY(i, s.waveY[i] + Math.sin(u * 6 - t * 3) * amp * 0.08 * u)
      }
      pos.needsUpdate = true
      s.waving.geometry.computeBoundingSphere()
      s.inner.scale.setScalar(0.9)
      s.inner.rotation.y = -0.12 * wave
    } else if (curve > 0) {
      mesh = s.curved
      const pos = s.curved.geometry.attributes.position as THREE.BufferAttribute
      const theta = rad(20 + 90 * curve)
      const R = pw / theta
      for (let i = 0; i < pos.count; i++) {
        const a = s.curveX[i] / R
        pos.setX(i, R * Math.sin(a))
        pos.setZ(i, R * (1 - Math.cos(a)))
      }
      pos.needsUpdate = true
      s.curved.geometry.computeBoundingSphere()
      s.inner.scale.setScalar(0.9)
      s.inner.position.z = -ph * 0.08 * curve
    }
    mesh.visible = true

    if (tilt > 0) {
      // A floating card: a clear resting angle plus a slow, breathing sway.
      s.inner.rotation.y += (-0.46 + Math.sin(t * 0.55) * 0.2) * tilt
      s.inner.rotation.x += (0.2 + Math.sin(t * 0.43 + 1) * 0.07) * tilt
      s.inner.rotation.z += 0.035 * tilt
      s.inner.scale.multiplyScalar(1 - 0.26 * tilt)
      s.shadow.visible = true
      s.shadow.position.set(ph * 0.02, -ph * 0.05, -ph * 0.12)
      s.shadowMaterial.opacity = 0.75 * tilt * layer.opacity
    }
    if (mirror > 0) {
      s.inner.scale.multiplyScalar(1 - 0.3 * mirror)
      s.inner.position.y += ph * 0.2 * mirror
      s.inner.rotation.x += -0.1 * mirror
      s.reflection.visible = true
      s.reflection.position.set(0, -ph * 1.02, 0)
      s.reflectionMaterial.map = tex
      s.reflectionMaterial.opacity = 0.55 * mirror * layer.opacity
    }
  }

  return renderStage(stage, s.scene)
}
