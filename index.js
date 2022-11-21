import fs from 'fs'
import fsp from 'fs/promises'
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

const indexes = new Map()

const caches = {
  deflate: new Map(),
  gzip: new Map(),
  br: new Map(),
  identity: new Map()
}

export default function(folder = '', options = {}) {
  const {
    base = '',
    root = path.isAbsolute(folder) ? folder : path.join(process.cwd(), folder),
    index = indexHandler,
    secure = false,
    encodings = secure ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'],
    lastModified = true,
    cache = true,
    notFound = notFoundHandler,
    internalError = internalErrorHandler,
    transform = null
  } = options

  const urlIndex = 1 + (root === folder ? 0 : base.length)

  return (res, req) => {
    res.url = decodeURIComponent(req.getUrl().slice(urlIndex))
    res.ext = path.extname(res.url).slice(1)
    res.accept = req.getHeader('accept')
    !res.ext && index
      ? rewrite(res, req, index(res, req, indexHandler, root))
      : file(res, req)
  }

  async function rewrite(res, req, rewritten) {
    if (rewritten === true)
      return

    if (rewritten === false)
      return file(res, req)

    if (typeof rewritten === 'string')
      return file(res, req, absolute(root, rewritten))

    res.onAborted(() => res.aborted = true)
    try {
      rewritten = await rewritten
      res.aborted || (typeof rewritten === 'string'
        ? file(res, req, absolute(root, rewritten))
        : notFound(res, req, notFoundHandler)
      )
    } catch (error) {
      res.aborted || internalError(res, req, error)
    }
  }

  function file(res, req, file = absolute(root, res.url)) {
    const type = mimes.get(res.ext) || mimes.get(path.extname(file))

    if (file.indexOf(root) !== 0)
      return notFound(res, req, notFoundHandler)

    const range = req.getHeader('range')

    if (range)
      return stream(res, req, file, type, range)

    const encoding = getEncoding(req.getHeader('accept-encoding'), encodings, type)

    cache && caches[encoding].has(file)
      ? send(res, caches[encoding].get(file))
      : read(res, req, file, type, encoding)
  }

  async function read(res, req, file, type, encoding) {
    res.onAborted(() => res.aborted = true)
    let handle

    try {
      handle = await fsp.open(file, 'r')
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
      res.aborted || send(res, x)
    } catch (error) {
      handle && handle.close()
      res.aborted || (error.code === 'ENOENT'
        ? notFound(res, req, notFoundHandler)
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
    res.onAborted(cleanup)

    let stream
      , handle

    try {
      handle = await fsp.open(file, 'r')
      const { size, mtime } = await handle.stat()

      if (res.aborted)
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
        res.aborted || internalError(res, req, error)
        cleanup()
      })
      stream.on('close', () => {
        res.aborted || res.end()
        cleanup()
      })
      stream.on('data', x => {
        if (res.aborted)
          return stream.destroy()

        let lastOffset = res.getWriteOffset()
        const ab = x.buffer.slice(
          x.byteOffset,
          x.byteOffset + x.byteLength
        )

        const [ok, done] = res.tryEnd(ab, total)

        if (done)
          return (stream.destroy(), res.aborted = true)

        if (ok)
          return

        stream.pause()

        res.onWritable(offset => {
          if (res.aborted)
            return cleanup()

          const [ok, done] = res.tryEnd(
            ab.slice(offset - lastOffset),
            total
          )

          done
            ? res.aborted || (stream.destroy(), res.aborted = true)
            : ok
              ? stream.resume()
              : lastOffset = res.getWriteOffset()

          return ok
        })
      })
    } catch (error) {
      res.aborted || (error.code === 'ENOENT'
        ? notFound(res, req, notFoundHandler)
        : internalError(res, req, error)
      )
      cleanup()
    }

    function cleanup() {
      res.aborted = true
      handle && handle.close()
      stream && stream.destroy()
      stream = handle = null
    }
  }

  function indexHandler(res, req, next) {
    res.url.charCodeAt(res.url.length - 1) === 47 && (res.url = res.url.slice(0, -1)) // /
    return cache && indexes.has(res.url)
      ? indexes.get(res.url)
      : findIndex(res, req)
  }

  function findIndex(res, req) {
    const rewrite = res.accept.indexOf('text/html') === 0
      ? indexResolve(res.url, '.html', root)
      : res.accept.indexOf('text/javascript') === 0
      && indexResolve(res.url, '.js', root)

    cache && rewrite && indexes.set(res.url, rewrite)
    return rewrite
  }

}

function indexResolve(url, ext, root) {
  return canRead(absolute(root, url, 'index' + ext))
    ? url + '/index' + ext
    : canRead(absolute(root, url))
    ? url
    : canRead(absolute(root, url + ext)) && url + ext
}

function canRead(x) {
  try {
    return fs.statSync(x).isFile()
  } catch (_) {
    return
  }
}

function absolute(root, url, ...xs) {
  return path.join(root, ...url.split('/'), ...xs)
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

function internalErrorHandler(res, req, error) {
  res.cork(() => {
    res.writeStatus('500 Internal Server Error')
    res.end('Internal Server Error: ' + error.code)
  })
}
