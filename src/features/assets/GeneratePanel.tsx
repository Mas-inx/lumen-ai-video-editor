import { AudioLines, Box, Clapperboard, KeyRound, Plug, Sparkles, Trash } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AiSparkle } from '@/components/brand'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useEditor } from '@/editor/store'
import { RenderCard } from '@/features/integrations/parts'
import { missingFields, SchemaForm, schemaDefaults, type JsonSchema } from '@/features/integrations/SchemaForm'
import { useAi } from '@/integrations/ai'
import {
  callTool,
  clearFinishedJobs,
  elevenMusic,
  elevenSfx,
  elevenSpeak,
  generateImage,
  generateVideo,
  generatorTools,
  loadGenModels,
  openIntegrations,
  useGenModels,
  useIntegrations,
  type GenProvider,
} from '@/integrations/store'
import { Generate3D } from './Generate3D'
import { GenerateMotion } from './GenerateMotion'
import { useGenerate, type GenerateMode } from './generate-store'
import { Chip, PanelHeader, SectionLabel } from './shared'

type Mode = GenerateMode

const PLACEHOLDER: Record<Mode, string> = {
  video: 'Describe the shot: subject, action, camera move, light…',
  image: 'Describe the image: subject, style, composition…',
  voice: 'Type what the narrator should say…',
  music: 'Genre, mood, instruments, how it should build…',
  sfx: 'Describe the sound, e.g. a heavy wooden door creaking open…',
}

const PROVIDER_NAME: Record<GenProvider, string> = { openai: 'OpenAI', gemini: 'Google' }

type Generator =
  | { id: string; type: 'model'; provider: GenProvider; model: string; label: string }
  | { id: 'elevenlabs'; type: 'elevenlabs'; label: string }
  | { id: string; type: 'mcp'; serverId: string; label: string; tool: ReturnType<typeof generatorTools>[number]['tool'] }

export function GeneratePanel() {
  const engine = useGenerate((s) => s.engine)
  return (
    <>
      <PanelHeader title="Generate" accent>
        <IconButton label="Integrations" onClick={() => openIntegrations()}>
          <Plug />
        </IconButton>
      </PanelHeader>
      <div className="px-3.5 pb-3">
        <Segmented
          stretch
          size="md"
          value={engine}
          onChange={(e) => useGenerate.setState({ engine: e })}
          options={[
            { value: 'media', icon: <Sparkles />, label: 'Media' },
            { value: '3d', icon: <Box />, label: '3D' },
            { value: 'motion', icon: <Clapperboard />, label: 'Motion' },
          ]}
        />
      </div>
      {engine === 'media' && <MediaGenerator />}
      {engine === '3d' && <Generate3D />}
      {engine === 'motion' && <GenerateMotion />}
    </>
  )
}

function useGenerators(mode: Mode): Generator[] {
  const providers = useAi((s) => s.providers)
  const models = useGenModels((s) => s.models)
  const servers = useIntegrations((s) => s.servers)
  const eleven = useIntegrations((s) => Boolean(s.elevenlabs?.configured))
  const openai = Boolean(providers.openai?.configured)
  const gemini = Boolean(providers.gemini?.configured)
  useEffect(() => {
    if (openai) void loadGenModels('openai')
    if (gemini) void loadGenModels('gemini')
  }, [openai, gemini])

  const out: Generator[] = []
  if (mode === 'image' || mode === 'video') {
    for (const provider of ['openai', 'gemini'] as const) {
      if (!(provider === 'openai' ? openai : gemini)) continue
      for (const model of models[provider]?.[mode] ?? []) out.push({ id: `${provider}/${model}`, type: 'model', provider, model, label: `${PROVIDER_NAME[provider]} · ${model}` })
    }
  } else if (eleven) out.push({ id: 'elevenlabs', type: 'elevenlabs', label: 'ElevenLabs' })
  const media = mode === 'voice' ? /speech|voice|tts|narrat/ : mode === 'music' ? /music|song|audio/ : mode === 'sfx' ? /sound|sfx|audio|effect/ : mode === 'image' ? /image|picture|photo|flux|still/ : /video|animate|clip|motion|kling|veo|sora|runway|luma|hailuo/
  for (const t of generatorTools(servers)) {
    const text = `${t.tool.name} ${t.tool.title ?? ''} ${t.tool.description ?? ''}`.toLowerCase()
    if (media.test(text)) out.push({ id: `mcp:${t.serverId}/${t.tool.name}`, type: 'mcp', serverId: t.serverId, label: `${t.server} · ${t.tool.title ?? t.tool.name}`, tool: t.tool })
  }
  return out
}

function MediaGenerator() {
  const mode = useGenerate((s) => s.mode)
  const setMode = (m: Mode) => useGenerate.setState({ mode: m })
  const generators = useGenerators(mode)
  const [choice, setChoice] = useState<Record<Mode, string>>({ video: '', image: '', voice: '', music: '', sfx: '' })
  const gen = generators.find((g) => g.id === choice[mode]) ?? generators[0]
  const [prompt, setPrompt] = useState('')
  const [args, setArgs] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const settings = useEditor((s) => s.project.settings)
  const projectAspect = settings.width > settings.height * 1.1 ? '16:9' : settings.height > settings.width * 1.1 ? '9:16' : '1:1'
  const [aspect, setAspect] = useState<'16:9' | '9:16' | '1:1'>(projectAspect)
  const [seconds, setSeconds] = useState(8)
  const [resolution, setResolution] = useState<'720p' | '1080p'>('720p')
  const [voiceId, setVoiceId] = useState('')
  const [voiceModel, setVoiceModel] = useState('eleven_multilingual_v2')
  const [musicLength, setMusicLength] = useState(30)
  const [instrumental, setInstrumental] = useState(true)
  const [sfxLength, setSfxLength] = useState(0)
  const [loop, setLoop] = useState(false)
  const voices = useIntegrations((s) => s.voices)
  const allJobs = useIntegrations((s) => s.jobs)
  const genModels = useGenModels((s) => s.models)
  const voice = voices.find((v) => v.id === voiceId) ?? voices[0]
  const jobs = Object.values(allJobs)
    .filter((j) => j.integration === 'mcp' || j.integration === 'elevenlabs' || j.integration === 'ai')
    .sort((a, b) => b.startedAt - a.startedAt)

  const pick = (id: string) => {
    setChoice((c) => ({ ...c, [mode]: id }))
    const g = generators.find((x) => x.id === id)
    setArgs(g?.type === 'mcp' ? schemaDefaults(g.tool.inputSchema as JsonSchema) : {})
  }
  useEffect(() => {
    if (gen?.type === 'mcp' && !Object.keys(args).length) setArgs(schemaDefaults(gen.tool.inputSchema as JsonSchema))
  }, [gen?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const durations = gen?.type === 'model' && gen.provider === 'gemini' ? [4, 6, 8] : [4, 8, 12]
  useEffect(() => {
    if (!durations.includes(seconds)) setSeconds(durations[durations.length - 1])
  }, [gen?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const schema = (gen?.type === 'mcp' ? gen.tool.inputSchema : {}) as JsonSchema
  const canSubmit = Boolean(gen) && !busy && (gen?.type === 'mcp' ? missingFields(schema, args).length === 0 : prompt.trim().length > 0)

  const submit = async () => {
    if (!gen || !canSubmit) return
    setBusy(true)
    try {
      const text = prompt.trim()
      if (gen.type === 'mcp') await callTool(gen.serverId, gen.tool.name, args)
      else if (gen.type === 'model') {
        if (mode === 'image') await generateImage({ provider: gen.provider, model: gen.model, prompt: text, aspect })
        else await generateVideo({ provider: gen.provider, model: gen.model, prompt: text, aspect: aspect === '1:1' ? '16:9' : aspect, seconds, resolution: gen.provider === 'gemini' ? resolution : undefined })
      } else if (mode === 'voice') {
        if (!voice) throw new Error('No ElevenLabs voices found on your account.')
        await elevenSpeak({ text, voiceId: voice.id, voiceName: voice.name, modelId: voiceModel })
      } else if (mode === 'music') await elevenMusic({ prompt: text, lengthSeconds: musicLength, instrumental })
      else await elevenSfx({ prompt: text, durationSeconds: sfxLength || undefined, loop })
      if (gen.type !== 'mcp') setPrompt('')
    } catch (err) {
      toast.error('Couldn’t start the generation', { description: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const loading = (mode === 'image' || mode === 'video') && Object.values(genModels).some((m) => m?.loading)
  const errors = (mode === 'image' || mode === 'video' ? (['openai', 'gemini'] as const) : [])
    .map((p) => (genModels[p]?.error ? `${PROVIDER_NAME[p]}: ${genModels[p]!.error}` : null))
    .filter(Boolean)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-3 px-3.5 pb-3">
        <Segmented
          stretch
          value={mode}
          onChange={setMode}
          options={[
            { value: 'video', label: 'Video' },
            { value: 'image', label: 'Image' },
            { value: 'voice', label: 'Voice' },
            { value: 'music', label: 'Music' },
            { value: 'sfx', label: 'SFX' },
          ]}
        />

        {generators.length > 0 ? (
          <Select aria-label="Generator" value={gen?.id ?? ''} onChange={pick} size="md" className="w-full" options={generators.map((g) => ({ value: g.id, label: g.label }))} />
        ) : loading ? (
          <div className="rounded-xl bg-white/[0.025] px-3 py-3 text-xs text-fg-4">Looking up the models your keys can use…</div>
        ) : (
          <ConnectCards mode={mode} />
        )}
        {errors.length > 0 && <p className="px-1 text-2xs leading-relaxed text-danger/80">{errors.join(' · ')}</p>}

        {gen?.type === 'mcp' && (
          <div className="max-h-[46vh] overflow-y-auto rounded-xl bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
            {gen.tool.description && <p className="mb-3 line-clamp-3 text-2xs leading-relaxed text-fg-4">{gen.tool.description}</p>}
            <SchemaForm schema={schema} values={args} onChange={setArgs} />
          </div>
        )}

        {gen && gen.type !== 'mcp' && (
          <>
            <div className="ring-ai rounded-xl bg-white/[0.035] p-2.5">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
                }}
                rows={4}
                placeholder={PLACEHOLDER[mode]}
                className="w-full resize-none bg-transparent text-sm leading-relaxed text-fg outline-none placeholder:text-fg-4"
              />
            </div>

            {(mode === 'image' || mode === 'video') && (
              <Options label="Shape">
                {(mode === 'image' ? (['16:9', '9:16', '1:1'] as const) : (['16:9', '9:16'] as const)).map((a) => (
                  <Chip key={a} active={aspect === a} onClick={() => setAspect(a)}>
                    {a === '16:9' ? 'Landscape' : a === '9:16' ? 'Vertical' : 'Square'}
                  </Chip>
                ))}
              </Options>
            )}
            {mode === 'video' && (
              <Options label="Length">
                {durations.map((d) => (
                  <Chip key={d} active={seconds === d} onClick={() => setSeconds(d)}>
                    {d}s
                  </Chip>
                ))}
              </Options>
            )}
            {mode === 'video' && gen.type === 'model' && gen.provider === 'gemini' && (
              <Options label="Quality">
                {(['720p', '1080p'] as const).map((r) => (
                  <Chip key={r} active={resolution === r} onClick={() => setResolution(r)}>
                    {r}
                  </Chip>
                ))}
              </Options>
            )}
            {mode === 'voice' && (
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Select aria-label="Voice" value={voice?.id ?? ''} onChange={setVoiceId} size="md" options={voices.map((v) => ({ value: v.id, label: `${v.name}${v.labels?.accent ? ` · ${v.labels.accent}` : ''}` }))} />
                <Select
                  aria-label="Voice model"
                  value={voiceModel}
                  onChange={setVoiceModel}
                  size="md"
                  options={[
                    { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
                    { value: 'eleven_flash_v2_5', label: 'Flash v2.5' },
                  ]}
                />
              </div>
            )}
            {mode === 'music' && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex gap-1">
                  {[30, 60, 120].map((d) => (
                    <Chip key={d} active={musicLength === d} onClick={() => setMusicLength(d)}>
                      {d < 60 ? `${d}s` : `${d / 60} min`}
                    </Chip>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-fg-3">
                  Instrumental <Switch aria-label="Instrumental" checked={instrumental} onChange={setInstrumental} />
                </label>
              </div>
            )}
            {mode === 'sfx' && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex gap-1">
                  {[0, 2, 5, 10].map((d) => (
                    <Chip key={d} active={sfxLength === d} onClick={() => setSfxLength(d)}>
                      {d ? `${d}s` : 'Auto'}
                    </Chip>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-fg-3">
                  Loop <Switch aria-label="Loop" checked={loop} onChange={setLoop} />
                </label>
              </div>
            )}
          </>
        )}

        {gen && (
          <Button variant="ai" size="lg" className="w-full" disabled={!canSubmit} onClick={() => void submit()}>
            <AiSparkle className="!size-4 [&_path]:fill-current" />
            Generate {mode === 'voice' ? 'voiceover' : mode === 'sfx' ? 'sound effect' : mode}
          </Button>
        )}
        {gen && generators.length > 0 && (
          <button type="button" onClick={() => openIntegrations(mode === 'image' || mode === 'video' ? 'ai-models' : 'elevenlabs')} className="px-1 text-2xs text-fg-4 hover:text-fg-2">
            Uses your own account · manage in Integrations
          </button>
        )}
      </div>

      <div className="px-3.5 pb-4">
        <SectionLabel
          right={
            jobs.some((j) => j.status !== 'running') ? (
              <IconButton size="xs" label="Clear finished" onClick={clearFinishedJobs}>
                <Trash />
              </IconButton>
            ) : undefined
          }
        >
          Generations
        </SectionLabel>
        {!jobs.length && (
          <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center">
            <AiSparkle className="mx-auto mb-2 size-6 opacity-80" />
            <p className="text-sm font-medium text-fg-2">Describe it, and it appears in your media</p>
            <p className="mt-1 text-xs text-fg-4">Finished generations land in Media, ready to drag onto the timeline.</p>
          </div>
        )}
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {jobs.map((job) => (
              <RenderCard key={job.id} job={job} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function Options({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-fg-3">{label}</span>
      <div className="flex gap-1">{children}</div>
    </div>
  )
}

/** What to connect to generate this kind of media. */
function ConnectCards({ mode }: { mode: Mode }) {
  const visual = mode === 'image' || mode === 'video'
  const cards: { icon: ReactNode; title: string; hint: string; focus: string }[] = visual
    ? [
        { icon: <KeyRound />, title: 'OpenAI key', hint: mode === 'video' ? 'Video models' : 'GPT Image', focus: 'ai-models' },
        { icon: <KeyRound />, title: 'Google Gemini key', hint: mode === 'video' ? 'Veo video' : 'Gemini image (Nano Banana)', focus: 'ai-models' },
        { icon: <Plug />, title: 'An MCP generator', hint: 'Higgsfield, fal.ai, Replicate, Runway…', focus: 'catalog:higgsfield' },
      ]
    : [
        { icon: <AudioLines />, title: 'ElevenLabs', hint: mode === 'voice' ? 'Voices in any language' : mode === 'music' ? 'Music from a prompt' : 'Sound effects from text', focus: 'elevenlabs' },
        { icon: <Plug />, title: 'An MCP generator', hint: 'Any server with audio tools', focus: 'catalog:fal' },
      ]
  return (
    <div className="space-y-1.5">
      <p className="px-1 text-xs text-fg-3">Connect a service to generate {mode === 'sfx' ? 'sound effects' : mode === 'voice' ? 'voiceovers' : mode}:</p>
      {cards.map((c) => (
        <button
          key={c.title}
          type="button"
          onClick={() => openIntegrations(c.focus)}
          className="flex w-full items-center gap-2.5 rounded-xl bg-white/[0.025] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-colors hover:bg-white/[0.05] [&_svg]:size-4"
        >
          <span className="shrink-0 text-accent-2">{c.icon}</span>
          <span className="min-w-0 text-2xs leading-snug text-fg-3">
            <span className="block text-xs font-medium text-fg-2">{c.title}</span>
            {c.hint}
          </span>
        </button>
      ))}
    </div>
  )
}
