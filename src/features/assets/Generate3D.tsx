import { Box, Code, LoaderCircle, Mountain, Type } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { RenderQuality } from '@shared/integrations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { FONTS } from '@/editor/defaults'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { ColorSwatches } from '@/features/inspector/controls'
import { IconTile, RenderCard } from '@/features/integrations/parts'
import { openIntegrations, renderBlender, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { Chip, SectionLabel } from './shared'

type Template = 'title3d' | 'shapes' | 'script'

const MATERIALS: { id: string; label: string; swatch: string; tinted?: boolean }[] = [
  { id: 'chrome', label: 'Chrome', swatch: 'linear-gradient(165deg,#ffffff 0%,#b8c0d0 42%,#262a35 50%,#5b6172 62%,#eef2fb 100%)' },
  { id: 'gold', label: 'Gold', swatch: 'linear-gradient(165deg,#fff6d2 0%,#f4c865 42%,#6a4510 50%,#a06d24 62%,#ffeab0 100%)' },
  { id: 'glass', label: 'Glass', swatch: 'linear-gradient(165deg,rgb(255 255 255/0.75),rgb(170 200 255/0.18) 55%,rgb(255 255 255/0.4))' },
  { id: 'plastic', label: 'Plastic', swatch: 'radial-gradient(circle at 32% 28%,#fff 0 8%,var(--c) 30%,color-mix(in oklab,var(--c) 55%,black) 100%)', tinted: true },
  { id: 'neon', label: 'Neon', swatch: 'radial-gradient(circle,#fff 0 18%,var(--c) 45%,transparent 72%)', tinted: true },
  { id: 'clay', label: 'Clay', swatch: 'radial-gradient(circle at 35% 30%,color-mix(in oklab,var(--c) 70%,white),var(--c) 55%,color-mix(in oklab,var(--c) 70%,black))', tinted: true },
]

const FONT_CHOICES: { id: string; label: string; css: string; italic?: boolean }[] = [
  { id: 'sans', label: 'Sans', css: FONTS.sans.css },
  { id: 'display', label: 'Display', css: FONTS.display.css },
  { id: 'serif', label: 'Serif', css: FONTS.serif.css },
  { id: 'serif-italic', label: 'Italic', css: FONTS.serif.css, italic: true },
]

const MOTIONS = [
  { id: 'spin', label: 'Spin in' },
  { id: 'rise', label: 'Rise' },
  { id: 'slam', label: 'Slam' },
  { id: 'orbit', label: 'Orbit' },
  { id: 'float', label: 'Float' },
]

const PALETTES: { id: string; colors: string[] }[] = [
  { id: 'aurora', colors: ['#7cf7ff', '#8b5cf6', '#22d3ee', '#34d399'] },
  { id: 'sunset', colors: ['#fb923c', '#f472b6', '#facc15', '#ef4444'] },
  { id: 'candy', colors: ['#f9a8d4', '#a78bfa', '#93c5fd', '#fde68a'] },
  { id: 'ocean', colors: ['#38bdf8', '#0ea5e9', '#1d4ed8', '#a5f3fc'] },
  { id: 'mono', colors: ['#f4f4f5', '#a1a1aa', '#52525b', '#27272a'] },
]

const SAMPLE_SCRIPT = `# A glossy torus knot, slowly turning.
bpy.ops.mesh.primitive_torus_add(major_radius=1.2, minor_radius=0.35)
knot = bpy.context.active_object
knot.data.materials.append(material_preset("chrome"))
bpy.ops.object.shade_smooth()
add_camera(location=(0, -6, 1.2), target=(0, 0, 0))

def animate(t, frame):
    knot.rotation_euler = (t * 0.8, t * 0.5, 0)
`

function Field({ label, children, trailing }: { label: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">{label}</span>
        {trailing}
      </div>
      {children}
    </div>
  )
}

export function Generate3D() {
  const available = useIntegrations((s) => s.available)
  const blender = useIntegrations((s) => s.blender)
  const jobs = useIntegrations((s) => s.jobs)
  const settings = useEditor((s) => s.project.settings)
  const [template, setTemplate] = useState<Template>('title3d')
  const [text, setText] = useState('Your title')
  const [material, setMaterial] = useState('chrome')
  const [color, setColor] = useState('#d6ee00')
  const [font, setFont] = useState('sans')
  const [motion, setMotion] = useState('spin')
  const [depth, setDepth] = useState(35)
  const [duration, setDuration] = useState(4)
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [palette, setPalette] = useState('aurora')
  const [style, setStyle] = useState('mix')
  const [script, setScript] = useState(SAMPLE_SCRIPT)
  const [transparent, setTransparent] = useState(true)
  const [busy, setBusy] = useState(false)

  const list = Object.values(jobs)
    .filter((j) => j.integration === 'blender')
    .sort((a, b) => b.startedAt - a.startedAt)

  if (!available) return <Unavailable />
  if (!blender)
    return (
      <div className="grid flex-1 place-items-center text-fg-4">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    )
  if (!blender.found) return <NoBlender />

  const tinted = MATERIALS.find((m) => m.id === material)?.tinted
  const secs = template === 'shapes' ? Math.max(duration, 6) : duration
  const frames = Math.round(secs * settings.fps)

  const render = async () => {
    setBusy(true)
    try {
      if (template === 'title3d')
        await renderBlender({ template, params: { text, material, color, font, motion, depth: depth / 100 }, duration: secs, quality, prompt: text })
      else if (template === 'shapes') await renderBlender({ template, params: { palette, style }, duration: secs, quality, transparent: false })
      else await renderBlender({ template, params: {}, script, name: 'Blender scene', duration: secs, quality, transparent })
    } catch (err) {
      toast.error('Couldn’t start the render', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-4 px-3.5 pb-3">
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ['title3d', '3D title', <Type key="t" />],
              ['shapes', 'Background', <Mountain key="m" />],
              ['script', 'Script', <Code key="c" />],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTemplate(id)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-[10px] py-2 text-2xs font-medium outline-none transition-colors [&_svg]:size-4',
                template === id ? 'bg-white/[0.08] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]' : 'text-fg-3 hover:bg-white/[0.04] hover:text-fg-2',
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        {template === 'title3d' && (
          <>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Title text" className="h-10 text-md font-semibold" style={{ fontFamily: FONT_CHOICES.find((f) => f.id === font)?.css, fontStyle: font === 'serif-italic' ? 'italic' : undefined }} />
            <Field label="Material">
              <div className="grid grid-cols-6 gap-1">
                {MATERIALS.map((m) => (
                  <button key={m.id} type="button" onClick={() => setMaterial(m.id)} className="group/mat flex flex-col items-center gap-1 outline-none">
                    <span
                      className={cn(
                        'size-8 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),0_4px_10px_-4px_rgb(0_0_0/0.8)] transition-transform group-hover/mat:scale-105',
                        material === m.id && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                      )}
                      style={{ background: m.swatch, ['--c' as string]: color }}
                    />
                    <span className={cn('text-[10px]', material === m.id ? 'text-fg' : 'text-fg-4')}>{m.label}</span>
                  </button>
                ))}
              </div>
            </Field>
            {tinted && (
              <Field label="Colour">
                <ColorSwatches value={color} onChange={(c) => c && setColor(c)} />
              </Field>
            )}
            <Field label="Typeface">
              <div className="grid grid-cols-4 gap-1">
                {FONT_CHOICES.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFont(f.id)}
                    className={cn('h-9 rounded-lg text-md outline-none transition-colors', font === f.id ? 'bg-white/[0.1] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]' : 'text-fg-3 hover:bg-white/[0.04]')}
                    style={{ fontFamily: f.css, fontStyle: f.italic ? 'italic' : undefined, fontWeight: f.id.startsWith('serif') ? 400 : 700 }}
                  >
                    Aa
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Move">
              <div className="flex flex-wrap gap-1">
                {MOTIONS.map((m) => (
                  <Chip key={m.id} active={motion === m.id} onClick={() => setMotion(m.id)}>
                    {m.label}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field label="Depth" trailing={<span className="font-mono text-2xs text-fg-3 tabular">{depth}%</span>}>
              <Slider value={depth} min={5} max={100} onChange={setDepth} defaultValue={35} aria-label="Depth" />
            </Field>
          </>
        )}

        {template === 'shapes' && (
          <>
            <Field label="Palette">
              <div className="grid grid-cols-5 gap-1.5">
                {PALETTES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPalette(p.id)}
                    className={cn('flex flex-col items-center gap-1 rounded-lg p-1.5 outline-none transition-colors', palette === p.id ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]')}
                  >
                    <span className="grid size-8 grid-cols-2 overflow-hidden rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
                      {p.colors.map((c) => (
                        <span key={c} style={{ background: c }} />
                      ))}
                    </span>
                    <span className={cn('text-[10px] capitalize', palette === p.id ? 'text-fg' : 'text-fg-4')}>{p.id}</span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Forms">
              <div className="flex flex-wrap gap-1">
                {['mix', 'blobs', 'rings', 'cubes'].map((s) => (
                  <Chip key={s} active={style === s} onClick={() => setStyle(s)}>
                    <span className="capitalize">{s}</span>
                  </Chip>
                ))}
              </div>
            </Field>
          </>
        )}

        {template === 'script' && (
          <>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={9}
              spellCheck={false}
              className="w-full resize-y rounded-control bg-black/35 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none focus:shadow-[inset_0_0_0_1px_rgb(214_238_0/0.6)]"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-2">Transparent background</span>
              <Switch aria-label="Transparent background" checked={transparent} onChange={setTransparent} />
            </div>
            <p className="text-2xs leading-relaxed text-fg-4">Blender Python, run on an empty scene. Define animate(t, frame) to move things. AI agents can write these for you through Lumen’s MCP server.</p>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Length">
            <div className="flex gap-1">
              {(template === 'shapes' ? [6, 8, 12] : [3, 4, 6]).map((d) => (
                <Chip key={d} active={secs === d} onClick={() => setDuration(d)}>
                  {d}s
                </Chip>
              ))}
            </div>
          </Field>
          <Field label="Quality">
            <Segmented
              stretch
              value={quality}
              onChange={setQuality}
              options={[
                { value: 'draft', label: 'Draft' },
                { value: 'standard', label: 'Std' },
                { value: 'high', label: 'High' },
              ]}
            />
          </Field>
        </div>

        <Button variant="ai" size="lg" className="w-full" disabled={busy || (template === 'title3d' && !text.trim()) || (template === 'script' && !script.trim())} onClick={render}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Box />}
          Render in Blender
        </Button>
        <p className="-mt-2 text-center text-2xs text-fg-4">
          {settings.width}×{settings.height} · {frames} frames · Blender {blender.version}
        </p>
      </div>

      <div className="px-3.5 pb-4">
        <SectionLabel>Renders</SectionLabel>
        {!list.length && <p className="rounded-xl border border-dashed border-line-2 px-4 py-6 text-center text-xs leading-relaxed text-fg-4">Renders run in the background — keep editing. Finished clips land in your media with transparency.</p>}
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {list.map((job) => (
              <RenderCard key={job.id} job={job} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function NoBlender() {
  return (
    <div className="px-3.5">
      <div className="rounded-xl bg-white/[0.03] p-4 text-center shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        <div className="mx-auto mb-3 w-fit">
          <IconTile tone="blender">
            <Box />
          </IconTile>
        </div>
        <p className="text-sm font-medium text-fg">Blender isn’t connected</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-3">Install Blender (free) or point Lumen at it to render real 3D titles and backgrounds.</p>
        <Button size="sm" variant="primary" className="mt-3" onClick={() => openIntegrations('blender')}>
          Set up Blender
        </Button>
        <button type="button" onClick={() => useUI.getState().setLeftTab('text')} className="mt-3 block w-full text-2xs text-fg-4 hover:text-fg-2">
          Or use Lumen’s built-in 3D titles →
        </button>
      </div>
    </div>
  )
}

export function Unavailable() {
  return (
    <div className="px-3.5">
      <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center">
        <p className="text-sm font-medium text-fg-2">Available in the desktop app</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-4">Blender and HyperFrames renders run locally, so they need Lumen’s desktop app.</p>
      </div>
    </div>
  )
}
