// The sidebar's repaint on a vault-state change, against the real vault and
// storage modules. `wipeAllVaultData` fires the change before it removes the
// OPFS report and bundle dirs. A repaint started by that change lists reports
// through a dir handle the wipe then removes. In the browser that listing
// rejected with NotFoundError, unhandled, before the dialog's
// `location.reload()`. The repaint here is the listing `renderSidebar` does.

/* eslint-disable require-await -- the OPFS mock mirrors the async
   browser API surface; its bodies are synchronous by design. */
import './_polyfills.js'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'

const NOT_FOUND = 'A requested file or directory could not be found at the time an operation was processed.'

// The OPFS surface storage.js and the wipe use. As in Chromium, a removed
// dir's handle stays in its holder's hands, and it rejects every operation
// after the removal. `listingWaits` (when set) holds a listing until it
// resolves, so the listing iterates after the wipe has removed the dir.
function createOpfsMock() {
  const dirs = new Map()
  const removals = new Map()
  let listingWaits = null
  function makeDirHandle(dir) {
    const live = () => {
      if (dir.removed) throw new DOMException(NOT_FOUND, 'NotFoundError')
    }
    return {
      kind: 'directory',
      getFileHandle: async (name) => {
        live()
        if (!dir.files.has(name)) throw new DOMException(NOT_FOUND, 'NotFoundError')
        return { kind: 'file', getFile: async () => new Blob([dir.files.get(name)]) }
      },
      removeEntry: async (name) => {
        live()
        if (!dir.files.delete(name)) throw new DOMException(NOT_FOUND, 'NotFoundError')
      },
      entries: async function* () {
        await listingWaits
        live()
        for (const [name] of dir.files) yield [name, { kind: 'file' }]
      },
    }
  }
  const root = {
    getDirectoryHandle: async (name, { create = false } = {}) => {
      if (!dirs.has(name)) {
        if (!create) throw new DOMException(NOT_FOUND, 'NotFoundError')
        dirs.set(name, { files: new Map(), removed: false })
      }
      return makeDirHandle(dirs.get(name))
    },
    removeEntry: async (name) => {
      const dir = dirs.get(name)
      if (!dir) throw new DOMException(NOT_FOUND, 'NotFoundError')
      dir.removed = true
      dirs.delete(name)
      removals.get(name)?.()
    },
  }
  return {
    dirs,
    storage: { getDirectory: async () => root },
    seed(dirName, fileName) {
      dirs.set(dirName, { files: new Map([[fileName, new Uint8Array([1])]]), removed: false })
    },
    // Resolves once `dirName` is removed; until then, a listing waits.
    holdListingsUntilRemoved(dirName) {
      listingWaits = new Promise((resolve) => { removals.set(dirName, resolve) })
    },
    release() {
      listingWaits = null
      removals.clear()
    },
  }
}

const opfs = createOpfsMock()
navigator.storage = opfs.storage

const vault = await import('../client/passkey-vault.js')
const { listFiles } = await import('../client/storage.js')
const { repaintOnVaultChange } = await import('../ui/view/sidebar-vault-repaint.js')

const REPORTS_DIR = 'deepview-reports'
const USER_ID_KEY = 'deepview.passkey.userId'
const VAULT_KEY = 'deepview.passkey.v1'
const CLEAN_DISABLE_KEY = 'deepview.passkey.cleanDisable'

// The orphaned-passkey dialog's state before "Wipe and continue": a user id
// with no vault metadata, and a report on disk.
function seedOrphanedVault() {
  globalThis.localStorage.setItem(USER_ID_KEY, new Uint8Array(16).fill(7).toBase64({ alphabet: 'base64url', omitPadding: true }))
  opfs.seed(REPORTS_DIR, 'report.json')
  opfs.holdListingsUntilRemoved(REPORTS_DIR)
}

function cleanUp(off) {
  off()
  opfs.release()
  for (const key of [USER_ID_KEY, VAULT_KEY, CLEAN_DISABLE_KEY]) globalThis.localStorage.removeItem(key)
}

describe('sidebar repaint on a vault-state change', () => {
  it('the wipe\'s own change, if repainted, lists a dir the wipe has removed (the reported NotFoundError)', async () => {
    seedOrphanedVault()
    // The listener the sidebar had: repaint on every change. Each outcome is
    // taken as it settles, so this test leaves no unhandled rejection.
    const listings = []
    const off = vault.onVaultStateChange(() => {
      listings.push(listFiles().then(() => null, (err) => err))
    })
    try {
      await vault.wipeAllVaultData({ refuseIfEnabled: true })
      assert.equal(listings.length, 1)
      const err = await listings[0]
      assert.equal(err?.name, 'NotFoundError')
      assert.equal(err.message, NOT_FOUND)
    } finally {
      cleanUp(off)
    }
  })

  it('starts no repaint for the wipe\'s own change, so nothing touches the removed dir', async () => {
    seedOrphanedVault()
    let repaints = 0
    const off = repaintOnVaultChange(() => {
      repaints++
      return listFiles()
    })
    try {
      await vault.wipeAllVaultData({ refuseIfEnabled: true })
      await setImmediate()
      assert.equal(repaints, 0)
      assert.equal(opfs.dirs.has(REPORTS_DIR), false, 'no repaint recreated the reports dir after the wipe')
      assert.equal(vault.isWipingInThisTab(), false)
    } finally {
      cleanUp(off)
    }
  })

  it('still repaints on other changes, leaving a failed repaint to surface', async () => {
    // An enabled, unlocked vault, disabled in this tab: a change no wipe fires.
    globalThis.localStorage.setItem(VAULT_KEY, JSON.stringify({ enabled: true, credentialId: 'c', prfSalt: 's', userId: 'u', rpId: 'localhost', createdAt: 1 }))
    vault.__test__.setSessionKeyForTesting({})
    let repaints = 0
    // A failed repaint's result. A rejection is reported as unhandled when
    // nothing waits on it, so this records whether anything does: awaiting
    // it, `.then` and `.catch` would each call `then`.
    let waitedOn = false
    // eslint-disable-next-line unicorn/no-thenable -- the thenable is the probe
    const failedRepaint = { then: () => { waitedOn = true } }
    const off = repaintOnVaultChange(() => {
      repaints++
      return failedRepaint
    })
    try {
      const { disabled } = await vault.disableEncryption({ migrate: async () => {} })
      assert.equal(disabled, true)
      await setImmediate()
      assert.equal(repaints, 1)
      assert.equal(waitedOn, false, 'the repaint\'s failure is not caught')
    } finally {
      cleanUp(off)
    }
  })
})
