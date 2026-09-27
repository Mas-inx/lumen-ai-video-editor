/**
 * Bringing media into a project: the Import dialog, files dropped from the OS,
 * relinking moved files, and the background analysis (waveforms) that makes
 * imported media feel instant afterwards.
 */
import { toast } from 'sonner'
import type { MediaFileInfo } from '@shared/app'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { Asset } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { audioLeaves, audioSourceUrl, computePeaks, computePeaksStreamed, isLongAudio, loadAudio, pruneAudio } from '@/engine/audio-engine'
import { kindFromMime, MediaError, probeMedia } from '@/engine/decode'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'
import { loadSubtitleFile } from './subtitle-files'

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

async function assetFromFile(file: MediaFileInfo): Promise<Asset> {
  const kind = kindFromMime(file.mime)
  if (!kind) throw new MediaError('Not a media file.')
  const meta = await probeMedia(file.url, file.mime)
  const asset: Asset = {
    id: uid('asset'),
    name: stripExtension(file.name),
    kind: meta.kind,
    duration: meta.kind === 'image' ? undefined : meta.duration,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    hasAudio: meta.kind === 'image' ? undefined : meta.hasAudio,
    source: { type: 'file', url: file.url, path: file.path, mime: file.mime, fileName: file.name, size: file.size, mtime: file.mtime, poster: meta.poster },
    addedAt: Date.now(),
  }
  if (asset.kind === 'image') delete asset.duration
  return asset
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

/** Adds files to the project library (skipping ones already in it). Returns the assets, new and existing. */
export async function importMediaFiles(files: MediaFileInfo[]): Promise<Asset[]> {
  if (!files.length) return []
  const byPath = new Map(
    Object.values(getProject().assets)
      .filter((a) => a.source.type === 'file' && a.source.path)
      .map((a) => [(a.source as { path: string }).path.toLowerCase(), a]),
  )
  const existing: Asset[] = []
  const fresh = files.filter((f) => {
    const hit = byPath.get(f.path.toLowerCase())
    if (hit) existing.push(hit)
    return !hit
  })
  const id = fresh.length ? toast.loading(`Importing ${plural(fresh.length, 'file')}…`) : undefined
  const failed: { name: string; reason: string }[] = []
  const results = await mapLimit(fresh, 3, async (file) => {
    try {
      return await assetFromFile(file)
    } catch (err) {
      failed.push({ name: file.name, reason: err instanceof Error ? err.message : String(err) })
      return null
    }
  })
  const assets = results.filter((a): a is Asset => Boolean(a))
  if (assets.length) {
    useEditor.getState().transaction(`Import ${plural(assets.length, 'file')}`, 'user', () => {
      for (const asset of assets) dispatch('asset.add', { asset })
    })
    useUI.getState().setLeftTab('media')
    void analyzeAssets(assets.map((a) => a.id))
  }
  if (failed.length === 1 && !assets.length) toast.error(`Couldn’t import ${failed[0].name}`, { id, description: failed[0].reason })
  else if (failed.length) toast.error(`Imported ${assets.length}, couldn’t import ${failed.length}`, { id, description: failed.map((f) => `${f.name}: ${f.reason}`).join('\n') })
  else if (id) toast.success(`Imported ${plural(assets.length, 'file')}`, { id })
  return [...assets, ...existing]
}

/** The native Import dialog. */
export async function pickAndImport() {
  if (!desktop) {
    toast.error('Importing files needs the Lumen desktop app.')
    return []
  }
  return importMediaFiles(await desktop.files.pickMedia())
}

/** Files (or folders) dropped from Explorer / Finder. */
export async function importDropped(files: File[]): Promise<Asset[]> {
  // Subtitle files become captions rather than media.
  const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name))
  for (const f of subs) await loadSubtitleFile(f)
  files = files.filter((f) => !subs.includes(f))
  if (!files.length) return []
  if (!desktop) {
    toast.error('Importing files needs the Lumen desktop app.')
    return []
  }
  const paths = files.map((f) => desktop!.files.pathForFile(f)).filter(Boolean)
  if (!paths.length) return []
  const infos = await desktop.files.register(paths)
  if (!infos.length) {
    toast.error('Nothing to import', { description: 'Lumen imports video, audio and image files.' })
    return []
  }
  return importMediaFiles(infos)
}

/** Points a missing (or any) file asset at a new file on disk. */
export async function relinkAsset(assetId: string) {
  const asset = getProject().assets[assetId]
  if (!asset || asset.source.type !== 'file' || !desktop) return false
  const file = await desktop.files.relink(asset.source.fileName)
  if (!file) return false
  try {
    const fresh = await assetFromFile(file)
    if (fresh.kind !== asset.kind) throw new MediaError(`That’s ${fresh.kind === 'image' ? 'an image' : `a ${fresh.kind} file`} — pick the ${asset.kind} file this media came from.`)
    dispatch('asset.update', {
      id: assetId,
      patch: {
        source: { ...fresh.source, missing: undefined },
        ...(fresh.duration ? { duration: fresh.duration } : {}),
        ...(fresh.width ? { width: fresh.width, height: fresh.height } : {}),
        ...(fresh.hasAudio !== undefined ? { hasAudio: fresh.hasAudio } : {}),
      },
    })
    toast.success(`Relinked ${asset.name}`)
    void analyzeAssets([assetId], true)
    return true
  } catch (err) {
    toast.error('Couldn’t relink', { description: err instanceof Error ? err.message : String(err) })
    return false
  }
}

// ─── Background analysis ─────────────────────────────────────────────────

const analyzing = new Set<string>()

/** Waveforms for media that has sound but no peaks yet (new imports, older projects). */
export async function analyzeAssets(ids?: string[], force = false) {
  const project = getProject()
  const targets = (ids ?? Object.keys(project.assets))
    .map((id) => project.assets[id])
    .filter((a): a is Asset => Boolean(a) && Boolean(audioSourceUrl(a)) && (force || !a.peaks?.length) && !analyzing.has(a.id))
  for (const asset of targets) {
    analyzing.add(asset.id)
    try {
      // Long recordings are measured a minute at a time instead of decoded whole.
      const peaks = isLongAudio(asset) ? await computePeaksStreamed(asset) : null
      const buffer = peaks ? null : await loadAudio(asset)
      const current = getProject().assets[asset.id]
      if (!current) continue
      if (peaks) {
        dispatch('asset.update', { id: asset.id, patch: { peaks, hasAudio: true } }, { history: false })
        continue
      }
      if (!buffer) {
        if (current.kind === 'video' && current.hasAudio !== false) dispatch('asset.update', { id: asset.id, patch: { hasAudio: false } }, { history: false })
        continue
      }
      dispatch('asset.update', { id: asset.id, patch: { peaks: computePeaks(buffer), hasAudio: true } }, { history: false })
    } catch (err) {
      console.warn(`Couldn’t analyze ${asset.name}`, err)
    } finally {
      analyzing.delete(asset.id)
    }
  }
  releaseUnusedAudio()
}

/** Keeps decoded audio only for media that's actually on the timeline (nested timelines included). */
export function releaseUnusedAudio() {
  const project = getProject()
  const used = new Set(
    [...Object.values(project.clips), ...audioLeaves(project).map((l) => l.clip)]
      .map((c) => c.assetId)
      .filter((id): id is string => Boolean(id)),
  )
  pruneAudio(used)
}
