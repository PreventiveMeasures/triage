// Browser stand-in for `node:buffer` — see node-path.js. `isUtf8` backs
// binary-content classification in stasis-core's Node-side tooling only.
export const isUtf8 = () => { throw new Error('node:buffer isUtf8() is not available in the browser bundle') }
