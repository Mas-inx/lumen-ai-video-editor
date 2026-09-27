import { useEffect, useRef, useState } from 'react'
import { Segmented } from '@/components/ui/segmented'
import { drawScope, type ScopeKind } from '@/engine/scopes'
import { onPreviewFrame } from './PreviewStage'

const SAMPLE_W = 256

/** Scopes of the program monitor, refreshed as the picture changes (at most ~12 times a second). */
export function Scopes() {
  const [kind, setKind] = useState<ScopeKind>(() => {
    try {
      return (localStorage.getItem('lumen.scope') as ScopeKind) || 'waveform'
    } catch {
      return 'waveform'
    }
  })
  const out = useRef<HTMLCanvasElement>(null)
  const latest = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem('lumen.scope', kind)
    } catch {
      /* private storage */
    }
    const sample = document.createElement('canvas')
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      const src = latest.current
      const target = out.current
      if (!src || !target || !src.width) return
      last = performance.now()
      sample.width = SAMPLE_W
      sample.height = Math.max(1, Math.round((SAMPLE_W * src.height) / src.width))
      const sctx = sample.getContext('2d', { willReadFrequently: true })!
      sctx.drawImage(src, 0, 0, sample.width, sample.height)
      const px = sctx.getImageData(0, 0, sample.width, sample.height).data
      drawScope(kind, px, sample.width, sample.height, target)
    }
    const off = onPreviewFrame((canvas) => {
      latest.current = canvas
      clearTimeout(timer)
      const wait = Math.max(0, 80 - (performance.now() - last))
      timer = setTimeout(run, wait)
    })
    run()
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [kind])

  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-2 border-l border-line p-2.5">
      <Segmented
        stretch
        value={kind}
        onChange={setKind}
        options={[
          { value: 'waveform', label: 'Wave' },
          { value: 'parade', label: 'RGB' },
          { value: 'vectorscope', label: 'Vector' },
          { value: 'histogram', label: 'Histo' },
        ]}
      />
      <canvas ref={out} width={276} height={200} className="w-full rounded-md shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" />
    </div>
  )
}
