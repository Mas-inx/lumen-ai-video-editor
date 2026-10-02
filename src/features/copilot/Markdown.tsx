import { Check, Copy } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The Copilot's replies, rendered from markdown: paragraphs, headings, lists,
 * quotes, tables, code blocks (with a copy button), links (opened in the
 * browser), images, and inline bold, italics, strikethrough and code. Never
 * raw HTML. Streaming text renders fine half-written.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn('space-y-2 [overflow-wrap:anywhere]', className)}>{blocks(text)}</div>
}

// ─── Blocks ──────────────────────────────────────────────────────────────

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: { text: string; depth: number; n?: number }[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'hr' }

const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isTableRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      out.push({ type: 'code', lang: fence[2], code: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({ type: 'h', level: heading[1].length, text: heading[2].replace(/\s*#+\s*$/, '') })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: 'hr' })
      i++
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      out.push({ type: 'table', head, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ type: 'quote', lines: body })
      continue
    }
    const item = LIST.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const items: { text: string; depth: number; n?: number }[] = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (m) {
          items.push({ text: m[3], depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), n: /\d/.test(m[2]) ? parseInt(m[2], 10) : undefined })
          i++
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          // A wrapped line belongs to the item above.
          items[items.length - 1].text += ` ${lines[i].trim()}`
          i++
        } else break
      }
      out.push({ type: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !LIST.exec(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i]) && !/^\s*>/.test(lines[i])) {
      if (isTableRow(lines[i]) && i + 1 < lines.length && isTableRule(lines[i + 1])) break
      para.push(lines[i++])
    }
    if (para.length) out.push({ type: 'p', lines: para })
    else i++
  }
  return out
}

function blocks(text: string) {
  return parseBlocks(text).map((b, i) => {
    switch (b.type) {
      case 'p':
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        )
      case 'h':
        return (
          <p key={i} className={cn('font-semibold text-fg', b.level <= 2 ? 'mt-3 text-[15px]' : 'mt-2 text-sm')}>
            {inline(b.text)}
          </p>
        )
      case 'code':
        return <CodeBlock key={i} lang={b.lang} code={b.code} />
      case 'list':
        return (
          <ul key={i} className="space-y-1">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2" style={{ paddingLeft: it.depth * 14 }}>
                <span className="shrink-0 text-fg-4 tabular select-none">{b.ordered ? `${it.n ?? j + 1}.` : '•'}</span>
                <span className="min-w-0">{inline(it.text)}</span>
              </li>
            ))}
          </ul>
        )
      case 'quote':
        return (
          <blockquote key={i} className="border-l-2 border-line-3 pl-3 text-fg-3">
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </blockquote>
        )
      case 'table':
        return (
          <div key={i} className="overflow-x-auto rounded-lg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {b.head.map((h, j) => (
                    <th key={j} className="border-b border-line px-2.5 py-1.5 text-left font-semibold text-fg">
                      {inline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j} className="border-b border-line/60 last:border-0">
                    {b.head.map((_, k) => (
                      <td key={k} className="px-2.5 py-1.5 align-top">
                        {inline(r[k] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'hr':
        return <hr key={i} className="border-line" />
    }
  })
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-lg bg-black/35 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]">
      <div className="flex h-7 items-center border-b border-line px-2.5 text-[10.5px] text-fg-4">
        <span className="font-mono">{lang || 'text'}</span>
        <CopyButton text={code} className="ml-auto" />
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** A small "copy" button that confirms with a check. */
export function CopyButton({ text, className, label = 'Copy' }: { text: string | (() => string); className?: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cn('grid size-6 place-items-center rounded-md text-fg-4 transition-colors hover:bg-white/[0.07] hover:text-fg-2', className)}
    >
      {copied ? <Check className="size-3.5 text-ok" strokeWidth={2.5} /> : <Copy className="size-3.5" />}
    </button>
  )
}

// ─── Inline ──────────────────────────────────────────────────────────────

// Underscore emphasis only at word edges, so snake_case names (get_project) stay as they are.
const INLINE = /(`[^`]+`)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w))|(~~[^~]+~~)|(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

const safeUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : null)

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent-2 underline decoration-accent/40 underline-offset-2 hover:decoration-accent-2">
      {children}
    </a>
  )
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [whole, code, image, link, bold, strike, italic, url] = m
    if (code) out.push(<code key={k++} className="rounded bg-white/[0.08] px-1 py-px font-mono text-[0.86em] text-fg">{code.slice(1, -1)}</code>)
    else if (image) {
      const [, alt, src] = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(image)!
      const href = safeUrl(src)
      out.push(
        href ? (
          <a key={k++} href={href} target="_blank" rel="noreferrer noopener" className="my-1 block w-fit">
            <img src={href} alt={alt} loading="lazy" className="max-h-56 max-w-full rounded-lg ring-1 ring-white/10" />
          </a>
        ) : (
          alt
        ),
      )
    } else if (link) {
      const [, label, href] = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(link)!
      const safe = safeUrl(href)
      out.push(safe ? <Link key={k++} href={safe}>{inline(label)}</Link> : label)
    } else if (bold) out.push(<strong key={k++} className="font-semibold text-fg">{inline(bold.slice(2, -2))}</strong>)
    else if (strike) out.push(<s key={k++} className="text-fg-4">{inline(strike.slice(2, -2))}</s>)
    else if (italic) out.push(<em key={k++}>{inline(italic.slice(1, -1))}</em>)
    else if (url) out.push(<Link key={k++} href={url}>{url}</Link>)
    else out.push(whole)
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** The web addresses a reply mentions (for link previews), in order, without repeats. */
export function linksIn(text: string): string[] {
  const urls: string[] = []
  for (const m of text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g)) {
    const url = m[1] ?? m[2]
    if (url && !urls.includes(url) && !/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url)) urls.push(url)
  }
  return urls
}
