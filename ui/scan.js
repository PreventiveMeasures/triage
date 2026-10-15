// Scans: the shared scan page (`<deepview-scan-page>`) and the local/E2E
// host's `<local-scan-page>` around it, as an esbuild entry point of its own.
// `view/scan-load.js` imports it by a runtime string the first time Scans
// opens, from the landing's Scan button or Manage's Scans page, so neither
// view.js nor client-managed.js carries it. Built with them, it takes lit and
// the client state from the same chunks, and so the same instances.
import './scan/page.js'
import './view/local-scan-page.js'
