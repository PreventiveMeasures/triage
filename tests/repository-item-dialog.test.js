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
const dependencyAsked = []
let dependencies = () => new Promise(() => {})
mock.module('../ui/view/client-managed.js', { namedExports: { fetchRepositoryItem(repoId, number) { asked.push([repoId, number]); return answer(number) },
  fetchPullDependencies(repoId, number) { dependencyAsked.push([repoId, number]); return dependencies(number) } } })
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
  // Merged by one GitHub no longer names, merged all the same, never closed.
  read = null
  const ghost = shown()
  answer = () => Promise.resolve({ ...tile, state: 'merged', mergedAt: Date.UTC(2026, 9, 2), closedAt: Date.UTC(2026, 9, 2), mergedBy: null, body: '', closes: [], commits: 1, files: 1 })
  ghost.open({ number: 6, preview: { ...tile, number: 6, state: 'merged', mergedAt: Date.UTC(2026, 9, 2), closedAt: Date.UTC(2026, 9, 2) } })
  assert.match(templateText(ghost.render()), /<span>merged Oct 2, 2026<\/span>/u, 'as its tile knew, before it is read')
  await setImmediate()
  assert.match(templateText(ghost.render()), /<span>merged Oct 2, 2026<\/span>/u)
  assert.doesNotMatch(templateText(ghost.render()), /closed Oct/u)
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

test('a pull request changing a lockfile, merged or closed as well as open, shows the package versions new to its lockfiles as they are read, npm\'s opening in its viewer, an update compared', async () => {
  let told
  dependencies = () => new Promise(resolve => { told = resolve })
  answer = () => new Promise(() => {})
  dependencyAsked.length = 0
  const dialog = shown()
  dialog.open({ number: 21, preview: { ...tile, number: 21, state: 'merged', touchesLockfile: true } })
  let text = templateText(dialog.render())
  assert.deepEqual(dependencyAsked, [[7, 21]], 'asked as it opens, what its tile knew enough')
  assert.match(text, /<h4>New dependency versions<\/h4><p class="repo-item-quiet" role="status">Reading its lockfiles…<\/p>/u)
  told({ number: 21, cut: true, lockfiles: [
    { paths: ['package-lock.json'], more: 3, added: [{ name: '@preventive/lockfile', version: '1.0.0', source: 'registry', was: ['1.0.0-alpha.7', '0.9.0'] },
      { name: '@scope/tool', version: '2.0.0', source: 'registry', dev: true }, { name: 'mine', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/org/mine.git' },
      { name: 'left-pad', version: '1.3.0', source: 'registry', was: ['1.3.0'] }, { name: 'ms', version: '2.1.3', source: 'registry', was: ['2.1.3', '2.1.2'] }] },
    { paths: ['gone/package-lock.json'], added: [], more: 0 },
    { paths: ['web/pnpm-lock.yaml', 'web/yarn.lock'], error: 'lockfile-unreadable', detail: 'a yarn.lock of Yarn 2 or later, which is not read' },
  ] })
  await setImmediate()
  text = templateText(dialog.render())
  assert.match(text, /<code>package-lock\.json<\/code>[^]*<span class="repo-item-row"><svg[^]*mine<span class="repo-item-version">@1\.0\.0<\/span>[^]*data-tooltip=git\+ssh:\/\/github\.com\/org\/mine\.git>git</u,
    'one from git unlinked, by where it is from')
  assert.match(text, /<a class="repo-item-row" href=\/npm\/@scope\/tool@2\.0\.0 target="_blank" rel="noopener noreferrer">[^]*@scope\/tool[^]*is-new[^>]*>new<[^]*>dev</u,
    'a package new to its lockfiles tagged new')
  assert.match(text, /<a class="repo-item-row" href=\/npm\/@preventive\/lockfile@1\.0\.0\/compare\/1\.0\.0-alpha\.7 [^>]*>[^]*@1\.0\.0<\/span><\/span>\s*<span class="repo-item-was" [^>]*>from 1\.0\.0-alpha\.7, 0\.9\.0<\/span>/u,
    'an update by the versions it was, compared with the highest of them')
  assert.ok(text.indexOf('@preventive/lockfile@1.0.0') > text.indexOf('@scope/tool@2.0.0'), 'after the packages new to its lockfiles, whatever their names')
  assert.match(text, /href=\/npm\/left-pad@1\.3\.0 target/u, 'one installed from elsewhere alone opens its version, there being no other to compare')
  assert.match(text, /href=\/npm\/ms@2\.1\.3\/compare\/2\.1\.2 /u, 'compared with the highest version it was other than itself')
  assert.doesNotMatch(text, /compare\/(?:1\.3\.0|2\.1\.3)\b/u, 'never with itself')
  const update = text.slice(text.indexOf('@preventive/lockfile'))
  assert.doesNotMatch(update.slice(0, update.indexOf('</li>')), /is-new/u, 'an update is not new')
  assert.match(text, /and 3 more/u)
  assert.doesNotMatch(text, /gone\/package-lock\.json/u, 'a directory none is new to left out')
  assert.match(text, /<code>web\/pnpm-lock\.yaml<\/code>, <code>web\/yarn\.lock<\/code>[^]*role="alert">A lockfile here couldn’t be read: a yarn\.lock of Yarn 2 or later, which is not read</u)
  assert.match(text, /more directories, than are read/u)
})

test('a pull request whose lockfiles add none says so; one changing none, or an issue, shows nothing of them; one failing says why', async () => {
  answer = number => Promise.resolve({ ...tile, number, body: '', closes: [], commits: 1, files: 1, mergedBy: null, touchesLockfile: number === 23 ? null : number !== 26 })
  const replies = { 22: { cut: false, lockfiles: [{ paths: ['yarn.lock'], added: [], more: 0 }] }, 23: { cut: false, lockfiles: [] } }
  dependencies = number => number === 25 ? Promise.reject(new Error('GitHub’s API rate limit has been reached. Try again later.')) : Promise.resolve({ number, ...replies[number] })
  dependencyAsked.length = 0
  const none = shown()
  none.open({ number: 22, preview: { ...tile, number: 22, touchesLockfile: true } })
  templateText(none.render())
  await setImmediate()
  assert.match(templateText(none.render()), /<h4>New dependency versions<\/h4>[^]*None: every version its lockfiles lock, they locked before\./u)
  // Its tile knew nothing of its files (a closed one's): asked once it is read, that it may.
  const maybe = shown()
  maybe.open({ number: 23, preview: { ...tile, number: 23, state: 'closed' } })
  assert.doesNotMatch(templateText(maybe.render()), /New dependency versions/u)
  await setImmediate()
  templateText(maybe.render())
  await setImmediate()
  assert.doesNotMatch(templateText(maybe.render()), /New dependency versions/u, 'it changed none after all')
  const changesNone = shown()
  changesNone.open({ number: 26, preview: { ...tile, number: 26, touchesLockfile: false } })
  await setImmediate()
  assert.doesNotMatch(templateText(changesNone.render()), /New dependency versions/u)
  const failing = shown()
  failing.open({ number: 25, preview: { ...tile, number: 25, touchesLockfile: true } })
  templateText(failing.render())
  await setImmediate()
  assert.match(templateText(failing.render()), /<h4>New dependency versions<\/h4><p class="repo-item-quiet" role="alert">GitHub’s API rate limit has been reached\. Try again later\./u)
  assert.deepEqual(dependencyAsked.map(([, number]) => number), [22, 23, 25])
})

test('a popup\'s read is known as its item\'s latest, for its tile to show; one read later, by a list, it shows in turn', async () => {
  const { knowItems, knownItem } = await import('../ui/view/repository-items.js')
  answer = () => Promise.resolve({ ...tile, number: 40, state: 'merged', mergedAt: Date.UTC(2026, 9, 3), mergedBy: 'ada', body: '', closes: [], commits: 1, files: 1, readAt: 5000 })
  const dialog = shown()
  dialog.open({ number: 40, preview: { ...tile, number: 40 } })
  await setImmediate()
  assert.deepEqual([knownItem(7, 40).item.state, knownItem(7, 40).item.kind, knownItem(7, 40).readAt], ['merged', 'pulls', 5000])
  assert.match(templateText(dialog.render()), /aria-label=Merged/u)
  knowItems(7, [{ ...tile, number: 40, state: 'closed' }], 4000, 'pulls')
  assert.match(templateText(dialog.render()), /aria-label=Merged/u, 'one read before it is no news')
  knowItems(7, [{ ...tile, number: 40, state: 'closed' }], 6000, 'pulls')
  assert.match(templateText(dialog.render()), /aria-label=Closed/u)
})

test('a list\'s later read of a popup\'s item shows as it says, what a list reads none of as its popup read it: whether it changes a lockfile', async () => {
  const { knowItems } = await import('../ui/view/repository-items.js')
  dependencies = () => new Promise(() => {})
  answer = () => Promise.resolve({ ...tile, number: 41, touchesLockfile: true, body: '', closes: [], commits: 1, files: 1, readAt: 5000 })
  const dialog = shown()
  dialog.open({ number: 41, preview: { ...tile, number: 41, touchesLockfile: true } })
  await setImmediate()
  // The closed list, read later: merged, and no word of its lockfiles, which a closed page reads none of.
  knowItems(7, [{ ...tile, number: 41, state: 'merged' }], 6000, 'pulls')
  const text = templateText(dialog.render())
  assert.match(text, /aria-label=Merged/u)
  assert.match(text, /<h4>New dependency versions<\/h4>/u)
})
