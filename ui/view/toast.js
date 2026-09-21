let toast = null
let hideTimer = null

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
  clearTimeout(hideTimer)
  node.className = kind
  node.textContent = message
  requestAnimationFrame(() => node.classList.add('visible'))
  hideTimer = setTimeout(() => {
    node.classList.remove('visible')
    hideTimer = null
  }, duration)
}

export function hideToast() {
  if (!toast) return
  clearTimeout(hideTimer)
  hideTimer = null
  toast.classList.remove('visible')
}
