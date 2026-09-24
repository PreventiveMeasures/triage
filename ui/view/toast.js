let toast = null
let hideTimer = null
let generation = 0

function ensureToast() {
  if (toast) return toast
  toast = document.createElement('div')
  toast.id = 'app-toast'
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  document.body.append(toast)
  return toast
}

export function showToast(message, { kind = 'info', duration = 5200 } = {}) {
  const node = ensureToast()
  const current = ++generation
  clearTimeout(hideTimer)
  hideTimer = null
  node.className = kind
  node.textContent = message
  requestAnimationFrame(() => { if (generation === current) node.classList.add('visible') })
  // A zero duration stays visible until its operation finishes. The returned
  // dismiss function cannot hide a newer notification that replaced this one.
  const dismiss = () => { if (generation === current) hideToast() }
  if (duration > 0) hideTimer = setTimeout(dismiss, duration)
  return dismiss
}

export function hideToast() {
  generation++
  if (!toast) return
  clearTimeout(hideTimer)
  hideTimer = null
  toast.classList.remove('visible')
}
