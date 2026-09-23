import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'

/**
 * A form for any MCP tool, generated from its JSON Schema: strings, enums,
 * numbers, booleans and string lists get real controls; anything more
 * exotic falls back to a JSON field.
 */

export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  enum?: unknown[]
  default?: unknown
  minimum?: number
  maximum?: number
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  format?: string
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
}

const typeOf = (s: JsonSchema): string => {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null') ?? 'string'
  if (s.type) return s.type
  const alt = s.anyOf ?? s.oneOf
  if (alt?.length) return typeOf(alt.find((a) => a.type !== 'null') ?? alt[0])
  if (s.enum) return 'string'
  if (s.properties) return 'object'
  return 'string'
}

const enumOf = (s: JsonSchema) => s.enum ?? (s.anyOf ?? s.oneOf)?.find((a) => a.enum)?.enum

/** Initial values: schema defaults (and the first choice for required enums); optional fields stay unset. */
export function schemaDefaults(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default
    else if (schema.required?.includes(key) && enumOf(prop)?.length) out[key] = enumOf(prop)![0]
  }
  return out
}

/** Required fields that are still empty. */
export function missingFields(schema: JsonSchema, values: Record<string, unknown>) {
  return (schema.required ?? []).filter((k) => values[k] === undefined || values[k] === '' || (Array.isArray(values[k]) && !(values[k] as unknown[]).length))
}

const LONG_TEXT = /prompt|description|text|script|content|message|caption|instructions|query/i

export function SchemaForm({ schema, values, onChange, className }: { schema: JsonSchema; values: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; className?: string }) {
  const props = Object.entries(schema.properties ?? {})
  const required = new Set(schema.required ?? [])
  // Prompts first, then required fields, then the rest.
  props.sort(([a], [b]) => Number(/prompt/i.test(b)) - Number(/prompt/i.test(a)) || Number(required.has(b)) - Number(required.has(a)))
  const set = (key: string, value: unknown) => {
    const next = { ...values }
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
    onChange(next)
  }
  if (!props.length) return <p className="text-sm text-fg-3">This tool takes no input.</p>
  return (
    <div className={cn('space-y-3.5', className)}>
      {props.map(([key, prop]) => (
        <Field key={key} name={key} schema={prop} required={required.has(key)} value={values[key]} onChange={(v) => set(key, v)} />
      ))}
    </div>
  )
}

function Field({ name, schema, required, value, onChange }: { name: string; schema: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
  const id = useId()
  const type = typeOf(schema)
  const options = enumOf(schema)
  const label = schema.title ?? name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')

  let control
  if (options?.length) {
    const opts = options.map((o) => ({ value: String(o), label: String(o) }))
    // Radix reserves '' — "unset" gets its own sentinel.
    const UNSET = '__unset__'
    control = (
      <Select
        aria-label={label}
        value={value === undefined ? (required ? String(options[0]) : UNSET) : String(value)}
        onChange={(v) => onChange(v === UNSET ? undefined : type === 'number' || type === 'integer' ? Number(v) : v)}
        options={required ? opts : [{ value: UNSET, label: <span className="text-fg-3">Default</span> }, ...opts]}
        className="w-full"
        size="md"
      />
    )
  } else if (type === 'boolean') {
    control = <Switch aria-label={label} checked={Boolean(value ?? schema.default)} onChange={onChange} />
  } else if (type === 'number' || type === 'integer') {
    control = (
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={schema.minimum}
        max={schema.maximum}
        step={type === 'integer' ? 1 : 'any'}
        value={value === undefined ? '' : String(value)}
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
        onChange={(e) => onChange(e.target.value === '' ? undefined : type === 'integer' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
      />
    )
  } else if (type === 'array' && (!schema.items || typeOf(schema.items) === 'string')) {
    control = (
      <Input
        id={id}
        value={Array.isArray(value) ? value.join(', ') : ''}
        placeholder="Comma-separated"
        onChange={(e) => onChange(e.target.value ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined)}
      />
    )
  } else if (type === 'object' || type === 'array') {
    control = <JsonField id={id} value={value} onChange={onChange} />
  } else if (LONG_TEXT.test(name) || (schema.description?.length ?? 0) > 90) {
    control = (
      <textarea
        id={id}
        rows={/prompt|script/i.test(name) ? 4 : 2}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
        className="w-full resize-y rounded-control bg-white/[0.045] px-2.5 py-2 text-sm leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none placeholder:text-fg-4 focus:bg-white/[0.07] focus:shadow-[inset_0_0_0_1px_rgb(214_238_0/0.5),0_0_0_3px_rgb(214_238_0/0.12)]"
      />
    )
  } else {
    control = (
      <Input
        id={id}
        type={schema.format === 'uri' ? 'url' : 'text'}
        value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <div className={cn(type === 'boolean' && 'flex items-start justify-between gap-4')}>
      <div className={cn(type !== 'boolean' && 'mb-1.5')}>
        <label htmlFor={id} className="text-xs font-medium text-fg-2 capitalize">
          {label}
          {required && <span className="ml-0.5 text-ai-2">*</span>}
        </label>
        {schema.description && <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-fg-4">{schema.description}</p>}
      </div>
      {control}
    </div>
  )
}

function JsonField({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <textarea
      id={id}
      rows={3}
      defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
      onBlur={(e) => {
        const text = e.target.value.trim()
        if (!text) return onChange(undefined)
        try {
          onChange(JSON.parse(text))
          e.target.setCustomValidity('')
        } catch {
          e.target.setCustomValidity('Not valid JSON')
          e.target.reportValidity()
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
      placeholder="JSON"
      className="w-full resize-y rounded-control bg-white/[0.045] px-2.5 py-2 font-mono text-xs leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none placeholder:text-fg-4 focus:bg-white/[0.07]"
    />
  )
}
