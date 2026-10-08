import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { formatBytes } from '../ui/view/format.js'
import { formatBytes as formatByteSize } from '../ui/scan/metrics.js'

test('view sizes read in KiB and MiB like the scan page, and stay null when missing', () => {
  for (const n of [0, 1023, 1024, 3645, 1_048_576, 4_827_136, 1_073_741_824]) assert.equal(formatBytes(n), formatByteSize(n), String(n))
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(3645), '3.6 KiB')
  assert.equal(formatBytes(4_827_136), '4.6 MiB')
  // Callers hide a size chip on null rather than show a placeholder.
  for (const missing of [null, undefined, Number.NaN, '12']) assert.equal(formatBytes(missing), null)
})
