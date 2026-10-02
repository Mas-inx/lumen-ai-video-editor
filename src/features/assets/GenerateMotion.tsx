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

const serif = { fontFamily: '"Fraunces Variable", Georgia, serif' }
const art = { fontFamily: '"Syne Variable", sans-serif' }
const tech = { fontFamily: '"Space Grotesk Variable", sans-serif' }

/** Tiny static mock-ups of each template, so the picker reads at a glance. */
const PREVIEWS: Record<Template, ReactNode> = {
  'lower-third': (
    <div className="absolute bottom-[16%] left-[9%] text-white">
      <span className="block text-[13px] leading-none" style={serif}>
        Ada Lovelace
      </span>
      <span className="my-[4px] block h-px w-5 bg-accent" />
      <span className="block text-[5px] font-semibold tracking-[0.22em] text-white/70 uppercase">Mathematician</span>
    </div>
  ),
  'title-card': (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
      <span className="text-[17px] leading-none font-light" style={serif}>
        The <em className="text-accent">quiet</em> hour
      </span>
      <span className="mt-1.5 h-px w-4 bg-accent" />
    </div>
  ),
  kinetic: (
    <div className="absolute inset-0 grid place-items-center">
      <span className="text-[21px] leading-none font-extrabold tracking-tighter text-accent uppercase" style={{ fontFamily: '"Archivo Variable"', fontStretch: '125%' }}>
        Loud
      </span>
    </div>
  ),
  counter: (
    <div className="absolute inset-0 grid place-items-center">
      <svg viewBox="0 0 40 40" className="size-10 -rotate-90">
        <circle r="16" cx="20" cy="20" fill="none" stroke="rgb(255 255 255 / 0.16)" strokeWidth="0.75" />
        <circle r="16" cx="20" cy="20" fill="none" stroke="#d6ee00" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="100.5" strokeDashoffset="18" />
      </svg>
      <span className="absolute text-[10px] font-semibold text-white tabular" style={tech}>
        87%
      </span>
    </div>
  ),
  quote: (
    <div className="absolute inset-0 flex flex-col justify-center px-[14%] text-white">
      <span className="text-[16px] leading-[0.6] text-accent" style={serif}>
        “
      </span>
      <span className="text-[8px] leading-tight" style={serif}>
        Simplicity is the ultimate sophistication.
      </span>
    </div>
  ),
  chapter: (
    <div className="absolute bottom-[16%] left-[9%] text-white">
      <span className="block font-mono text-[5px] tracking-[0.2em] text-accent">02</span>
      <span className="my-[3px] block h-px w-8 bg-white/80" />
      <span className="block text-[11px] leading-none font-semibold tracking-tight" style={art}>
        The Build
      </span>
    </div>
  ),
}

const TEMPLATES: { id: Template; label: string }[] = [
  { id: 'lower-third', label: 'Lower third' },
  { id: 'title-card', label: 'Title card' },
  { id: 'kinetic', label: 'Kinetic type' },
  { id: 'counter', label: 'Counter' },
  { id: 'quote', label: 'Pull quote' },
  { id: 'chapter', label: 'Chapter' },
]

const STYLES: Partial<Record<Template, string[]>> = {
  'lower-third': ['editorial', 'block', 'minimal'],
  'title-card': ['editorial', 'poster'],
  kinetic: ['punch', 'stack', 'stretch'],
}

const FONTS: { id: string; label: string; css: string }[] = [
  { id: 'editorial', label: 'Fraunces', css: '"Fraunces Variable", serif' },
  { id: 'serif', label: 'Instrument', css: '"Instrument Serif", serif' },
  { id: 'display', label: 'Bricolage', css: '"Bricolage Grotesque Variable", sans-serif' },
  { id: 'art', label: 'Syne', css: '"Syne Variable", sans-serif' },
  { id: 'wide', label: 'Archivo', css: '"Archivo Variable", sans-serif' },
  { id: 'tech', label: 'Space Grotesk', css: '"Space Grotesk Variable", sans-serif' },
  { id: 'sans', label: 'Geist', css: '"Geist Variable", sans-serif' },
]

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">{label}</span>
      {children}
    </label>
  )
}

function nameFor(template: Template, v: Record<string, unknown>) {
  const plain = (s: unknown) => String(s ?? '').replace(/[*|]/g, ' ').replace(/\s+/g, ' ').trim()
  switch (template) {
    case 'lower-third':
      return `Lower third — ${plain(v.name)}`
    case 'title-card':
      return `Title — ${plain(v.title)}`
    case 'kinetic':
      return `Kinetic — ${plain(v.text)}`
    case 'counter':
      return `Counter — ${v.value}${v.suffix ?? ''}`
    case 'quote':
      return `Quote — ${plain(v.text)}`
    case 'chapter':
      return `Chapter ${plain(v.number)} — ${plain(v.title)}`
  }
}

export function GenerateMotion() {
  const available = useIntegrations((s) => s.available)
  const jobs = useIntegrations((s) => s.jobs)
  const settings = useEditor((s) => s.project.settings)
  const [template, setTemplate] = useState<Template>('lower-third')
  const [values, setValues] = useState<Record<Template, Record<string, unknown>>>({
    'lower-third': { name: 'Your Name', title: 'Your role', accent: '#d6ee00', style: 'editorial' },
    'title-card': { title: 'Your *title*', subtitle: '', eyebrow: '', accent: '#d6ee00', style: 'editorial', font: 'editorial' },
    kinetic: { text: 'Say it *loud*', style: 'punch', accent: '#d6ee00' },
    counter: { value: 100, suffix: '%', label: '', accent: '#d6ee00' },
    quote: { text: 'Simplicity is the ultimate sophistication.', author: '', accent: '#d6ee00', font: 'editorial' },
    chapter: { number: '01', title: 'Chapter title', accent: '#d6ee00', font: 'display' },
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
      await renderMotion({ template, params: v, name: nameFor(template, v).slice(0, 60), prompt: JSON.stringify(v) })
    } catch (err) {
      toast.error('Couldn’t start the render', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const text = (key: string, placeholder?: string) => <Input value={String(v[key] ?? '')} onChange={(e) => set(key, e.target.value)} placeholder={placeholder} />
  const styles = STYLES[template]
  const usesBpm = template === 'kinetic' || (template === 'title-card' && v.style === 'poster')

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
            <Labeled label="Title">{text('title', 'Title — | breaks a line, *word* for emphasis')}</Labeled>
            <Labeled label="Subtitle">{text('subtitle', 'Optional')}</Labeled>
            <Labeled label="Eyebrow">{text('eyebrow', 'Optional small line above')}</Labeled>
          </>
        )}
        {template === 'kinetic' && (
          <>
            <Labeled label="Words">{text('text', 'Words, *emphasis* in stars')}</Labeled>
            <p className="-mt-2 text-2xs text-fg-4">Wrap a word in *stars* to highlight it.</p>
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
        {template === 'quote' && (
          <>
            <Labeled label="Quote">{text('text', 'The words')}</Labeled>
            <Labeled label="Who said it">{text('author', 'Optional')}</Labeled>
          </>
        )}
        {template === 'chapter' && (
          <div className="grid grid-cols-[64px_1fr] gap-2">
            <Labeled label="No.">{text('number', '01')}</Labeled>
            <Labeled label="Title">{text('title', 'Chapter title')}</Labeled>
          </div>
        )}

        {styles && (
          <div>
            <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">Style</span>
            <div className="flex flex-wrap gap-1">
              {styles.map((s) => (
                <Chip key={s} active={(v.style ?? styles[0]) === s} onClick={() => set('style', s)}>
                  <span className="capitalize">{s}</span>
                </Chip>
              ))}
            </div>
          </div>
        )}
        {template !== 'kinetic' || v.style !== 'stretch' ? (
          <div>
            <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">Typeface</span>
            <div className="flex flex-wrap gap-1">
              {FONTS.map((f) => (
                <Chip key={f.id} active={v.font === f.id} onClick={() => set('font', v.font === f.id ? undefined : f.id)}>
                  <span style={{ fontFamily: f.css }}>{f.label}</span>
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {usesBpm && (
          <Labeled label="Tempo (BPM) — words land on the beat">
            <Input type="number" min={40} max={240} value={v.bpm === undefined ? '' : String(v.bpm)} onChange={(e) => set('bpm', e.target.value ? Number(e.target.value) : undefined)} placeholder="Optional, e.g. 120" />
          </Labeled>
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
