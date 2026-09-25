import { diff } from '@preventive/diff'
import { classifyDiff } from './diff-color.js'

// Text stays text all the way into Lit; never interpret source as HTML. Binary
// resources are identified by the bundle adapter, not decoded as source code.
export function bundleFileDiff(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return null
  const text = diff(before, after, { format: 'unified', context: 3 })
  return classifyDiff(text) ?? text.split('\n').map(line => ({ text: line, kind: '' }))
}
