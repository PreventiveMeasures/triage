import assert from 'node:assert/strict'
import { test } from 'node:test'
import { playScreenCrack } from '../ui/view/screen-crack.js'

test('the effect reveals once, synchronizes the mask, and cleans up on completion or interruption', async t => {
  const motions = []
  class ElementStub extends EventTarget {
    attributes = new Map()
    children = []
    style = {}
    classList = { add: () => {} }
    setAttribute(name, value) { this.attributes.set(name, value) }
    append(...elements) {
      for (const element of elements) { element.parentElement = this; this.children.push(element) }
    }
    remove() {
      const siblings = this.parentElement.children
      siblings.splice(siblings.indexOf(this), 1)
    }
    animate(keyframes, options) {
      let reject, resolve
      const finished = new Promise((done, fail) => { resolve = done; reject = fail })
      const motion = {
        element: this, keyframes, options, finished, resolve,
        cancelled: false,
        cancel() { this.cancelled = true; reject(new Error('Animation cancelled')) },
      }
      motions.push(motion)
      return motion
    }
  }
  const globals = ['window', 'document', 'Element']
  const previous = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  t.after(() => {
    for (const [i, name] of globals.entries()) {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i])
      else delete globalThis[name]
    }
  })
  const document = new EventTarget(), window = new EventTarget()
  Object.assign(window, { innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: false }) })
  Object.assign(document, {
    URL: 'https://example.test/managed/route?test=1#old-hash',
    timeline: { currentTime: 1234 }, body: new ElementStub(),
    createElement: () => new ElementStub(), createElementNS: () => new ElementStub(),
  })
  Object.assign(globalThis, { document, window, Element: ElementStub })
  let reveals = 0
  const onReveal = () => { reveals++ }
  const completed = playScreenCrack(onReveal)
  const overlay = document.body.children[0]
  assert.equal(overlay.attributes.get('aria-hidden'), 'true')
  assert.equal(reveals, 0, 'the old theme stays visible while cracks propagate')
  const glass = overlay.children[1]
  assert.match(glass.style.maskImage, /^url\("https:\/\/example\.test\/managed\/route\?test=1#screen-crack-mask-\d+"\)$/u)
  const mask = overlay.children[2].children[0].children[0]
  assert.equal(mask.attributes.get('width'), '1280', 'HTML and SVG masks use the actual viewport pixels')
  assert.equal(mask.attributes.get('height'), '720')
  assert.ok(motions.every(motion => motion.startTime === 1234), 'all phases share one clock')
  assert.ok(motions.every(motion => motion.element !== overlay), 'the overlay never isolates the glass backdrop')
  const startsAt = motion => (motion.options.delay ?? 0) / motion.playbackRate
  const endsAt = motion => startsAt(motion) + motion.options.duration / motion.playbackRate
  const crackMotions = motions.filter(motion => 'strokeDashoffset' in motion.keyframes[0])
  const lastCrack = Math.max(...crackMotions.map(endsAt))
  const frost = motions.find(motion => motion.element === glass)
  const falls = motions.filter(motion => motion.keyframes.at(-1).transform?.includes('rotate('))
  const firstFall = Math.min(...falls.map(startsAt))
  assert.ok(startsAt(frost) < lastCrack, 'blur develops while cracks are still propagating')
  assert.ok(endsAt(frost) <= firstFall, 'the glass covers the theme change before shards fall')
  assert.ok(firstFall < lastCrack, 'the fall overlaps the end of cracking without a separate blur stage')
  const cue = motions.find(motion => motion.options.duration === 1)
  assert.ok(endsAt(cue) >= endsAt(frost) && endsAt(cue) <= firstFall, 'green is revealed under the glass before the fall')
  cue.resolve()
  await Promise.resolve()
  assert.equal(reveals, 1)
  for (const motion of motions) motion.resolve()
  await completed
  assert.equal(document.body.children.length, 0, 'completion removes glass, cracks, outlines, styles, and flash')
  assert.equal(reveals, 1, 'completion does not replay the theme change')

  for (const interrupt of [
    () => window.dispatchEvent(new Event('resize')),
    () => window.dispatchEvent(new Event('beforeprint')),
    () => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')) },
  ]) {
    document.hidden = false
    motions.length = 0
    reveals = 0
    const interrupted = playScreenCrack(onReveal)
    assert.equal(document.body.children.length, 1)
    interrupt()
    await interrupted
    assert.equal(document.body.children.length, 0)
    assert.equal(reveals, 1, 'an interruption still completes the requested theme selection')
    assert.ok(motions.every(motion => motion.cancelled), 'no animations survive an interruption')
    window.dispatchEvent(new Event('resize'))
    assert.equal(reveals, 1, 'cleanup removes the interruption listeners')
  }
  motions.length = 0
  reveals = 0
  window.matchMedia = () => ({ matches: true })
  await playScreenCrack(onReveal)
  assert.equal(reveals, 1, 'reduced motion unlocks the theme immediately')
  assert.equal(motions.length, 0)
  assert.equal(document.body.children.length, 0)
})
