import { Clapperboard, LoaderCircle } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { MotionTemplate } from '@shared/integrations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEditor } from '@/editor/store'
import { ColorSwatches } from '@/features/inspector/controls'
import { RenderCard } from '@/features/integrations/parts'
import { renderMotion, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { Unavailable } from './Generate3D'
import { Chip, SectionLabel } from './shared'

type Template = Exclude<MotionTemplate, 'custom'>

/** Tiny static mock-ups of each template, so the picker reads at a glance. */
const PREVIEWS: Record<Template, ReactNode> = {
  'lower-third': (
    <div className="absolute bottom-[18%] left-[9%] flex items-stretch gap-[3px]">
      <span className="w-[3px] rounded-full bg-[linear-gradient(#d6ee00,#5ef2a6)]" />
      <span className="rounded-[4px] bg-black/60 px-1.5 py-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
        <span className="block h-[5px] w-10 rounded-full bg-white" />
        <span className="mt-[3px] block h-[3px] w-7 rounded-full bg-white/50" />
      </span>
    </div>
  ),
  'title-card': (
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      <span className="text-[19px] leading-none font-extrabold tracking-tight text-white" style={{ fontFamily: '"Bricolage Grotesque Variable"' }}>
        Title<span className="text-ai-2">.</span>
      </span>
      <span className="mt-1.5 h-px w-12 bg-[linear-gradient(90deg,transparent,#d6ee00,transparent)]" />
    </div>
  ),
  kinetic: (
    <div className="absolute inset-0 grid place-items-center">
      <span className="text-[22px] leading-none font-black tracking-tighter text-[#facc15] uppercase" style={{ fontFamily: '"Bricolage Grotesque Variable"' }}>
        Bold
      </span>
    </div>
  ),
  counter: (
    <div className="absolute inset-0 grid place-items-center">
      <svg viewBox="0 0 40 40" className="size-10 -rotate-90">
        <circle r="16" cx="20" cy="20" fill="none" stroke="rgb(255 255 255 / 0.12)" strokeWidth="3" />
        <circle r="16" cx="20" cy="20" fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeDasharray="100.5" strokeDashoffset="18" />
      </svg>
      <span className="absolute text-[10px] font-bold text-white">87%</span>
    </div>
  ),
}

const TEMPLATES: { id: Template; label: string }[] = [
  { id: 'lower-third', label: 'Lower third' },
  { id: 'title-card', label: 'Title card' },
  { id: 'kinetic', label: 'Kinetic type' },
  { id: 'counter', label: 'Counter' },
]

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">{label}</span>
      {children}
    </label>
  )
}

export function GenerateMotion() {
  const available = useIntegrations((s) => s.available)
  const jobs = useIntegrations((s) => s.jobs)
  const settings = useEditor((s) => s.project.settings)
  const [template, setTemplate] = useState<Template>('lower-third')
  const [values, setValues] = useState<Record<Template, Record<string, unknown>>>({
    'lower-third': { name: 'Your Name', title: 'Your role', accent: '#d6ee00' },
    'title-card': { title: 'Your Title', subtitle: '', eyebrow: '', accent: '#d6ee00', font: 'display' },
    kinetic: { text: 'Say it *loud*', style: 'punch', accent: '#facc15' },
    counter: { value: 100, suffix: '%', label: '', accent: '#34d399' },
  })
  const [busy, setBusy] = useState(false)
  const v = values[template]
  const set = (key: string, value: unknown) => setValues((s) => ({ ...s, [template]: { ...s[template], [key]: value } }))
  const list = Object.values(jobs)
    .filter((j) => j.integration === 'hyperframes')
    .sort((a, b) => b.startedAt - a.startedAt)

  if (!available) return <Unavailable />

  const render = async () => {
    setBusy(true)
    try {
      const name = template === 'lower-third' ? `Lower third — ${v.name}` : template === 'title-card' ? `Title — ${v.title}` : template === 'kinetic' ? `Kinetic — ${String(v.text).replace(/\*/g, '')}` : `Counter — ${v.value}${v.suffix ?? ''}`
      await renderMotion({ template, params: v, name: name.slice(0, 60), prompt: JSON.stringify(v) })
    } catch (err) {
      toast.error('Couldn’t start the render', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const text = (key: string, placeholder?: string) => <Input value={String(v[key] ?? '')} onChange={(e) => set(key, e.target.value)} placeholder={placeholder} />

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-4 px-3.5 pb-3">
        <div className="grid grid-cols-2 gap-2">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" onClick={() => setTemplate(t.id)} className="group/tpl text-left outline-none">
              <div
                className={cn(
                  'relative aspect-[16/9] overflow-hidden rounded-[10px] bg-[radial-gradient(120%_100%_at_30%_0%,#22261a,#0f100d)] transition-shadow',
                  template === t.id ? 'shadow-[0_0_0_2px_var(--color-accent)]' : 'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] group-hover/tpl:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)]',
                )}
              >
                {PREVIEWS[t.id]}
              </div>
              <div className={cn('mt-1 px-0.5 text-xs', template === t.id ? 'font-medium text-fg' : 'text-fg-3')}>{t.label}</div>
            </button>
          ))}
        </div>

        {template === 'lower-third' && (
          <>
            <Labeled label="Name">{text('name', 'Name')}</Labeled>
            <Labeled label="Title">{text('title', 'Role or title')}</Labeled>
            <div className="flex gap-1">
              {(['left', 'right'] as const).map((a) => (
                <Chip key={a} active={(v.align ?? 'left') === a} onClick={() => set('align', a)}>
                  <span className="capitalize">{a}</span>
                </Chip>
              ))}
            </div>
          </>
        )}
        {template === 'title-card' && (
          <>
            <Labeled label="Title">{text('title', 'Title')}</Labeled>
            <Labeled label="Subtitle">{text('subtitle', 'Optional')}</Labeled>
            <Labeled label="Eyebrow">{text('eyebrow', 'Optional small line above')}</Labeled>
            <div className="flex gap-1">
              {(['display', 'sans', 'serif'] as const).map((f) => (
                <Chip key={f} active={v.font === f} onClick={() => set('font', f)}>
                  <span className="capitalize">{f}</span>
                </Chip>
              ))}
            </div>
          </>
        )}
        {template === 'kinetic' && (
          <>
            <Labeled label="Words">{text('text', 'Words, *emphasis* in stars')}</Labeled>
            <p className="-mt-2 text-2xs text-fg-4">Wrap a word in *stars* to highlight it.</p>
            <div className="flex gap-1">
              {(['punch', 'stack'] as const).map((s) => (
                <Chip key={s} active={v.style === s} onClick={() => set('style', s)}>
                  <span className="capitalize">{s}</span>
                </Chip>
              ))}
            </div>
          </>
        )}
        {template === 'counter' && (
          <>
            <div className="grid grid-cols-[1fr_64px_64px] gap-2">
              <Labeled label="Value">
                <Input type="number" value={String(v.value ?? '')} onChange={(e) => set('value', Number(e.target.value))} />
              </Labeled>
              <Labeled label="Prefix">{text('prefix', '$')}</Labeled>
              <Labeled label="Suffix">{text('suffix', '%')}</Labeled>
            </div>
            <Labeled label="Label">{text('label', 'What the number means')}</Labeled>
          </>
        )}
        <div>
          <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">Accent</span>
          <ColorSwatches value={String(v.accent ?? '#d6ee00')} onChange={(c) => c && set('accent', c)} />
        </div>

        <Button variant="ai" size="lg" className="w-full" disabled={busy} onClick={render}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Clapperboard />}
          Render motion graphic
        </Button>
        <p className="-mt-2 text-center text-2xs text-fg-4">
          HyperFrames · {settings.width}×{settings.height} · transparent
        </p>
      </div>

      <div className="px-3.5 pb-4">
        <SectionLabel>Renders</SectionLabel>
        {!list.length && <p className="rounded-xl border border-dashed border-line-2 px-4 py-6 text-center text-xs leading-relaxed text-fg-4">Motion graphics render in a few seconds and drop into your media, ready to layer over footage.</p>}
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
