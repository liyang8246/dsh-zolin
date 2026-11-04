/**
 * HTML to readable text for the local `web_fetch` tool.
 * @module @liyang8246/dsh-zephyr/web/html
 */

import { gfm } from '@joplin/turndown-plugin-gfm'
import TurndownService from 'turndown'

/** Elements whose text is never page content. */
const OMITTED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'head',
])

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)
turndown.remove(node => OMITTED.has(node.nodeName.toLowerCase()))
turndown.addRule('dropNonVisible', {
  filter(node) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true')
      return true
    const declarations = node.getAttribute('style')?.split(';') ?? []
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(':')
      if (separator === -1)
        return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
      return (property === 'display' && value === 'none')
        || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
    })
  },
  replacement: () => '',
})

/** Named references worth decoding; numeric references are handled separately. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: '\'',
  copy: '©',
  deg: '°',
  divide: '÷',
  emsp: ' ',
  ensp: ' ',
  euro: '€',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  pound: '£',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  thinsp: ' ',
  times: '×',
  trade: '™',
  yen: '¥',
}

/**
 * Decode the character references a fetched page may carry.
 * @param text - text containing references.
 * @returns the decoded text; unknown references stay verbatim.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10_FFFF
        ? String.fromCodePoint(code)
        : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Drop the document head and doctype: neither is page content, and turndown
 * walks a full document's head when given one.
 * @param html - the page HTML.
 * @returns the HTML without its head.
 */
function withoutHead(html: string): string {
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, '')
}

/**
 * Convert an HTML document to Markdown.
 * @param html - the page HTML.
 * @returns GitHub-flavored Markdown.
 */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(withoutHead(html))
}

/**
 * Convert an HTML document to plain text, keeping block boundaries as newlines.
 * @param html - the page HTML.
 * @returns whitespace-normalized text.
 */
export function htmlToText(html: string): string {
  const withoutOpaqueBlocks = withoutHead(html).replace(
    /<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  )
  const withBreaks = withoutOpaqueBlocks.replace(
    /<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table)\s*>/gi,
    '\n',
  )
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
