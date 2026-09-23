import { ArrowLeft, Play, Wrench } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { McpServerState, McpTool } from '@shared/integrations'
import { AiSparkle } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/input'
import { callTool, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { JobOutcome } from './parts'
import { missingFields, SchemaForm, schemaDefaults, type JsonSchema } from './SchemaForm'

export function ToolList({ server, onPick }: { server: McpServerState; onPick: (tool: McpTool) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const tools = server.tools.filter((t) => !q || `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(q))
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">
          Tools <span className="ml-1 font-normal text-fg-4 tabular">{server.tools.length}</span>
        </h3>
        {server.tools.length > 6 && <SearchInput value={query} onChange={setQuery} placeholder="Filter tools" className="w-52" />}
      </div>
      <div className="space-y-1">
        {tools.map((tool) => (
          <button
            key={tool.name}
            type="button"
            onClick={() => onPick(tool)}
            className="group/tool flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-white/[0.045] focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Wrench className="mt-0.5 size-3.5 shrink-0 text-fg-4 group-hover/tool:text-accent-2" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium text-fg-2 group-hover/tool:text-fg">{tool.title ?? tool.name}</span>
                {tool.title && <span className="truncate font-mono text-2xs text-fg-4">{tool.name}</span>}
              </div>
              {tool.description && <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-fg-3">{tool.description}</p>}
            </div>
            <Play className="mt-0.5 size-3.5 shrink-0 text-fg-4 opacity-0 transition-opacity group-hover/tool:opacity-100" />
          </button>
        ))}
        {!tools.length && <p className="px-3 py-6 text-center text-sm text-fg-4">{server.tools.length ? 'No tools match.' : 'This server doesn’t offer any tools.'}</p>}
      </div>
    </div>
  )
}

export function ToolRunner({ server, tool, onBack }: { server: McpServerState; tool: McpTool; onBack: () => void }) {
  const schema = (tool.inputSchema ?? {}) as JsonSchema
  const [values, setValues] = useState<Record<string, unknown>>(() => schemaDefaults(schema))
  const [jobId, setJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const job = useIntegrations((s) => (jobId ? s.jobs[jobId] : undefined))
  const missing = missingFields(schema, values)
  const running = starting || job?.status === 'running'

  const run = async () => {
    setStarting(true)
    try {
      const started = await callTool(server.config.id, tool.name, values)
      setJobId(started.id)
    } catch (err) {
      toast.error(`Couldn’t run ${tool.title ?? tool.name}`, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-xs text-fg-3 transition-colors hover:text-fg">
        <ArrowLeft className="size-3.5" /> All tools
      </button>
      <div className="mb-5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-md font-semibold tracking-tight text-fg">{tool.title ?? tool.name}</h3>
          <span className="font-mono text-2xs text-fg-4">{tool.name}</span>
        </div>
        {tool.description && <p className="mt-1 max-w-prose text-sm leading-relaxed whitespace-pre-line text-fg-3">{tool.description}</p>}
      </div>
      <SchemaForm schema={schema} values={values} onChange={setValues} />
      <div className="mt-5 flex items-center gap-3">
        <Button variant="ai" size="lg" disabled={running || missing.length > 0} onClick={run} className={cn('min-w-36')}>
          <AiSparkle className="!size-4 [&_path]:fill-current" />
          {running ? 'Running…' : 'Run tool'}
        </Button>
        {missing.length > 0 && <span className="text-xs text-fg-4">Fill in {missing.join(', ')}</span>}
      </div>
      {job && (
        <div className="mt-6 border-t border-line pt-5">
          <JobOutcome job={job} />
        </div>
      )}
    </div>
  )
}
