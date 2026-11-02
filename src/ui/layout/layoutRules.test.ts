// @vitest-environment node
/**
 * Static rules of the adaptive layout system (see docs/ADAPTIVE_LAYOUT.md):
 * no device/orientation-based layout, only the semantic container tokens,
 * CSS and JS tokens in sync, safe areas respected, text allowed to grow.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pageFooter, pageHeader, pageMain } from './shell'
import { LAYOUT_REM } from './tokens'


const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) && !path.includes(`${join('src', 'test')}`) ? [path] : []
  })
}

describe('adaptive layout: system rules', () => {
  const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

  it('never decides layout from the device, the screen or the orientation', () => {
    const forbidden = [/\bduo\b/i, /userAgent/, /navigator\.platform/, /\bscreen\.(width|height|orientation)\b/, /orientationchange/, /\(orientation:/, /window\.inner(Width|Height)/, /\bmatchMedia\(/]
    for (const { path, text } of files) for (const pattern of forbidden) expect(text, `${path} matches ${pattern}`).not.toMatch(pattern)
  })

  it('uses only the semantic container tokens, not scattered viewport breakpoints', () => {
    for (const { path, text } of files.filter((f) => f.path.endsWith('.tsx'))) {
      expect(text, path).not.toMatch(/(^|[\s"'`])(sm|md|lg|xl|2xl|min-\[\d+px\]|max-\[\d+px\]):/)
    }
  })

  it('keeps the CSS tokens and the JS tokens identical', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    for (const [name, rem] of Object.entries(LAYOUT_REM)) expect(css, name).toContain(`--container-${name}: ${rem}rem;`)
  })

  it('respects the safe area: viewport-fit=cover, safe-area-aware page shell and sheet', () => {
    const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8')
    expect(html).toMatch(/viewport-fit=cover/)
    expect(html).not.toMatch(/user-scalable=no|maximum-scale/)
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    for (const inset of ['left', 'right', 'top', 'bottom']) expect(css).toContain(`env(safe-area-inset-${inset})`)
    expect(pageHeader).toContain('safe-top')
    expect(pageMain).toContain('page-gutter')
    expect(pageMain).toContain('@container')
    expect(pageFooter).toContain('env(safe-area-inset-bottom)')
  })

  it('lets text grow: no px font sizes outside the measured chart drawings, no truncated figures, and 16px fields on touch screens', () => {
    for (const { path, text } of files.filter((f) => f.path.endsWith('.tsx') && !f.path.includes(join('dashboard', 'charts')))) {
      expect(text, path).not.toMatch(/text-\[\d+px\]/)
    }
    const ui = readFileSync(join(SRC, 'ui', 'dashboard', 'ui.tsx'), 'utf8')
    expect(ui).not.toMatch(/<dd className="[^"]*\btruncate\b[^"]*text-2xl/)
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*input,\s*select,\s*textarea \{\s*font-size: max\(1rem, 16px\);/)
  })
})
