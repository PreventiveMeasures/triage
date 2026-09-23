import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

test('the vault overlay waits for mode detection, follows mode changes, and cancels local unlocks on exit', async (t) => {
  let decideMode
  const modeReady = new Promise((resolve) => { decideMode = resolve })
  let enabled = true, local = true, unlocked = false
  let onVaultChange
  let metadataReads = 0, wipes = 0
  let unlockSignal
  t.mock.module('../client/index.js', { namedExports: {
    isManagedUiMode: () => !local,
    isPasskeyEnvironmentSupported: () => true,
    isEncryptionEnabled: () => { metadataReads++; return enabled },
    isUnlocked: () => unlocked,
    onVaultStateChange: (fn) => { onVaultChange = fn },
    unlockEncryption: ({ signal }) => {
      unlockSignal = signal
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve(false), { once: true }) })
    },
    wipeAllVaultData: () => { wipes++; return Promise.resolve() },
  } })
  t.mock.module('../ui/view/sidebar.js', { namedExports: { ensureClientMode: () => modeReady } })
  // Minimal DOM event targets; exercise the real controller and handlers.
  // Chromium regressions separately check the painted overlay and navigation.
  class Element extends EventTarget {
    hidden = false
    disabled = false
    focusCount = 0
    setAttribute() {}
    focus() { this.focusCount++ }
  }
  const button = new Element(), error = new Element(), wipe = new Element()
  const overlay = new Element()
  overlay.querySelector = (selector) => ({ button, '.lock-overlay-error': error, '.lock-overlay-wipe': wipe })[selector]
  const document = new EventTarget()
  let mounted = false
  document.createElement = () => overlay
  document.body = { append: () => { mounted = true } }
  const previousDocument = globalThis.document
  globalThis.document = document
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  })
  await import('../ui/view/lock-overlay.js')
  await setImmediate()
  assert.equal(mounted, false, 'an unresolved mode never prompts for a local vault')
  assert.equal(metadataReads, 0)
  decideMode()
  await setImmediate()
  assert.equal(mounted, true, 'offline local fallback still offers passkey unlock')
  assert.equal(overlay.hidden, false)
  const readsBeforeManaged = metadataReads
  local = false
  await onVaultChange()
  await setImmediate()
  assert.equal(overlay.hidden, true, 'managed mode is usable with an enabled, locked local vault')
  assert.equal(metadataReads, readsBeforeManaged, 'managed mode never consults local vault metadata')

  const switchMode = async (isLocal) => {
    local = isLocal
    document.dispatchEvent(new Event('managed-client-mode-change'))
    await setImmediate()
  }
  await switchMode(true)
  assert.equal(mounted, true)
  assert.equal(overlay.hidden, false)
  assert.equal(button.focusCount, 2)
  button.dispatchEvent(new Event('click'))
  assert.equal(unlockSignal.aborted, false)
  await switchMode(false)
  assert.equal(overlay.hidden, true, 'switching back to managed removes the local overlay')
  assert.equal(unlockSignal.aborted, true, 'an in-flight local credential prompt is cancelled')
  wipe.dispatchEvent(new Event('click', { cancelable: true }))
  await setImmediate()
  assert.equal(wipes, 0, 'a stale hidden control cannot wipe local data in managed mode')

  await switchMode(true)
  assert.equal(overlay.hidden, false)
  unlocked = true
  await onVaultChange()
  assert.equal(overlay.hidden, true)
  unlocked = false
  await onVaultChange()
  assert.equal(overlay.hidden, false, 'locking the local vault still protects the local surface')
  enabled = false
  await onVaultChange()
  assert.equal(overlay.hidden, true)
})
