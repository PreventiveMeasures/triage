import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

class TestDialog {
  static styles = []
  _finish() {}
  disconnectedCallback() {}
}
const asked = []
let answer = null
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog() {} } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchRepositoryItem(repoId, number) { asked.push([repoId, number]); return answer(number) } } })
mock.module('../ui/view/render-finding.js', { namedExports: { renderHighlighted: text => text } })
mock.module('../ui/view/format.js', { namedExports: { flowText: text => `[flowed]${text}` } })
await import('../ui/view/dialogs/repository-item-dialog.js')
const Dialog = customElements.get('repository-item-dialog')

const shown = () => Object.assign(new Dialog(), { repository: { repoId: 7, repo: 'org/repo' } })
const tile = { kind: 'pulls', number: 5, title: 'Fix the chips', author: 'grace', createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 2), closedAt: null, comments: 3,
  labels: [{ name: 'bug', color: 'd73a4a' }], moreLabels: 0, state: 'open', draft: false, mergedAt: null, review: 'approved', checks: 'success', additions: 30, deletions: 4,
  head: 'claude/fix-chips', base: 'main' }

test('an issue or pull request shows what its tile knew at once, then the rest as it is read: its description, what it closes, its commits and files', async () => {
  let read
  answer = () => new Promise(resolve => { read = resolve })
  const dialog = shown()
  dialog.open({ number: 5, preview: tile })
  let text = templateText(dialog.render())
  assert.deepEqual(asked, [[7, 5]])
  assert.match(text, /aria-label=Open[^]*Fix the chips <span class="repo-item-number">#5<\/span>/u)
  assert.match(text, /<strong>grace<\/strong> opened Oct 1, 2026/u)
  assert.match(text, /3 comments[^]*>bug<[^]*<code>claude\/fix-chips<\/code> → <code>main<\/code>[^]*\+30[^]*−4[^]*Approved[^]*Checks passed/u)
  assert.match(text, /role="status">Reading it…/u)
  assert.match(text, /class=primary href=https:\/\/github\.com\/org\/repo\/pull\/5 target="_blank"[^>]*>Open on GitHub</u, 'its link on GitHub')
  read({ ...tile, state: 'merged', mergedAt: Date.UTC(2026, 9, 2), mergedBy: 'ada', body: 'Fixes #3.', bodyShortened: true, moreLinked: 0, commits: 4, files: 2,
    closes: [{ number: 3, title: 'Chips unreadable', state: 'closed', reason: 'completed' }] })
  await setImmediate()
  text = templateText(dialog.render())
  assert.match(text, /aria-label=Merged/u)
  assert.match(text, /merged by <strong>ada<\/strong> Oct 2, 2026/u)
  assert.match(text, /4 commits<\/span><span>2 files changed/u)
  assert.doesNotMatch(text, /Approved/u, 'a review only while open')
  assert.match(text, /<h4>Closes<\/h4>[^]*aria-label=Closed[^]*#3<\/span><span class="repo-item-title">Chips unreadable/u)
  assert.match(text, /\[flowed\]Fixes #3\.[^]*Shortened here; the rest of it is on GitHub\./u)
  assert.doesNotMatch(text, /more, on GitHub/u)
  assert.doesNotMatch(text, /Reading it…/u)
})

test('an issue it names opens in its place, read once, Back returning; one that fails says why', async () => {
  answer = number => number === 3 ? Promise.reject(new Error('GitHub has no issue or pull request of that number here.'))
    : Promise.resolve({ ...tile, body: '', closes: [], moreLinked: 12, commits: 1, files: 1, mergedBy: null })
  asked.length = 0
  const dialog = shown()
  dialog.open({ number: 5, preview: tile })
  await setImmediate()
  assert.doesNotMatch(templateText(dialog.render()), /class="back"/u)
  assert.match(templateText(dialog.render()), /No description\./u)
  assert.match(templateText(dialog.render()), /<h4>Closes<\/h4><p class="repo-item-quiet">12 more, on GitHub<\/p>/u, 'those GitHub has past the first, counted')
  dialog.open({ number: 3, preview: { kind: 'issues', number: 3, title: 'Chips unreadable', state: 'closed', reason: 'completed', labels: [], comments: 0 } })
  await setImmediate()
  let text = templateText(dialog.render())
  assert.match(text, /class="back" aria-label="Back"/u)
  assert.match(text, /Chips unreadable[^]*#3/u)
  assert.match(text, /role="alert">GitHub has no issue or pull request of that number here\./u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/issues\/3/u)
  dialog.back()
  text = templateText(dialog.render())
  assert.match(text, /Fix the chips[^]*#5/u)
  assert.deepEqual(asked, [[7, 5], [7, 3]], 'each read once')
})

test('a session shows who, when and what it did: its pull requests and issues opening in its place, its commits and branches on GitHub, where it ran', () => {
  asked.length = 0
  const session = { id: 'session_A', agents: ['claude'], sessions: ['session_A'], tasks: [], title: 'Code viewer', authors: ['ada'], startedAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 3), state: 'open', pulls: [{ number: 9, title: 'Agents tab', state: 'open', draft: false }, { number: 8, title: 'History', state: 'merged', draft: false }],
    commits: [{ oid: 'c'.repeat(40), title: 'Pushed to main' }], issues: [{ number: 3, title: 'Asked', state: 'closed' }], branches: ['claude/one', 'ada:claude/two'],
    commitCount: 3, additions: 100, deletions: 5 }
  const dialog = shown()
  dialog.open({ session })
  const text = templateText(dialog.render())
  assert.deepEqual(asked, [], 'nothing read: the tab read it all')
  assert.match(text, /aria-label=Claude[^]*<span>Code viewer<\/span>/u)
  assert.match(text, /is-open>Open<\/span>[^]*<strong>ada<\/strong>[^]*Oct 1, 2026 – Oct 3, 2026[^]*3 tasks[^]*\+100[^]*−5/u)
  assert.match(text, /<h4>Pull requests<\/h4>[^]*#9<\/span><span class="repo-item-title">Agents tab[^]*#8<\/span>/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/commit\/c{40}[^]*<code>ccccccc<\/code>/u)
  assert.match(text, /<h4>Issues<\/h4>[^]*#3<\/span><span class="repo-item-title">Asked/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/tree\/claude\/one[^]*href=https:\/\/github\.com\/ada\/repo\/tree\/claude\/two/u, 'a fork\'s branch in its fork')
  assert.match(text, /href=https:\/\/claude\.ai\/code\/session_A[^>]*>Open in Claude Code<[^]*class=primary href=https:\/\/github\.com\/org\/repo\/pull\/9/u)
  dialog.open({ number: 9, preview: { kind: 'pulls', ...session.pulls[0] } })
  assert.deepEqual(asked, [[7, 9]])
  dialog.back()
  assert.match(templateText(dialog.render()), /Open in Claude Code/u)
})
