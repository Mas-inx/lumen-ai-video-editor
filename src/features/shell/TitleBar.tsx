import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Clock,
  Download,
  FilePlus,
  FolderOpen,
  FolderSearch,
  House,
  Info,
  Keyboard,
  PencilLine,
  Redo2,
  RefreshCw,
  Save,
  SaveAll,
  Settings2,
  Undo2,
  Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { AiSparkle, APP_NAME, LogoMark } from '@/components/brand'
import { Button, IconButton } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuTrigger } from '@/components/ui/menu'
import { Tip } from '@/components/ui/tooltip'
import { dispatch, useEditor } from '@/editor/store'
import { JobsIndicator } from '@/features/integrations/JobsIndicator'
import { useUI } from '@/editor/ui-store'
import { cn } from '@/lib/cn'
import { desktop, platform } from '@/lib/platform'
import { checkForUpdates, installUpdate, useUpdates } from '@/lib/updates'
import { openProject, refreshRecent, useDirty, useSession } from '@/project/session'
import { actions } from './actions'

export function TitleBar() {
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useEditor((s) => s.future[0]?.label)
  const rightTab = useUI((s) => s.rightTab)
  const setExportOpen = useUI((s) => s.setExportOpen)
  const setPaletteOpen = useUI((s) => s.setPaletteOpen)

  const home = useSession((s) => s.home)

  const windowsControls = platform.isElectron && !platform.isMac
  const style = { paddingRight: windowsControls ? 'calc(100vw - env(titlebar-area-width, calc(100vw - 140px)) + 8px)' : 12 }
  const headerClass = cn('drag-region relative z-20 flex h-11 shrink-0 items-center gap-1.5 pl-2.5', platform.isElectron && platform.isMac && 'pl-[82px]')

  if (home) {
    return (
      <header className={headerClass} style={style}>
        <AppMenu />
        <div className="no-drag ml-auto flex items-center gap-0.5">
          <UpdatePill />
          <JobsIndicator />
        </div>
      </header>
    )
  }

  return (
    <header className={headerClass} style={style}>
      <AppMenu />
      <span className="px-0.5 text-fg-4">/</span>
      <ProjectName />
      <SaveBadge />

      {/* Command bar */}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="no-drag group absolute left-1/2 flex h-7 w-[min(380px,28vw)] -translate-x-1/2 items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 text-sm text-fg-4 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none transition-colors hover:bg-white/[0.07] hover:text-fg-3 focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <AiSparkle className="size-3.5 opacity-80 transition-opacity group-hover:opacity-100" />
        <span className="truncate">Search, or ask Copilot to edit…</span>
        <Kbd combo="mod+k" className="ml-auto" />
      </button>

      <div className="no-drag ml-auto flex items-center gap-0.5">
        <UpdatePill />
        <JobsIndicator />
        <div className="mx-1.5 h-4 w-px bg-line-2" />
        <IconButton label={undoLabel ? `Undo ${undoLabel}` : 'Undo'} shortcut="mod+z" disabled={!canUndo} onClick={actions.undo} tooltipSide="bottom">
          <Undo2 />
        </IconButton>
        <IconButton label={redoLabel ? `Redo ${redoLabel}` : 'Redo'} shortcut="mod+shift+z" disabled={!canRedo} onClick={actions.redo} tooltipSide="bottom">
          <Redo2 />
        </IconButton>
        <div className="mx-2 h-4 w-px bg-line-2" />
        <Button
          variant="ghost"
          size="sm"
          onClick={actions.toggleCopilot}
          className={cn('gap-1.5', rightTab === 'copilot' && 'bg-white/[0.07] text-fg')}
        >
          <AiSparkle />
          Copilot
        </Button>
        <Button variant="primary" size="sm" className="ml-1.5 px-3" onClick={() => setExportOpen(true)}>
          <Upload />
          Export
        </Button>
      </div>
    </header>
  )
}

function AppMenu() {
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  const setExportOpen = useUI((s) => s.setExportOpen)
  const setAboutOpen = useUI((s) => s.setAboutOpen)
  const updateReady = useUpdates((s) => s.status === 'ready')
  const home = useSession((s) => s.home)
  const recent = useSession((s) => s.recent)
  return (
    <Menu onOpenChange={(open) => open && void refreshRecent()}>
      <MenuTrigger asChild>
        <button
          type="button"
          className="no-drag group flex h-8 items-center gap-2 rounded-lg pr-1.5 pl-1 outline-none transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.07]"
        >
          <LogoMark className="size-[22px] drop-shadow-[0_2px_10px_rgb(214_238_0/0.3)]" />
          <span className="text-sm font-semibold tracking-tight text-fg">{APP_NAME}</span>
          <ChevronDown className="size-3 text-fg-4 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-60">
        <MenuLabel>File</MenuLabel>
        <MenuItem icon={<FilePlus />} shortcut="mod+n" onSelect={actions.home}>
          New project…
        </MenuItem>
        <MenuItem icon={<FolderOpen />} shortcut="mod+o" disabled={!desktop} onSelect={actions.open}>
          Open project…
        </MenuItem>
        <MenuSub icon={<Clock />} label="Open recent">
          {recent.length ? (
            recent.slice(0, 10).map((r) => (
              <MenuItem key={r.path} disabled={!r.exists} onSelect={() => void openProject(r.path)}>
                {r.name}
              </MenuItem>
            ))
          ) : (
            <MenuItem disabled>No recent projects</MenuItem>
          )}
        </MenuSub>
        {!home && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Save />} shortcut="mod+s" onSelect={() => void actions.save()}>
              Save
            </MenuItem>
            <MenuItem icon={<SaveAll />} shortcut="mod+shift+s" onSelect={actions.saveAs}>
              Save as…
            </MenuItem>
            <MenuItem icon={<Download />} shortcut="mod+i" onSelect={actions.importMedia}>
              Import media…
            </MenuItem>
            <MenuItem icon={<Upload />} shortcut="mod+e" onSelect={() => setExportOpen(true)}>
              Export…
            </MenuItem>
            <MenuItem icon={<House />} onSelect={actions.home}>
              Start screen
            </MenuItem>
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={<Keyboard />} shortcut="?" onSelect={() => setShortcutsOpen(true)}>
          Keyboard shortcuts
        </MenuItem>
        {updateReady ? (
          <MenuItem icon={<RefreshCw />} onSelect={() => void installUpdate()}>
            Restart to update
          </MenuItem>
        ) : (
          <MenuItem icon={<RefreshCw />} disabled={!desktop} onSelect={() => void checkForUpdates()}>
            Check for updates…
          </MenuItem>
        )}
        <MenuItem icon={<Info />} onSelect={() => setAboutOpen(true)}>
          About {APP_NAME}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** A downloaded update waiting for a restart — or one on its way. */
function UpdatePill() {
  const status = useUpdates((s) => s.status)
  const version = useUpdates((s) => s.version)
  const progress = useUpdates((s) => s.progress)
  const setAboutOpen = useUI((s) => s.setAboutOpen)
  if (status === 'ready') {
    return (
      <Tip content={`Lumen ${version} is downloaded — restart to install it`} side="bottom">
        <button
          type="button"
          onClick={() => void installUpdate()}
          className="mr-1 flex h-7 items-center gap-1.5 rounded-lg bg-accent/[0.14] px-2.5 text-xs font-medium text-accent-2 outline-none transition-colors hover:bg-accent/[0.22] focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <RefreshCw className="size-3.5" />
          Restart to update
        </button>
      </Tip>
    )
  }
  if (status === 'downloading') {
    return (
      <Tip content={`Downloading Lumen ${version} — it installs when you restart`} side="bottom">
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          className="mr-1 flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-fg-3 tabular-nums outline-none transition-colors hover:bg-white/[0.05] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <ArrowDownToLine className="size-3.5" />
          {Math.round((progress ?? 0) * 100)}%
        </button>
      </Tip>
    )
  }
  return null
}

function ProjectName() {
  const name = useEditor((s) => s.project.name)
  const path = useSession((s) => s.path)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = () => {
    const next = draft.trim()
    if (next && next !== name) dispatch('project.update', { name: next })
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="no-drag h-7 w-48 rounded-md bg-white/[0.06] px-2 text-sm font-medium text-fg shadow-[inset_0_0_0_1px_rgb(214_238_0/0.6)] outline-none"
      />
    )
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          onDoubleClick={() => {
            setDraft(name)
            setEditing(true)
          }}
          className="no-drag group flex h-7 max-w-[220px] items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-2 outline-none transition-colors hover:bg-white/[0.05] hover:text-fg data-[state=open]:bg-white/[0.07] data-[state=open]:text-fg"
        >
          <span className="truncate">{name}</span>
          <ChevronDown className="size-3 shrink-0 text-fg-4" />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem
          icon={<PencilLine />}
          onSelect={() => {
            setDraft(name)
            setEditing(true)
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          icon={<Settings2 />}
          onSelect={() => {
            useUI.getState().clearSelection()
            useUI.getState().setRightTab('inspector')
          }}
        >
          Project settings
        </MenuItem>
        {path && (
          <MenuItem icon={<FolderSearch />} onSelect={() => void desktop?.files.reveal(path)}>
            Show in folder
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<House />} onSelect={actions.home}>
          Close project
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function SaveBadge() {
  const dirty = useDirty()
  const path = useSession((s) => s.path)
  if (!dirty && path) {
    return (
      <Tip content={path}>
        <span className="no-drag flex items-center gap-1 pl-1 text-xs text-fg-4">
          <Check className="size-3" />
          Saved
        </span>
      </Tip>
    )
  }
  return (
    <Tip content={path ? 'Save changes' : 'Save this project to a file'} shortcut="mod+s">
      <button
        type="button"
        onClick={() => void actions.save()}
        className="no-drag flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-fg-3 transition-colors hover:bg-white/[0.06] hover:text-fg"
      >
        <span className="size-1.5 rounded-full bg-accent" />
        {path ? 'Unsaved changes' : 'Not saved'}
      </button>
    </Tip>
  )
}
