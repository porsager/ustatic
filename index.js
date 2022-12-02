import fs from 'fs'
import fsp from 'fs/promises'
import mimes, { compressable } from './mimes.js'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'node:util'

const state = ustatic.state = Symbol('ustatic')

const compressors = {
  identity: null,
  gzip: promisify(zlib.gzip),
  deflate: promisify(zlib.deflate),
  br: promisify(zlib.brotliCompress)
}

const streamingCompressors = {
  identity: null,
  gzip: zlib.createGzip,
  deflate: zlib.createDeflate,
  br: zlib.createBrotliCompress
}

const indexes = new Map()

const caches = {
  deflate: new Map(),
  gzip: new Map(),
  br: new Map(),
  identity: new Map()
}

export default function ustatic(folder = '', options = {}) {
  const {
    base = '',
    root = path.isAbsolute(folder) ? folder : path.join(process.cwd(), folder),
    index = indexHandler,
    secure = false,
    compressions = secure ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'],
    lastModified = true,
    etag = true,
    cache = true,
    minStreamSize = 512 * 1024,
    maxCacheSize = 128 * 1024,
    minCompressSize = 1280,
    notFound = notFoundHandler,
    internalError = internalErrorHandler,
    transform = null
  } = options

  const urlIndex = root === folder ? 0 : base.length

  return (res, req) => {
    res.hasOwnProperty(state) || (res[state] = getState(req))
    !res[state].ext && index
      ? rewrite(res, req, index(res, req, indexHandler, root))
      : file(res, req)
  }

  function getState(req) {
    const url = decodeURIComponent(req.getUrl().slice(urlIndex))
        , encoding = req.getHeader('accept-encoding')
        , accept = req.getHeader('accept')
        , range = req.getHeader('range')
        , ext = path.extname(url).slice(1)

    return { url, accept, encoding, range, ext }
  }

  async function rewrite(res, req, rewritten) {
    if (rewritten === true)
      return

    if (rewritten === false)
      return file(res, req)

    if (typeof rewritten === 'string') {
      res[state].ext = path.extname(rewritten).slice(1)
      return file(res, req, absolute(root, rewritten))
    }

    rewritten
      ? file(res, req, absolute(root, rewritten))
      : notFound(res, req, notFoundHandler)
  }

  function file(res, req, file = absolute(root, res[state].url)) {
    const type = mimes.get(res[state].ext) || mimes.get(path.extname(file))

    if (file.indexOf(root) !== 0)
      return notFound(res, req, notFoundHandler)

    if (res[state].range)
      return stream(res, req, file, type, res[state].range, {})

    const compressor = compressions && compressions.length
      ? getEncoding(res[state].encoding, compressions, type)
      : null

    cache && caches[compressor || 'identity'].has(file)
      ? send(res, caches[compressor || 'identity'].get(file))
      : read(res, req, file, type, compressor)
  }

  async function read(res, req, file, type, compressor) {
    res.onAborted(() => res.aborted = true)
    let handle

    try {
      handle = await fsp.open(file, 'r')
      const stat = await handle.stat()

      if (stat.size < minCompressSize)
        compressor = null

      if (stat.size >= minStreamSize)
        return stream(res, req, file, type, '', { handle, stat, compressor })

      const x = {
        path: file,
        mtime: stat.mtime,
        bytes: await handle.readFile(),
        compressor,
        type
      }

      handle.close()
      transform && await transform(x)

      if (compressor)
        x.bytes = await compressors[compressor](x.bytes)

      cache && stat.size < maxCacheSize && caches[compressor || 'identity'].set(file, x)
      res.aborted || send(res, x)
    } catch (error) {
      handle && handle.close()
      res.aborted || (error.code === 'ENOENT' || error.code === 'EISDIR'
        ? notFound(res, req, notFoundHandler)
        : internalError(res, req, error)
      )
    }
  }

  function send(res, { path, bytes, type, mtime, compressor }) {
    res.cork(() => {
      res.writeHeader('Connection', 'keep-alive')
      lastModified && res.writeHeader('Last-Modified', mtime.toUTCString())
      etag && res.writeHeader('ETag', createEtag(mtime, bytes.length, compressor))
      type && res.writeHeader('Content-Type', type)
      compressor && res.writeHeader('Content-Encoding', compressor)
      res.end(bytes)
    })
  }

  function createEtag(mtime, size, weak) {
    return (weak ? 'W/' : '') + '"' + Math.floor(mtime.getTime() / 1000).toString(16) + '-' + size.toString(16) + '"'
  }

  async function stream(res, req, file, type, range, { handle, stat, compressor }) {
    res.onAborted(cleanup)

    let stream

    try {
      handle || (handle = await fsp.open(file, 'r'))
      const { size, mtime } = stat || (await handle.stat())

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


      stream = handle.createReadStream({ start, end })

      if (compressor)
        stream = stream.pipe(streamingCompressors[compressor]())

      stream.on('error', error)
            .on('close', close)
            .on('data', compressor ? writeData : tryData)

      res.cork(() => {
        range ? res.writeStatus('206 Partial Content') : res.writeHeader('Accept-Ranges', 'bytes')
        res.writeHeader('Connection', 'keep-alive')
        res.writeHeader('Last-Modified', mtime.toUTCString())
        res.writeHeader('ETag', createEtag(mtime, size, compressor))
        compressor && res.writeHeader('Content-Encoding', compressor)
        range && res.writeHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size)
        type && res.writeHeader('Content-Type', type)
      })

      compressor && res.onWritable(() => {
        stream.resume()
        return true
      })

      function error(x) {
        res.aborted || internalError(res, req, x)
        cleanup()
      }

      function close() {
        res.aborted || res.end()
        cleanup()
      }

      function writeData(x) {
        res.aborted
          ? cleanup()
          : res.write(x) || stream.pause()
      }

      function tryData(x) {
        if (res.aborted)
          return cleanup()

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
            ? cleanup()
            : ok
              ? stream.resume()
              : lastOffset = res.getWriteOffset()

          return ok
        })
      }
    } catch (error) {
      res.aborted || (error.code === 'ENOENT' || error.code === 'EISDIR'
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
    const url = res[state].url
    url.charCodeAt(url.length - 1) === 47 && (res[state].url = url.slice(0, -1)) // /
    return cache && indexes.has(url)
      ? indexes.get(url)
      : findIndex(res, req)
  }

  function findIndex(res, req) {
    const url = res[state].url
    if (canRead(absolute(root, url)))
      return url

    const rewrite = res[state].accept.indexOf('text/html') === 0
      ? indexResolve(res, url, '.html', root)
      : res[state].accept === '*/*' && indexResolve(res, url, '.js', root)

    if (!rewrite)
      return url

    res.writeStatus('301 Moved Permanently')
    res.writeHeader('Location', rewrite)
    res.end()
    return true
  }

}

function indexResolve(res, url, ext, root) {
  return canRead(absolute(root, url, 'index' + ext))
    ? url + '/index' + ext
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
    return

  const accepted = parseAcceptEncoding(x, supported)
  let compressor
  for (const x of accepted) {
    if (x.type in compressors) {
      compressor = x.type === 'identity' ? null : x.type
      break
    }
  }
  return compressable.has(type) && compressor
}

function parseAcceptEncoding(x, compressions = []) {
  return (x || '').split(',')
    .map(x => (x = x.split(';q='), { type: x[0].trim(), q: parseFloat(x[1] || 1) }))
    .filter(x => x.q !== 0 && compressions.indexOf(x.type) !== -1)
    .sort((a, b) => a.q === b.q
      ? compressions.indexOf(a.type) - compressions.indexOf(b.type)
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
