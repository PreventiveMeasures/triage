import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BEAM_S, FADE_S, FILE_DOT, IDLE_S, MAX_GAP, MIN_GAP, REMOVE_S, advanceScene, assignColors, changeFile, clusterRadius, createScene, extensionOf, fileChanges,
  layoutScene, moveScene, playCommit, playTimes, playedCommits, sceneBounds, settleCommit, snapScene, treeChanges } from '../ui/view/replay-model.js'

const DAY = 86_400_000
const commit = (sha, at, parents = ['p']) => ({ sha, parents, committedAt: at })

test('the commits played: the latest of those listed with a time, but merges, oldest first', () => {
  const listed = [commit('m', 9 * DAY, ['x', 'y']), commit('d', 8 * DAY), commit('c', 5 * DAY), commit('t', null), commit('b', 3 * DAY), commit('a', 1 * DAY, [])]
  assert.deepEqual(playedCommits(listed, 3).map(item => item.sha), ['b', 'c', 'd'])
  assert.deepEqual(playedCommits(listed, 10).map(item => item.sha), ['a', 'b', 'c', 'd'])
})

test('the commits played keep a commit after its parent, whatever a clock off dates it', () => {
  // c2 committed by a clock behind c1's, its parent.
  const listed = [commit('c2', 5 * DAY, ['c1']), commit('c1', 6 * DAY, ['c0']), commit('x', 4 * DAY), commit('c0', 1 * DAY, [])]
  assert.deepEqual(playedCommits(listed, 10).map(item => item.sha), ['c0', 'x', 'c1', 'c2'])
  assert.deepEqual(playedCommits(listed, 2).map(item => item.sha), ['c1', 'c2'], 'the latest, the parent with its child')
})

test('each commit plays a day a second after the one before, quiet spells skipped, bursts spread', () => {
  const times = playTimes([commit('a', 0), commit('b', DAY / 4), commit('c', DAY / 4 + 60_000), commit('d', 40 * DAY)])
  assert.deepEqual(times, [0, 0.25, 0.25 + MIN_GAP, 0.25 + MIN_GAP + MAX_GAP])
  assert.deepEqual(playTimes([]), [])
})

test('a file\'s kind is its extension, lowercased; one with none, or a dot file, Other\'s', () => {
  assert.deepEqual(['src/App.TSX', 'a/b.test.js', 'Makefile', '.github/.gitignore', 'dir.d/file'].map(extensionOf), ['tsx', 'js', '', '', ''])
})

test('kinds are colored the most counted first, each keeping its color as more are counted, as many as there are colors', () => {
  const colors = assignColors(new Map(), new Map([['js', 5], ['ts', 9], ['', 40], ['md', 5]]), 2)
  assert.deepEqual([...colors], [['ts', 0], ['js', 1]])
  assignColors(colors, new Map([['js', 1], ['ts', 1], ['css', 99], ['md', 50]]), 2)
  assert.deepEqual([...colors], [['ts', 0], ['js', 1]], 'none taken from a kind colored')
  assert.deepEqual([...assignColors(new Map([['ts', 1]]), new Map([['css', 3], ['md', 4]]), 3)], [['ts', 1], ['md', 0], ['css', 2]])
})

test('a commit plays: its files changed as their beams reach them, a little apart, removed files going and then gone with the directories they empty', () => {
  const scene = createScene()
  const ada = { key: 'ada', label: 'Ada' }
  settleCommit(scene, [['src/a.js', 'A'], ['src/lib/b.js', 'A'], ['README.md', 'A']])
  assert.deepEqual([...scene.dirs.keys()], ['', 'src', 'src/lib'])
  assert.equal(scene.users.size, 0, 'nobody beams to files a seek makes')
  playCommit(scene, [ada], [['src/lib/b.js', 'D'], ['src/c.ts', 'A'], ['docs/x.md', 'R', 'README.md']], 10, 0.5)
  assert.deepEqual(fileChanges([['docs/x.md', 'R', 'README.md']]), [['README.md', 'D'], ['docs/x.md', 'A']])
  assert.equal(scene.due.length, 4)
  advanceScene(scene, 10)
  assert.equal(scene.files.get('src/lib/b.js').removed, 10, 'the first change made at once')
  assert.equal(scene.files.has('src/c.ts'), false, 'the next not yet')
  advanceScene(scene, 10.5)
  assert.deepEqual(scene.beams.map(beam => [beam.user.key, beam.file.path, beam.kind]),
    [['ada', 'src/lib/b.js', 'D'], ['ada', 'src/c.ts', 'A'], ['ada', 'README.md', 'D'], ['ada', 'docs/x.md', 'A']])
  advanceScene(scene, 10 + REMOVE_S + 0.5)
  assert.deepEqual([...scene.files.keys()].toSorted(), ['docs/x.md', 'src/a.js', 'src/c.ts'])
  assert.deepEqual([...scene.dirs.keys()].toSorted(), ['', 'docs', 'src'], 'src/lib, emptied, gone')
  assert.equal(scene.beams.length, 0, `beams gone after ${BEAM_S}s`)
  assert.equal(scene.users.has('ada'), true)
  advanceScene(scene, 10 + IDLE_S + FADE_S + 0.1)
  assert.equal(scene.users.has('ada'), false, 'idle, faded and gone')
})

test('a file removed and added back before it is gone stays, and one removed that isn\'t there is none', () => {
  const scene = createScene()
  playCommit(scene, [], [['a.js', 'A']], 0, 0)
  playCommit(scene, [], [['a.js', 'D']], 1, 0)
  playCommit(scene, [], [['a.js', 'M'], ['gone.js', 'D']], 1.2, 0)
  advanceScene(scene, 1.2)
  advanceScene(scene, 5)
  assert.deepEqual([...scene.files.keys()], ['a.js'])
  assert.equal(scene.files.get('a.js').removed, null)
})

test('what makes the files those a commit leaves, once the changes due and its own are made: those missing added, the rest removed, none where the tree was cut', () => {
  const scene = createScene()
  settleCommit(scene, [['a.js', 'A'], ['b.js', 'A'], ['c.js', 'A']])
  playCommit(scene, [], [['d.js', 'A']], 10, 0)
  assert.deepEqual(treeChanges(scene, ['b.js', 'e.js', 'f.js'], false, [['e.js', 'A'], ['a.js', 'D']]), [['f.js', 'A'], ['c.js', 'D'], ['d.js', 'D']])
  assert.deepEqual(treeChanges(scene, ['b.js', 'e.js', 'f.js'], true, [['e.js', 'A'], ['a.js', 'D']]), [['f.js', 'A']])
  advanceScene(scene, 10)
  changeFile(scene, 'b.js', 'D', 11)
  assert.deepEqual(treeChanges(scene, ['b.js'], false), [['b.js', 'A'], ['a.js', 'D'], ['c.js', 'D'], ['d.js', 'D']], 'one going is gone')
})

// Whether two directories' files overlap where the layout places them.
const overlap = (one, other) => Math.hypot(one.tx - other.tx, one.ty - other.ty) < clusterRadius(one.files.length) + clusterRadius(other.files.length) + FILE_DOT

test('the tree is laid out from the root, its directories\' files never on another\'s, each directory beyond its parent\'s files', () => {
  const scene = createScene()
  const paths = ['README.md', 'package.json', ...Array.from({ length: 40 }, (_, at) => `src/view/f${at}.js`), ...Array.from({ length: 12 }, (_, at) => `src/server/s${at}.ts`),
    ...Array.from({ length: 6 }, (_, depth) => `chain/${Array.from({ length: depth + 1 }, (__, at) => `c${at}`).join('/')}/f.js`),
    ...Array.from({ length: 9 }, (_, at) => `packages/p${at}/index.js`), 'test/a.test.js', 'docs/a.md']
  settleCommit(scene, paths.map(path => [path, 'A']))
  layoutScene(scene)
  assert.deepEqual([scene.root.tx, scene.root.ty], [0, 0])
  const dirs = [...scene.dirs.values()]
  for (const [index, one] of dirs.entries()) {
    for (const other of dirs.slice(index + 1)) assert.equal(overlap(one, other), false, `${one.path || '/'} and ${other.path}`)
    if (one.parent) assert.ok(Math.hypot(one.tx - one.parent.tx, one.ty - one.parent.ty) > clusterRadius(one.parent.files.length), one.path)
  }
  // A chain of directories reaches out a step each, not twice as far each.
  const chain = dirs.filter(dir => dir.path.startsWith('chain/'))
  const steps = chain.slice(1).map((dir, at) => Math.hypot(dir.tx - chain[at].tx, dir.ty - chain[at].ty))
  assert.ok(Math.max(...steps) < 2 * Math.min(...steps), String(steps))
})

test('broad, deep trees\' directories are laid out with no two directories\' files on one another, however their shares fall', () => {
  // Seeded trees of 300 files, each as many as seven directories deep, three
  // a directory, as the review that found them overlapping generated.
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed
    const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const scene = createScene()
    settleCommit(scene, Array.from({ length: 300 }, (_, at) => [[...Array.from({ length: 1 + Math.floor(random() * 7) }, () => `d${Math.floor(random() * 3)}`),
      `f${at}.js`].join('/'), 'A']))
    layoutScene(scene)
    const dirs = [...scene.dirs.values()]
    for (const [index, one] of dirs.entries()) {
      for (const other of dirs.slice(index + 1)) assert.equal(overlap(one, other), false, `seed ${seed}: ${one.path || '/'} and ${other.path}`)
    }
  }
})

test('the scene moves toward where it sits, and a replay sought is drawn there at once', () => {
  const scene = createScene()
  settleCommit(scene, [['src/a.js', 'A'], ['lib/b.js', 'A']])
  layoutScene(scene)
  const src = scene.dirs.get('src')
  const before = Math.hypot(src.tx - src.x, src.ty - src.y)
  moveScene(scene, 0.1)
  assert.ok(Math.hypot(src.tx - src.x, src.ty - src.y) < before)
  snapScene(scene)
  assert.deepEqual([src.x, src.y], [src.tx, src.ty])
  const box = sceneBounds(scene)
  assert.ok(box.minX < box.maxX && box.minY < box.maxY)
  assert.equal(Number.isFinite(sceneBounds(createScene()).minX), true, 'the root alone is somewhere')
})

test('those who made a commit fly to its files, stopping short of them, and apart from each other', () => {
  const scene = createScene()
  playCommit(scene, [{ key: 'ada' }, { key: 'grace' }], [['src/a.js', 'A'], ['src/b.js', 'A']], 0, 0)
  advanceScene(scene, 0)
  snapScene(scene)
  for (let frame = 0; frame < 60; frame++) moveScene(scene, 1 / 60)
  const [ada, grace] = [scene.users.get('ada'), scene.users.get('grace')]
  const src = scene.dirs.get('src')
  for (const user of [ada, grace]) assert.ok(Math.hypot(user.x - src.x, user.y - src.y) > clusterRadius(2), user.key)
  assert.ok(Math.hypot(ada.x - grace.x, ada.y - grace.y) > 20)
})
