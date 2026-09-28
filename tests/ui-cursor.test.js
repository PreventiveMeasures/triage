import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { it } from 'node:test'
import { SCAN_PAGE_STYLES } from '../ui/scan/page-styles.js'

it('UI styles never opt into the pointer cursor', async () => {
  const root = new URL('../ui/', import.meta.url)
  const files = (await readdir(root, { recursive: true })).filter(file => /\.(?:css|[cm]?[jt]s|html|svg)$/u.test(file)).toSorted()
  assert.ok(files.length > 0)
  const violations = []
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8')
    // Cover stylesheets, embedded CSS, style objects, and direct DOM assignments.
    const pointer = /\bcursor\s*['"]?\s*[:=]\s*['"`]?\s*pointer\b|\bsetProperty\(\s*['"]cursor['"]\s*,\s*['"]pointer['"]/giu
    for (const match of source.matchAll(pointer)) {
      violations.push(`ui/${file}:${source.slice(0, match.index).split('\n').length}`)
    }
  }
  assert.deepEqual(violations, [], `Use the default cursor instead of pointer:\n${violations.join('\n')}`)
})

it('scan creation links override native link cursors and underlines inside their shadow root', () => {
  const anchor = SCAN_PAGE_STYLES.cssText.match(/(?:^|[}])\s*a\s*\{([^}]+)\}/u)?.[1]
  assert.ok(anchor, 'scan links need their own anchor reset; the document reset cannot cross a shadow root')
  assert.match(anchor, /\bcursor:\s*default\s*;/u)
  assert.match(anchor, /\btext-decoration:\s*none\s*;/u)
})
