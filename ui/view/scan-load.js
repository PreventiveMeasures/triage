// Scans' own bundle (ui/scan.js): the shared scan page (`<deepview-scan-page>`,
// its model picker, regime editor and report inputs) and the local host's
// `<local-scan-page>`, out of view.js and client-managed.js until Scans opens.
// Both hosts load it here, so through one promise.
import { lazyEntry } from './lazy-entry.js'

const scan = lazyEntry('./scan.js')

export const loadScanPage = () => scan.load()
