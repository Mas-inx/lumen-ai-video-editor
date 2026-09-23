import { LogoMark } from '@/components/brand'
import { Dialog } from '@/components/ui/dialog'
import { useUI } from '@/editor/ui-store'
import { APP_VERSION, platform } from '@/lib/platform'

export function AboutDialog() {
  const open = useUI((s) => s.aboutOpen)
  const setOpen = useUI((s) => s.setAboutOpen)
  const rows: [string, string][] = [
    ['Version', APP_VERSION],
    ...(platform.versions ? ([['Electron', platform.versions.electron], ['Chromium', platform.versions.chrome]] as [string, string][]) : []),
    ['Platform', platform.isWindows ? 'Windows' : platform.isMac ? 'macOS' : 'Linux'],
  ]
  return (
    <Dialog open={open} onOpenChange={setOpen} title="About Lumen" className="w-[min(420px,calc(100vw-32px))]">
      <div className="px-5 pt-1 pb-5">
        <div className="flex items-center gap-3">
          <LogoMark className="size-12 drop-shadow-[0_6px_24px_rgb(214_238_0/0.28)]" />
          <div>
            <div className="font-display text-xl font-semibold tracking-tight text-fg">Lumen</div>
            <div className="text-xs text-fg-3">AI-native video editor</div>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-4">{k}</dt>
              <dd className="text-fg-2 tabular">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 text-xs leading-relaxed text-fg-4">
          Decoding and encoding run on your computer with WebCodecs (Mediabunny). Noise reduction uses RNNoise. AI features use the providers you connect in Integrations —
          your keys stay on this machine.
        </p>
        <p className="mt-3 text-xs text-fg-3">
          Vibecoded with <span className="text-fg-2">Claude Opus 5.5</span> by <span className="text-accent">Mas-Inx</span>
        </p>
      </div>
    </Dialog>
  )
}
