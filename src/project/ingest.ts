/**
 * Frame ingest, the editor's half: when another app starts sending a clip
 * (see shared/ingest.ts), an encoder worker turns its frames into a master
 * file, and the finished clip lands in the media library — not on the timeline.
 */
import { toast } from 'sonner'
import { create } from 'zustand'
import { wantsIngestProxy, type IngestClip, type IngestQuality, type IngestSession, type IngestState } from '@shared/ingest'
import { parseCues } from '@/editor/cues'
import { dispatch, getProject } from '@/editor/store'
import type { Asset } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { probeMedia } from '@/engine/decode'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'
import type { IngestFromWorker, IngestToWorker } from './ingest.worker'
import { analyzeAssets } from './media-import'

export const useIngest = create<{ state: IngestState | null }>(() => ({ state: null }))

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

let started = false

/** Listens for clips. Safe to call more than once. */
export function startIngestClient() {
  if (started || !desktop) return
  started = true
  const api = desktop.ingest
  api.onState((state) => useIngest.setState({ state }))
  api.onClip((clip) => void receive(clip))
  void api.attach().then((state) => useIngest.setState({ state }))
}

export async function setIngestEnabled(on: boolean, persist = true) {
  if (!desktop) throw new Error('Frame ingest needs the desktop app.')
  const state = await desktop.ingest.setEnabled(on, persist)
  useIngest.setState({ state })
  if (on && !state.running) throw new Error(state.error ?? 'Couldn’t start frame ingest.')
  return state
}

export async function setIngestOptions(opts: { quality?: IngestQuality; folder?: string | null }) {
  if (desktop) useIngest.setState({ state: await desktop.ingest.setOptions(opts) })
}

export async function pickIngestFolder() {
  if (desktop) useIngest.setState({ state: await desktop.ingest.pickFolder() })
}

export async function regenerateIngestToken() {
  if (desktop) useIngest.setState({ state: await desktop.ingest.regenerateToken() })
}

/** Who sent a clip, for its tags and the media panel. */
const sourceOf = (clip: IngestClip) => (typeof clip.meta.source === 'string' && clip.meta.source ? clip.meta.source : 'ingest')

const progressText = (clip: IngestClip, encoded: number) => (clip.frames ? `${encoded} of ${clip.frames} frames` : `${encoded} frames`) + ` · ${clip.width}×${clip.height}`

async function receive(clip: IngestClip) {
  const api = desktop!
  let session: IngestSession
  try {
    session = await api.ingest.open(clip.id, wantsIngestProxy(clip.width, clip.height))
  } catch (err) {
    await api.ingest.fail(clip.id, message(err))
    return
  }
  const worker = new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module', name: 'ingest' })
  const send = (msg: IngestToWorker) => worker.postMessage(msg)
  const toastId = toast.loading(`Receiving ${clip.name}`, { description: progressText(clip, 0), duration: Infinity })
  let settled = false

  const fail = async (reason: string, cancelled = false) => {
    if (settled) return
    settled = true
    worker.terminate()
    await api.export.abort(session.master.id).catch(() => {})
    if (session.proxy) await api.export.abort(session.proxy.id).catch(() => {})
    await api.ingest.fail(clip.id, reason)
    if (cancelled) toast.dismiss(toastId)
    else toast.error(`Couldn’t receive ${clip.name}`, { id: toastId, description: reason, duration: 8000 })
  }

  const finish = async (done: Extract<IngestFromWorker, { type: 'done' }>) => {
    settled = true
    worker.terminate()
    try {
      const master = await api.export.finish(session.master.id)
      let proxy: Asset['proxy']
      if (session.proxy) {
        if (done.proxy) {
          const file = await api.export.finish(session.proxy.id)
          const info = await api.files.urlForPath(file.path)
          if (info) proxy = { path: file.path, url: info.url, width: done.proxy.width, height: done.proxy.height }
        } else await api.export.abort(session.proxy.id).catch(() => {})
      }
      const info = await api.files.urlForPath(master.path)
      if (!info) throw new Error('The clip’s file went missing.')
      const probed = await probeMedia(info.url, info.mime).catch(() => null)
      const duration = Math.round((done.frames / clip.fps) * 1000) / 1000
      // The whole of what the sender said (lists of clips carry a short form). Its cue sheet becomes the clip's cues.
      const { cues: sheet, ...meta } = session.clip.meta
      const cues = parseCues(sheet, done.frames / clip.fps)
      const asset: Asset = {
        id: uid('asset'),
        name: clip.name,
        kind: 'video',
        // Exactly the frames that arrived (a probe rounds to the millisecond).
        duration: done.frames / clip.fps,
        width: clip.width,
        height: clip.height,
        fps: clip.fps,
        hasAudio: false,
        source: { type: 'file', url: info.url, path: info.path, mime: info.mime, fileName: info.name, size: info.size, mtime: info.mtime, poster: probed?.poster },
        proxy,
        ...(cues.length ? { cues } : {}),
        provenance: { integration: sourceOf(clip), tool: 'frame-ingest', params: { ...meta, frames: done.frames, quality: clip.quality, codec: done.label } },
        tags: [...new Set(['ingest', sourceOf(clip)])],
        addedAt: Date.now(),
      }
      const res = dispatch('asset.add', { asset }, { label: `Receive ${clip.name}` })
      if (!res.ok) throw new Error(res.error)
      // The sender may have deleted the clip while its last bytes were written.
      const kept = await api.ingest.complete(clip.id, { assetId: asset.id, path: master.path, bytes: master.size, codec: done.label, durationSeconds: duration })
      if (!kept) {
        if (getProject().assets[asset.id]) dispatch('asset.remove', { ids: [asset.id] }, { history: false })
        toast.dismiss(toastId)
        return
      }
      void analyzeAssets([asset.id])
      toast.success(`Received ${clip.name}`, {
        id: toastId,
        description: `${done.frames} frames · ${clip.width}×${clip.height} · ${done.label}${cues.length ? ` · ${cues.length} cue${cues.length > 1 ? 's' : ''}` : ''}`,
        duration: 6000,
        action: { label: 'Show', onClick: () => useUI.getState().setLeftTab('media') },
      })
    } catch (err) {
      settled = false
      await fail(message(err))
    }
  }

  worker.onmessage = (e: MessageEvent<IngestFromWorker>) => {
    const msg = e.data
    if (msg.type === 'write') {
      const handle = msg.file === 'master' ? session.master : session.proxy
      if (!handle) return send({ type: 'written', id: msg.id })
      api.export.write(handle.id, msg.position, msg.data).then(
        () => send({ type: 'written', id: msg.id }),
        (err: unknown) => void fail(`Couldn’t write the file: ${message(err)}`),
      )
    } else if (msg.type === 'progress') {
      api.ingest.progress(clip.id, msg.encoded)
      toast.loading(`Receiving ${clip.name}`, { id: toastId, description: progressText(clip, msg.encoded), duration: Infinity })
    } else if (msg.type === 'done') void finish(msg)
    else if (msg.type === 'error') void fail(msg.message, msg.cancelled)
  }
  worker.onerror = (e) => void fail(e.message || 'The encoder stopped unexpectedly.')
  send({ type: 'start', clip: session.clip, nextUrl: session.nextUrl, proxy: Boolean(session.proxy) })
}
