// Browser stand-in for `node:util` — see node-path.js. `parseArgs` backs
// stasis-core's CLI flag parsing only.
export const parseArgs = () => { throw new Error('node:util parseArgs() is not available in the browser bundle') }
