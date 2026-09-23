/**
 * Voice prompts: record from the microphone, transcribe (OpenAI Whisper with a
 * key, otherwise Whisper on this computer) and hand back the text.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { transcribeSpeech, transcribers, TRANSCRIBER_NAMES } from '@/project/transcribe'
import { onWhisperProgress } from '@/project/whisper'

type VoiceState = 'idle' | 'recording' | 'transcribing'

let recorder: MediaRecorder | null = null

export function useVoiceInput(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle')

  const start = async () => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      toast.error('Microphone unavailable', { description: 'Allow Lumen to use the microphone in your system settings, then try again.' })
      return
    }
    const chunks: Blob[] = []
    const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '' })
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      recorder = null
      setState('transcribing')
      const using = transcribers().find((t) => t !== 'elevenlabs') ?? 'local'
      let toastId: string | number | undefined
      const off = onWhisperProgress((m) => {
        if (m.type === 'progress' && m.status === 'progress' && m.total && m.total > 5_000_000) {
          toastId = toast.loading(`Downloading the speech model… ${Math.round(m.progress ?? 0)}%`, { id: toastId, description: 'One time, about 75 MB. Then it works offline.' })
        }
      })
      try {
        const bytes = await new Blob(chunks).arrayBuffer()
        const ctx = new OfflineAudioContext(1, 1, 48000)
        const buffer = await ctx.decodeAudioData(bytes)
        const text = await transcribeSpeech(buffer)
        if (toastId !== undefined) toast.dismiss(toastId)
        if (text) onText(text)
        else toast('Didn’t catch that', { description: 'Nothing was heard in the recording.' })
      } catch (err) {
        if (toastId !== undefined) toast.dismiss(toastId)
        toast.error('Voice input failed', { description: `${TRANSCRIBER_NAMES[using]}: ${err instanceof Error ? err.message : String(err)}` })
      } finally {
        off()
        setState('idle')
      }
    }
    recorder = rec
    rec.start()
    setState('recording')
  }

  const stop = () => recorder?.state === 'recording' && recorder.stop()

  return { state, toggle: () => (state === 'recording' ? stop() : state === 'idle' ? void start() : undefined) }
}
