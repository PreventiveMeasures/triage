import { getItem, onAfterHydrate, removeItem, setItem } from './secure-storage.js'

const KEY = 'deepview.scan.access'
const listeners = new Set()
function notify() { for (const listener of listeners) listener() }

export function hasSavedScanAccess() { return getItem(KEY) != null }

export function readSavedScanAccess(server) {
  try {
    const saved = JSON.parse(getItem(KEY))
    const provider = saved?.provider === 'moonshotai' ? 'moonshot' : saved?.provider
    // Saved credentials are bound to the exact service, including its path.
    if (!server || saved?.server !== server || typeof saved.deepview !== 'string' || !saved.deepview.trim()
        || ![null, 'anthropic', 'openai', 'moonshot', 'openrouter'].includes(provider) || typeof saved.token !== 'string') return null
    return { ...saved, provider }
  } catch { return null }
}

export async function saveScanAccess({ server, deepview, provider, token }) {
  await setItem(KEY, JSON.stringify({ server, deepview, provider, token }))
  notify()
}

export async function forgetScanAccess() {
  await removeItem(KEY)
  notify()
}

export function onSavedScanAccessChange(listener) {
  listeners.add(listener)
  const unsubscribe = onAfterHydrate(listener)
  return () => { listeners.delete(listener); unsubscribe() }
}
