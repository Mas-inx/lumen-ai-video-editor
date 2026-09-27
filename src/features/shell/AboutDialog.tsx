import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { LogoMark } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { useUI } from '@/editor/ui-store'
import { APP_VERSION, platform } from '@/lib/platform'
import { checkForUpdates, installUpdate, RELEASES_URL, releaseUrl, useUpdates } from '@/lib/updates'

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
        <Updates />
        <p className="mt-5 text-xs leading-relaxed text-fg-4">
          Decoding and encoding run on your computer with WebCodecs (Mediabunny). Noise reduction uses RNNoise. AI features use the providers you connect in Integrations —
          your keys stay on this machine.
        </p>
        <p className="mt-3 text-xs text-fg-3">
          Vibecoded with <span className="text-fg-2">Claude Opus 5.5</span> by <span className="text-accent">Mas-Inx</span> at{' '}
          <a href="https://async.tech/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            AsyncTech
          </a>
        </p>
      </div>
    </Dialog>
  )
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `at ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/** Where updates stand, with the one action that fits. */
function Updates() {
  const u = useUpdates()
  const percent = Math.round((u.progress ?? 0) * 100)
  const check = (
    <Button size="sm" variant="outline" onClick={() => void checkForUpdates()}>
      Check now
    </Button>
  )
  let line: ReactNode
  let action: ReactNode = null
  switch (u.status) {
    case 'unsupported':
      line = 'This build doesn’t update itself — the installed app does.'
      break
    case 'checking':
      line = (
        <>
          <LoaderCircle className="size-3 animate-spin" /> Checking GitHub…
        </>
      )
      break
    case 'downloading':
      line = `Downloading Lumen ${u.version} — ${percent}%`
      break
    case 'ready':
      line = `Lumen ${u.version} is ready to install.`
      action = (
        <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
          <RefreshCw /> Restart to update
        </Button>
      )
      break
    case 'error':
      line = <span className="text-danger/90">{u.error ?? 'Couldn’t check for updates.'}</span>
      action = check
      break
    case 'up-to-date':
      line = `You’re up to date${u.checkedAt ? ` · checked ${ago(u.checkedAt)}` : ''}.`
      action = check
      break
    default:
      line = 'Lumen checks GitHub for new versions and installs them when you restart.'
      action = check
  }
  return (
    <div className="mt-5 rounded-xl bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg-2">Updates</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-2xs leading-relaxed text-fg-4">{line}</div>
        </div>
        {action}
      </div>
      {u.status === 'downloading' && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      )}
      {(u.status === 'ready' || u.status === 'downloading') && u.notes && (
        <div className="mt-2.5 max-h-28 overflow-y-auto border-t border-line pt-2 text-2xs leading-relaxed whitespace-pre-line text-fg-3">{u.notes}</div>
      )}
      <a href={u.version ? releaseUrl(u.version) : RELEASES_URL} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-2xs text-accent-2 hover:underline">
        {u.version ? `What’s new in ${u.version}` : 'All releases'} <ExternalLink className="size-3" />
      </a>
    </div>
  )
}
