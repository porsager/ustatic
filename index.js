import fs from 'fs/promises'
import mimes, { compressable } from './mimes.js'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'node:util'

const encoders = {
  identity: null,
  gzip: promisify(zlib.gzip),
  deflate: promisify(zlib.deflate),
  br: promisify(zlib.brotliCompress)
}

const caches = {
  deflate: new Map(),
  gzip: new Map(),
  br: new Map(),
  identity: new Map()
}

export default function(folder = '', {
  base = '',
  secure = false,
  encodings = secure ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'],
  index = 'index.html',
  lastModified = true,
  cache = true,
  notFound = notFoundHandler,
  internalError = internalErrorHandler,
  transform = null
} = {}) {
  const indexHandler = typeof index === 'function' && index
  const root = path.isAbsolute(folder) ? folder : path.join(process.cwd(), folder)
  const urlIndex = 1 + (root === folder ? 0 : base.length)

  return function files(res, req) {
    const pathname = req.getUrl().slice(urlIndex)
        , urlExt = path.extname(pathname).slice(1)

    if (!urlExt && indexHandler)
      return indexHandler(res, req)

    const file = path.join(root, ...pathname.split('/'), urlExt ? '' : index)
        , type = mimes.get(urlExt) || mimes.get(path.extname(file))

    if (file.indexOf(root) !== 0)
      return notFound(res, req)

    const range = req.getHeader('range')

    if (range)
      return stream(res, req, file, type, range)

    const encoding = getEncoding(req.getHeader('accept-encoding'), encodings, type)

    cache && caches[encoding].has(file)
      ? send(res, caches[encoding].get(file))
      : read(res, req, file, type, encoding)
  }

  async function read(res, req, file, type, encoding) {
    let aborted
      , handle

    res.onAborted(() => aborted = true)

    try {
      handle = await fs.open(file, 'r')
      const x = {
        path: file,
        mtime: lastModified ? (await handle.stat()).mtime.toUTCString() : null,
        bytes: await handle.readFile(),
        encoding,
        type
      }
      handle.close()
      transform && await transform(x)
      encoding !== 'identity' && (x.bytes = await encoders[encoding](x.bytes))
      cache && caches[encoding].set(file, x)
      aborted || send(res, x)
    } catch (error) {
      handle && handle.close()
      aborted || (error.code === 'ENOENT'
        ? notFound(res, req)
        : internalError(res, req, error)
      )
    }
  }

  function send(res, { bytes, type, mtime, encoding }) {
    res.cork(() => {
      mtime && res.writeHeader('Last-Modified', mtime)
      type && res.writeHeader('Content-Type', type)
      encoding !== 'identity' && res.writeHeader('Content-Encoding', encoding)
      res.end(bytes)
    })
  }

  async function stream(res, req, file, type, range) {
    let aborted
      , stream
      , handle

    res.onAborted(cleanup)

    try {
      handle = await fs.open(file, 'r')
      const { size, mtime } = await handle.stat()

      if (aborted)
        return cleanup()

      const end = parseInt(range.slice(range.indexOf('-') + 1)) || size - 1
      const start = parseInt(range.slice(6, range.indexOf('-')) || size - end - 1)
      const total = end - start + 1

      if (end >= size) {
        res.cork(() => {
          res.writeStatus('416 Range Not Satisfiable')
          res.writeHeader('Content-Range', 'bytes */' + (size - 1))
          res.end('Range Not Satisfiable')
        })
        return cleanup()
      }

      res.cork(() => {
        range ? res.writeStatus('206 Partial Content') : res.writeHeader('Accept-Ranges', 'bytes')
        res.writeHeader('Last-Modified', mtime.toUTCString())
        range && res.writeHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size)
        type && res.writeHeader('Content-Type', type)
      })

      stream = handle.createReadStream({ start, end })
      stream.on('error', error => {
        aborted || internalError(res, req, error)
        cleanup()
      })
      stream.on('close', () => {
        aborted || res.end()
        cleanup()
      })
      stream.on('data', x => {
        if (aborted)
          return stream.destroy()

        let lastOffset = res.getWriteOffset()
        const ab = x.buffer.slice(
          x.byteOffset,
          x.byteOffset + x.byteLength
        )

        const [ok, done] = res.tryEnd(ab, total)

        if (done)
          return (stream.destroy(), aborted = true)

        if (ok)
          return

        stream.pause()

        res.onWritable(offset => {
          if (aborted)
            return cleanup()

          const [ok, done] = res.tryEnd(
            ab.slice(offset - lastOffset),
            total
          )

          done
            ? aborted || (stream.destroy(), aborted = true)
            : ok
              ? stream.resume()
              : lastOffset = res.getWriteOffset()

          return ok
        })
      })
    } catch (error) {
      aborted || (error.code === 'ENOENT'
        ? notFound(res, req)
        : internalError(res, req, error)
      )
      cleanup()
    }

    function cleanup() {
      aborted = true
      handle && handle.close()
      stream && stream.destroy()
      stream = handle = null
    }
  }
}

function getEncoding(x, supported, type) {
  if (!x)
    return 'identity'

  const accepted = parseAcceptEncoding(x, supported)
  let encoding
  for (const x of accepted) {
    if (x.type in encoders) {
      encoding = x.type
      break
    }
  }
  return compressable.has(type) && encoding || 'identity'
}

function parseAcceptEncoding(x, preferred = []) {
  return (x || '').split(',')
    .map(x => (x = x.split(';q='), { type: x[0].trim(), q: parseFloat(x[1] || 1) }))
    .filter(x => x.q !== 0)
    .sort((a, b) => b.q === a.q
      ? preferred.indexOf(a.type) - preferred.indexOf(b.type)
      : b.q - a.q)
}

function notFoundHandler(res) {
  res.cork(() => {
    res.writeStatus('404 Not Found')
    res.end('Not Found')
  })
}

function internalErrorHandler(res) {
  res.cork(() => {
    res.writeStatus('500 Internal Server Error')
    res.end('Internal Server Error')
  })
}
