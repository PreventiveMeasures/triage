// Scans: `<deepview-scan-page>` and the local/E2E `<local-scan-page>` around
// it. An esbuild entry that view/scan-load.js imports by a runtime string when
// Scans first opens, so neither view.js nor client-managed.js carries it;
// built with them, it shares their lit and client state.
import './scan/page.js'
import './view/local-scan-page.js'
