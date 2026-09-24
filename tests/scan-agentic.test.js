import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { ScanPage } from '../ui/scan/page.js'
import { cloneScanFixtures } from '../ui/scan/fixtures.js'

test('Agentic retains ordered prompts through editing, removal, and restart, with at least one field', () => {
  const page = new ScanPage()
  page.source = { bundles: cloneScanFixtures() }
  page.willUpdate(new Map([['source', null]]))
  page._mode = 'agentic'
  page._removePrompt(page._prompts[0].id)
  assert.equal(page._prompts.length, 1)
  // Rendering/focus is exercised in the browser; adding updates the list
  // synchronously before waiting for the next render.
  void page._addPrompt()
  void page._addPrompt()
  assert.equal(page._prompts.length, 3)
  assert.equal(new Set(page._prompts.map(prompt => prompt.id)).size, 3)
  assert.equal(page._promptPlaceholder(1), 'What should the second agent focus on?')
  assert.equal(page._promptPlaceholder(2), 'What should the third agent focus on?')
  page._prompts = page._prompts.map((prompt, index) => ({ ...prompt, text: `Instructions ${index + 1}` }))
  page._removePrompt(page._prompts[1].id)
  page._runScan()
  for (const timer of page._timers) clearTimeout(timer)
  const scan = page._scans[0]
  assert.deepEqual(scan.prompts, ['Instructions 1', 'Instructions 3'])
  page._prompts = []
  page._restartScan(scan)
  assert.deepEqual(page._prompts.map(prompt => prompt.text), scan.prompts)
})
