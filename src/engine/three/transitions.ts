/**
 * 3D transitions. Each one is a tiny scene of textured planes driven by a
 * single progress value p ∈ [0, 1]; `from` and `to` are the two shots,
 * already composited to canvases by the 2D layer pipeline.
 */
import * as THREE from 'three'
import type { TransitionKind } from '@/editor/types'
import { clamp, easeInOutCubic, easeOutBack, easeOutCubic, lerp, mulberry32 } from '@/lib/math'
import { basicMaterial, canvasTexture, cropUV, frameStage, renderStage, type Stage } from './stage'

interface TransitionScene {
  scene: THREE.Scene
  a: THREE.MeshBasicMaterial[]
  b: THREE.MeshBasicMaterial[]
  update: (p: number, stage: Stage) => void
}

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

const plane = (w: number, h: number, material: THREE.Material, segX = 1, segY = 1) => new THREE.Mesh(new THREE.PlaneGeometry(w, h, segX, segY), material)

function buildCube(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial()
  const mb = basicMaterial()
  const pivot = new THREE.Group()
  const faceA = plane(pw, ph, ma)
  faceA.position.z = pw / 2
  const faceB = plane(pw, ph, mb)
  faceB.rotation.y = Math.PI / 2
  faceB.position.x = pw / 2
  pivot.add(faceA, faceB)
  pivot.position.z = -pw / 2
  scene.add(pivot)
  return {
    scene,
    a: [ma],
    b: [mb],
    update(p, stage) {
      pivot.rotation.y = -easeInOutCubic(p) * (Math.PI / 2)
      stage.camera.position.z = stage.distance + Math.sin(Math.PI * p) * pw * 0.55
    },
  }
}

function buildFlip(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial()
  const mb = basicMaterial()
  const pivot = new THREE.Group()
  const front = plane(pw, ph, ma)
  front.position.z = 0.5
  const back = plane(pw, ph, mb)
  back.rotation.y = Math.PI
  back.position.z = -0.5
  pivot.add(front, back)
  scene.add(pivot)
  return {
    scene,
    a: [ma],
    b: [mb],
    update(p, stage) {
      pivot.rotation.y = easeInOutCubic(p) * Math.PI
      pivot.rotation.x = Math.sin(Math.PI * p) * 0.12
      stage.camera.position.z = stage.distance + Math.sin(Math.PI * p) * pw * 0.4
    },
  }
}

function buildDoor(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial({ side: THREE.DoubleSide })
  const mb = basicMaterial()
  const left = new THREE.Mesh(cropUV(new THREE.PlaneGeometry(pw / 2, ph), 0, 0, 0.5, 1), ma)
  left.position.x = pw / 4
  const right = new THREE.Mesh(cropUV(new THREE.PlaneGeometry(pw / 2, ph), 0.5, 0, 1, 1), ma)
  right.position.x = -pw / 4
  const hingeL = new THREE.Group()
  hingeL.position.x = -pw / 2
  hingeL.add(left)
  const hingeR = new THREE.Group()
  hingeR.position.x = pw / 2
  hingeR.add(right)
  const next = plane(pw, ph, mb)
  scene.add(next, hingeL, hingeR)
  return {
    scene,
    a: [ma],
    b: [mb],
    update(p) {
      const e = easeInOutCubic(p)
      hingeL.rotation.y = -e * 1.95
      hingeR.rotation.y = e * 1.95
      next.position.z = -(1 - e) * ph * 0.6
      mb.opacity = smooth(0, 0.35, p)
    },
  }
}

function buildSwing(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial()
  // Drawn over the outgoing shot even when the swing overshoots past vertical.
  const mb = basicMaterial({ side: THREE.DoubleSide, depthTest: false })
  const base = plane(pw, ph, ma)
  const flap = plane(pw, ph, mb)
  flap.renderOrder = 1
  flap.position.y = -ph / 2
  const hinge = new THREE.Group()
  hinge.position.set(0, ph / 2, 2)
  hinge.add(flap)
  scene.add(base, hinge)
  return {
    scene,
    a: [ma],
    b: [mb],
    update(p) {
      hinge.rotation.x = -(1 - easeOutBack(clamp(p, 0, 1))) * 1.45
      mb.opacity = smooth(0, 0.25, p)
      const dim = 1 - 0.45 * easeOutCubic(p)
      ma.color.setRGB(dim, dim, dim)
    },
  }
}

function buildPage(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const geometry = new THREE.PlaneGeometry(pw, ph, 160, 1)
  const pos = geometry.attributes.position as THREE.BufferAttribute
  const x0 = Float32Array.from({ length: pos.count }, (_, i) => pos.getX(i))
  // Front and back share the bending positions but get their own shading.
  const frontShade = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3)
  const backShade = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3)
  geometry.setAttribute('color', frontShade)
  const backGeometry = new THREE.BufferGeometry()
  backGeometry.setIndex(geometry.index)
  backGeometry.setAttribute('position', pos)
  backGeometry.setAttribute('uv', geometry.attributes.uv)
  backGeometry.setAttribute('color', backShade)

  const ma = basicMaterial({ side: THREE.FrontSide, vertexColors: true })
  // The back of the sheet: the print showing through paper — mirrored, washed out.
  const paper = basicMaterial({ side: THREE.BackSide, vertexColors: true })
  paper.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.95, 0.93), 0.55);',
    )
  }
  const mb = basicMaterial()
  const front = new THREE.Mesh(geometry, ma)
  const back = new THREE.Mesh(backGeometry, paper)
  front.renderOrder = back.renderOrder = 2
  const next = plane(pw, ph, mb)
  next.position.z = -1

  // Soft shadow the curl casts on the page underneath.
  const shade = document.createElement('canvas')
  shade.width = 256
  shade.height = 4
  const sctx = shade.getContext('2d')!
  const g = sctx.createLinearGradient(0, 0, 256, 0)
  g.addColorStop(0, 'rgba(0,0,0,0.7)')
  g.addColorStop(0.3, 'rgba(0,0,0,0.62)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  sctx.fillStyle = g
  sctx.fillRect(0, 0, 256, 4)
  const shadowMat = basicMaterial({ map: new THREE.CanvasTexture(shade), depthWrite: false })
  const R = pw * 0.085
  // Falls on the incoming shot, just right of the curl's silhouette (cx + R).
  const shadow = plane(R * 3.2, ph, shadowMat)
  shadow.position.z = -0.5
  shadow.renderOrder = 1
  scene.add(next, shadow, front, back)

  return {
    scene,
    a: [ma, paper],
    b: [mb],
    update(p) {
      const e = easeInOutCubic(p)
      // Ends once the curl itself has cleared the left edge.
      const cx = lerp(pw / 2 + 1, -pw / 2 - R * 1.2, e)
      for (let i = 0; i < pos.count; i++) {
        const d = x0[i] - cx
        let x = x0[i]
        let z = 0
        // Lit from the viewer: brightness follows how squarely each side faces the camera.
        let f = 1
        let b = 1
        if (d > 0 && d <= Math.PI * R) {
          const th = d / R
          x = cx + R * Math.sin(th)
          z = R * (1 - Math.cos(th))
          f = 0.2 + 0.8 * Math.max(0, Math.cos(th)) ** 0.7
          // Bright on the crest facing us, falling off to the silhouette.
          b = 0.3 + 0.7 * Math.max(0, -Math.cos(th)) ** 1.2 + 0.3 * Math.exp(-(((th / Math.PI - 0.92) / 0.035) ** 2))
        } else if (d > Math.PI * R) {
          x = cx - (d - Math.PI * R)
          z = 2 * R
          // The flipped-over flap catches the light at the fold and falls off away from it.
          b = 0.78 + 0.22 * Math.exp(-(d - Math.PI * R) / (R * 1.6))
        } else {
          // Ambient occlusion under the lifting edge.
          f = 1 - 0.28 * Math.exp(d / (R * 0.8))
        }
        pos.setX(i, x)
        pos.setZ(i, z + 0.5)
        frontShade.setXYZ(i, f, f, f)
        backShade.setXYZ(i, b, b, b * 0.98)
      }
      pos.needsUpdate = true
      frontShade.needsUpdate = true
      backShade.needsUpdate = true
      geometry.computeBoundingSphere()
      backGeometry.boundingSphere = geometry.boundingSphere
      shadow.position.x = cx + R * 0.9 + R * 1.6
      shadowMat.opacity = Math.min(1, Math.sin(Math.PI * p) * 2.2)
    },
  }
}

function buildWarp(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial({ depthWrite: false })
  const mb = basicMaterial({ depthWrite: false })
  const a = plane(pw, ph, ma)
  const b = plane(pw, ph, mb)
  b.renderOrder = 0
  a.renderOrder = 2
  // Faint copies trailing each shot read as zoom blur.
  const trailA = Array.from({ length: 4 }, () => plane(pw, ph, basicMaterial({ depthWrite: false, blending: THREE.AdditiveBlending })))
  const trailB = Array.from({ length: 4 }, () => plane(pw, ph, basicMaterial({ depthWrite: false, blending: THREE.AdditiveBlending })))
  for (const m of trailA) m.renderOrder = 1
  for (const m of trailB) m.renderOrder = 1
  scene.add(b, a, ...trailA, ...trailB)
  const mats = (ms: THREE.Mesh[]) => ms.map((m) => m.material as THREE.MeshBasicMaterial)
  return {
    scene,
    a: [ma, ...mats(trailA)],
    b: [mb, ...mats(trailB)],
    update(p, stage) {
      const e = easeInOutCubic(p)
      const speed = Math.sin(Math.PI * p) ** 2
      a.position.z = e * stage.distance * 0.92
      a.rotation.z = e * 0.4
      ma.opacity = 1 - smooth(0.4, 0.72, p)
      b.position.z = -(1 - e) * stage.distance * 1.6
      b.rotation.z = -(1 - e) * 0.4
      mb.opacity = smooth(0.3, 0.66, p)
      trailA.forEach((m, i) => {
        m.position.z = a.position.z - (i + 1) * stage.distance * 0.05 * speed
        m.rotation.z = a.rotation.z - (i + 1) * 0.02 * speed
        ;(m.material as THREE.MeshBasicMaterial).opacity = ma.opacity * speed * 0.22 * (1 - i / 4)
      })
      trailB.forEach((m, i) => {
        m.position.z = b.position.z + (i + 1) * stage.distance * 0.05 * speed
        m.rotation.z = b.rotation.z + (i + 1) * 0.02 * speed
        ;(m.material as THREE.MeshBasicMaterial).opacity = mb.opacity * speed * 0.22 * (1 - i / 4)
      })
    },
  }
}

function buildShatter(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial({ side: THREE.DoubleSide })
  const mb = basicMaterial()
  const next = plane(pw, ph, mb)
  next.position.z = -2
  scene.add(next)
  const cols = 16
  const rows = 9
  const tw = pw / cols
  const th = ph / rows
  const rnd = mulberry32(7)
  const tiles: { mesh: THREE.Mesh; base: THREE.Vector3; vel: THREE.Vector3; axis: THREE.Vector3; spin: number; delay: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const geo = cropUV(new THREE.PlaneGeometry(tw, th), c / cols, 1 - (r + 1) / rows, (c + 1) / cols, 1 - r / rows)
      const mesh = new THREE.Mesh(geo, ma)
      const base = new THREE.Vector3(-pw / 2 + tw * (c + 0.5), ph / 2 - th * (r + 0.5), 0)
      mesh.position.copy(base)
      const dir = new THREE.Vector3(base.x / pw, base.y / ph, 0.9 + rnd() * 0.8).normalize()
      const dist = Math.hypot(base.x / pw, base.y / ph)
      tiles.push({
        mesh,
        base,
        vel: dir.multiplyScalar(pw * (0.9 + rnd() * 0.9)),
        axis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
        spin: 2 + rnd() * 5,
        delay: dist * 0.35 + rnd() * 0.12,
      })
      scene.add(mesh)
    }
  }
  return {
    scene,
    a: [ma],
    b: [mb],
    update(p) {
      for (const t of tiles) {
        const q = clamp((p - t.delay) / 0.6, 0, 1)
        const q2 = q * q
        t.mesh.position.set(t.base.x + t.vel.x * q2, t.base.y + t.vel.y * q2 - ph * 0.4 * q2 * q, t.base.z + t.vel.z * q2)
        t.mesh.setRotationFromAxisAngle(t.axis, t.spin * q)
        t.mesh.scale.setScalar(1 - q * 0.5)
      }
      ma.opacity = 1 - smooth(0.7, 1, p)
      next.scale.setScalar(1.08 - 0.08 * easeOutCubic(p))
    },
  }
}

function buildSpin(pw: number, ph: number): TransitionScene {
  const scene = new THREE.Scene()
  const ma = basicMaterial({ side: THREE.DoubleSide, depthWrite: false })
  const mb = basicMaterial({ side: THREE.DoubleSide, depthWrite: false })
  const a = plane(pw, ph, ma)
  const b = plane(pw, ph, mb)
  scene.add(a, b)
  return {
    scene,
    a: [ma],
    b: [mb],
    update(p) {
      const e = easeInOutCubic(p)
      a.rotation.set(0, -e * 1.7, e * 0.35)
      a.position.set(-e * pw * 0.12, 0, -e * ph * 0.9)
      ma.opacity = 1 - smooth(0.35, 0.72, p)
      b.rotation.set(0, (1 - e) * 1.7, -(1 - e) * 0.35)
      b.position.set((1 - e) * pw * 0.12, 0, -(1 - e) * ph * 0.9)
      mb.opacity = smooth(0.28, 0.65, p)
      a.renderOrder = p < 0.5 ? 1 : 0
      b.renderOrder = p < 0.5 ? 0 : 1
    },
  }
}

const BUILDERS: Partial<Record<TransitionKind, (pw: number, ph: number) => TransitionScene>> = {
  cube: buildCube,
  flip: buildFlip,
  door: buildDoor,
  swing: buildSwing,
  page: buildPage,
  warp: buildWarp,
  shatter: buildShatter,
  spin: buildSpin,
}

const scenes = new Map<string, TransitionScene>()

/**
 * Renders a 3D transition frame on `stage` (which must already be sized) and
 * returns its canvas. `from`/`to` are full-frame canvases of each shot.
 */
export function renderTransition3D(stage: Stage, kind: TransitionKind, p: number, from: HTMLCanvasElement, to: HTMLCanvasElement) {
  const build = BUILDERS[kind]
  if (!build) return null
  const key = `${kind}:${stage.pw}x${stage.ph}`
  let ts = scenes.get(key)
  if (!ts) scenes.set(key, (ts = build(stage.pw, stage.ph)))
  const ta = canvasTexture(from, stage.renderer)
  const tb = canvasTexture(to, stage.renderer)
  for (const m of ts.a) m.map = ta
  for (const m of ts.b) m.map = tb
  frameStage(stage, stage.canvas.width, stage.canvas.height, stage.pw, stage.ph)
  ts.update(clamp(p, 0, 1), stage)
  return renderStage(stage, ts.scene)
}
