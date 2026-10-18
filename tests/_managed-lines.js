// A managed endpoint's lines of JSON (http-response.ts openLines), as a
// browser reads them off a real listener: its status, headers, and the lines
// it sent, those of one cut short too.
import { Buffer } from 'node:buffer'
import { createServer, request } from 'node:http'
import { brotliDecompressSync, constants } from 'node:zlib'

export async function readLines(t, handler, path, cookie) {
  const server = createServer(handler)
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.close(resolve) }))
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} }, res => {
      const parts = []
      res.on('data', part => { parts.push(part) })
      // One cut short ends in an error, after the lines it sent.
      res.on('error', () => {})
      res.on('close', () => {
        const bytes = Buffer.concat(parts)
        const text = res.headers['content-encoding'] === 'br'
          ? brotliDecompressSync(bytes, { finishFlush: constants.BROTLI_OPERATION_FLUSH }).toString() : bytes.toString()
        const lines = text.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : [] } catch { return [] } })
        resolve({ status: res.statusCode, headers: res.headers, lines, ended: res.complete })
      })
    })
    // One cut short before its first line never sent its head: no status.
    req.on('error', error => {
      if (error.code !== 'ECONNRESET') { reject(error); return }
      resolve({ status: null, headers: {}, lines: [], ended: false })
    })
    req.end()
  })
}
