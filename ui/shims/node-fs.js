// Browser stand-in for `node:fs` — see node-path.js for why these shims
// exist. stasis-core's util.js only destructures realpathSync / statSync
// (symlink + execute-bit checks in its Node-side tooling); neither is on
// a browser-reached path, so both throw.
const stub = (name) => () => { throw new Error(`node:fs ${name}() is not available in the browser bundle`) }
export const realpathSync = stub('realpathSync')
export const statSync = stub('statSync')
