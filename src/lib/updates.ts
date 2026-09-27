/**
 * Lumen's updates, as the editor sees them: the main process checks the GitHub
 * Releases page, downloads a newer version in the background and installs it on
 * restart. The editor shows where that's at and offers the restart.
 */
import { toast } from 'sonner'
import { create } from 'zustand'
import type { UpdateState } from '@shared/app'
import { APP_VERSION, desktop } from '@/lib/platform'

export const RELEASES_URL = 'https://github.com/Mas-inx/lumen-ai-video-editor/releases'
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version}`

export const useUpdates = create<UpdateState>(() => ({ status: desktop ? 'idle' : 'unsupported', current: APP_VERSION }))

let started = false
let announced: string | undefined
/** The user asked for this check — say how it went. */
let asked = false

function readyToast(version: string) {
  toast(`Lumen ${version} is ready`, {
    id: 'lumen-update',
    description: 'Restart to update. If anything is unsaved, you’ll be asked first.',
    duration: Number.POSITIVE_INFINITY,
    action: { label: 'Restart', onClick: () => void installUpdate() },
  })
}

function apply(state: UpdateState) {
  useUpdates.setState(state, true)
  if (state.status === 'ready' && state.version && announced !== state.version) {
    announced = state.version
    readyToast(state.version)
  }
  if (!asked || state.status === 'checking' || state.status === 'idle') return
  asked = false
  if (state.status === 'up-to-date') toast.success(`Lumen ${state.current} is the latest version.`)
  else if (state.status === 'downloading') toast(`Downloading Lumen ${state.version}…`, { description: 'It installs when you restart.' })
  else if (state.status === 'ready' && state.version) readyToast(state.version)
  else if (state.status === 'error') toast.error(state.error ?? 'Couldn’t check for updates.')
  else if (state.status === 'unsupported') toast('This build doesn’t update itself', { description: 'Updates come to the installed app — download it from the Releases page.' })
}

export function startUpdates() {
  if (started || !desktop) return
  started = true
  desktop.updates.onState(apply)
  void desktop.updates.state().then(apply)
}

export async function checkForUpdates() {
  if (!desktop) return
  asked = true
  apply(await desktop.updates.check())
}

export async function installUpdate() {
  if (!desktop) return
  if (!(await desktop.updates.install())) toast.error('There’s no downloaded update to install yet.')
}
