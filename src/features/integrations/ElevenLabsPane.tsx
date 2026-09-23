import { AudioLines, Check, ExternalLink, LoaderCircle, Trash } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUI } from '@/editor/ui-store'
import { useGenerate } from '@/features/assets/generate-store'
import { setElevenLabsKey, useIntegrations } from '@/integrations/store'
import { Card, IconTile, StatusDot } from './parts'

function Feature({ title, children }: { title: string; children: string }) {
  return (
    <div className="rounded-xl bg-white/[0.025] p-3.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <div className="text-sm font-medium text-fg-2">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-fg-4">{children}</p>
    </div>
  )
}

export function ElevenLabsPane() {
  const state = useIntegrations((s) => s.elevenlabs)
  const voices = useIntegrations((s) => s.voices)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (value: string | null) => {
    setBusy(true)
    try {
      await setElevenLabsKey(value)
      setKey('')
      if (value) toast.success('ElevenLabs connected')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="mb-6 flex items-start gap-4">
        <IconTile tone="mcp">
          <AudioLines />
        </IconTile>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight text-fg">ElevenLabs</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-fg-3">Voiceovers that come with word timings, transcription of your own recordings, sound effects and music — straight into your media.</p>
        </div>
      </div>

      <Card>
        {state?.configured ? (
          <div className="flex items-center gap-3">
            <StatusDot status="ready" className="size-2" />
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">Connected</div>
              <div className="text-2xs text-fg-4">
                Key {state.keyHint} · {voices.length} voices
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
              <Trash /> Remove key
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium text-fg">Add your API key</div>
            <div className="flex gap-2">
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk_…" className="font-mono text-xs" autoComplete="off" />
              <Button size="md" variant="primary" disabled={busy || !key.trim()} onClick={() => void save(key.trim())}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Check />} Connect
              </Button>
            </div>
            <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-2xs text-accent-2 hover:underline">
              Get a key <ExternalLink className="size-3" />
            </a>
          </div>
        )}
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Feature title="Voiceovers">Any ElevenLabs voice. Each line comes back with timings, so captions and pause removal work instantly.</Feature>
        <Feature title="Transcription">Scribe transcribes your real recordings — right-click audio or video in Media.</Feature>
        <Feature title="Sound effects">Describe a sound, get an effect up to 30 seconds long, optionally looping.</Feature>
        <Feature title="Music">Full tracks from a prompt, with or without vocals (paid ElevenLabs plans).</Feature>
      </div>
      <p className="mt-4 text-2xs leading-relaxed text-fg-4">
        ElevenLabs’ hosted MCP server only accepts apps that publish a client ID document on a public website, so Lumen connects through the API with your key for now. Usage is billed to your ElevenLabs account.
      </p>
      {state?.configured && (
        <Button
          variant="primary"
          size="lg"
          className="mt-5"
          onClick={() => {
            useUI.getState().setLeftTab('generate')
            useGenerate.setState({ engine: 'media' })
            useIntegrations.setState({ hubOpen: false })
          }}
        >
          Make a voiceover
        </Button>
      )}
    </div>
  )
}
