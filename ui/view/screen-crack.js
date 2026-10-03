import { createCrackModel } from './screen-crack-model.js'
import screenCrackCSS from './screen-crack.css'

const NS = 'http://www.w3.org/2000/svg'
let effectId = 0

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(NS, tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
  return element
}

function buildOverlay(model) {
  const overlay = document.createElement('div')
  overlay.className = 'screen-crack'
  overlay.setAttribute('aria-hidden', 'true')
  const style = document.createElement('style')
  style.textContent = screenCrackCSS
  const svg = svgElement('svg', { viewBox: `0 0 ${model.width} ${model.height}`, preserveAspectRatio: 'none' })
  svg.classList.add('screen-crack-svg')
  const defs = svgElement('defs')
  const maskId = `screen-crack-mask-${++effectId}`
  const mask = svgElement('mask', {
    id: maskId, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse',
    x: 0, y: 0, width: model.width, height: model.height,
  })
  mask.append(svgElement('rect', { width: model.width, height: model.height, fill: 'black' }))
  defs.append(mask)
  const cracks = svgElement('g')
  const strokes = svgElement('g')
  const shards = model.pieces.map(piece => {
    const points = piece.points.map(point => `${point.x},${point.y}`).join(' ')
    const masked = svgElement('g'), outlined = svgElement('g')
    masked.classList.add('screen-crack-shard')
    outlined.classList.add('screen-crack-shard')
    masked.append(svgElement('polygon', { points, fill: 'white' }))
    const outline = svgElement('polygon', {
      points, fill: 'none', stroke: 'rgb(240 248 255 / .8)', 'stroke-width': 1.1, 'stroke-linejoin': 'round',
    })
    outline.classList.add('screen-crack-outline')
    outlined.append(outline)
    mask.append(masked)
    strokes.append(outlined)
    return { masked, outlined, outline, piece }
  })
  svg.append(defs, cracks, strokes)
  const glass = document.createElement('div')
  glass.className = 'screen-crack-glass'
  // A full current-document URL also works on managed routes with <base href="/">.
  const maskUrl = `${document.URL.split('#')[0]}#${maskId}`
  glass.style.maskImage = `url("${maskUrl}")`
  glass.style.webkitMaskImage = `url("${maskUrl}")`
  const flash = document.createElement('div')
  flash.className = 'screen-crack-flash'
  flash.style.left = `${model.impact.x}px`
  flash.style.top = `${model.impact.y}px`
  overlay.append(style, glass, svg, flash)
  return { overlay, glass, cracks, shards, flash }
}

function drawCracks(group, model, animate) {
  for (const crack of model.cracks) {
    const d = crack.points.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')
    for (const shadow of [true, false]) {
      const path = svgElement('path', {
        d, fill: 'none', stroke: shadow ? 'rgb(0 0 0 / .55)' : 'rgb(232 244 255 / .95)',
        'stroke-width': crack.width + (shadow ? .8 : 0), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      })
      if (shadow) path.setAttribute('transform', 'translate(.5 .7)')
      path.style.strokeDasharray = `${crack.length} ${crack.length}`
      path.style.strokeDashoffset = String(crack.length)
      group.append(path)
      animate(path, [{ strokeDashoffset: String(crack.length) }, { strokeDashoffset: '0' }], {
        duration: crack.duration, delay: crack.delay, easing: 'cubic-bezier(.2,.7,.2,1)',
      })
    }
  }
}

// One shot per page load. The callback changes the theme beneath the glass.
// All animations run at double speed and share a start time so masks and outlines stay synchronized.
export function playScreenCrack(onReveal) {
  const height = window.innerHeight, width = window.innerWidth
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !width || !height || !Element.prototype.animate) {
    onReveal()
    return Promise.resolve()
  }
  const model = createCrackModel(width, height)
  const { overlay, glass, cracks, shards, flash } = buildOverlay(model)
  document.body.append(overlay)
  const start = document.timeline.currentTime
  const animations = []
  const animate = (element, keyframes, options) => {
    const animation = element.animate(keyframes, { fill: 'both', ...options })
    animation.playbackRate = 2
    animation.startTime = start
    animations.push(animation)
    return animation
  }
  let finished = false, revealed = false
  const reveal = () => {
    if (revealed) return
    revealed = true
    onReveal()
  }
  const finish = () => {
    if (finished) return
    finished = true
    window.removeEventListener('resize', finish)
    window.removeEventListener('beforeprint', finish)
    document.removeEventListener('visibilitychange', onVisibility)
    overlay.remove()
    for (const animation of animations) animation.cancel()
    reveal()
  }
  const onVisibility = () => { if (document.hidden) finish() }
  window.addEventListener('resize', finish, { once: true })
  window.addEventListener('beforeprint', finish, { once: true })
  document.addEventListener('visibilitychange', onVisibility)

  drawCracks(cracks, model, animate)
  animate(flash, [
    { opacity: 0, transform: 'translate(-50%, -50%) scale(0)' },
    { opacity: .85, transform: 'translate(-50%, -50%) scale(.8)', offset: .08 },
    { opacity: 0, transform: 'translate(-50%, -50%) scale(2.4)' },
  ], { duration: 600, easing: 'ease-out' })
  animate(cracks, [
    { transform: 'translate(0, 0)' }, { transform: 'translate(-3px, 2px)' },
    { transform: 'translate(3px, -2px)' }, { transform: 'translate(-2px, -2px)' },
    { transform: 'translate(2px, 2px)' }, { transform: 'translate(0, 0)' },
  ], { duration: 450 })
  const crackDone = Math.max(...model.cracks.map(crack => crack.delay + crack.duration))
  const frostDuration = 500
  // Frost develops with the cracks; shards start falling as the last cracks spread.
  const fallStart = Math.max(frostDuration, crackDone * .8)
  animate(glass, [{ opacity: 0 }, { opacity: 1 }], { duration: frostDuration, easing: 'ease-out' })
  // An opacity animation on the overlay would isolate its backdrop, stopping
  // the glass from blurring the page. Use the decorative flash as the clock.
  const themeCue = animate(flash, [{ visibility: 'visible' }, { visibility: 'visible' }], {
    duration: 1, delay: fallStart - 1,
  })
  void themeCue.finished.then(reveal, () => {})
  animate(cracks, [{ opacity: 1 }, { opacity: 0 }], { duration: 450, delay: fallStart, easing: 'ease-out' })
  for (const { masked, outlined, outline, piece } of shards) {
    const delay = fallStart + piece.delay
    const keyframes = [
      { transform: 'translate(0, 0) rotate(0deg)' },
      { transform: `translate(${piece.dx}px, ${piece.dy}px) rotate(${piece.rotation}deg)` },
    ]
    for (const element of [masked, outlined]) {
      animate(element, keyframes, { duration: 1700, delay, easing: 'cubic-bezier(.32,0,.82,.94)' })
    }
    animate(outline, [{ opacity: 0 }, { opacity: 1 }], { duration: 250, delay })
  }
  // Cancellation (resize, printing, hiding the tab) also removes every layer.
  return Promise.all(animations.map(animation => animation.finished)).then(finish, finish)
}
