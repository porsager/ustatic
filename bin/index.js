#!/usr/bin/env node

/* eslint-disable no-console */

import { Worker, isMainThread, threadId } from 'worker_threads'
import os from 'os'
import path from 'path'
import ustatic from '../index.js'
import uws from 'uWebSockets.js'

const argv = process.argv.slice(2)
    , cwd = process.cwd()
    , cpus = parseInt(argv.find((x, i, xs) => xs[i - 1] === '--threads') || os.cpus().length)
    , folder = argv.find(x => x[0] !== '-') || '.'
    , abs = folder[0] === '/' ? folder : path.join(cwd, folder)
    , port = process.env.PORT || (process.env.SSL_CERT ? 443 : 80)
    , supportsThreads = process.platform === 'linux'

const options = {
  index: argv.find((x, i, xs) => xs[i - 1] === '--index'),
  secure: process.env.SSL_CERT,
  cache: false || !!argv.find(x => x === '--cache')
}

if (supportsThreads && isMainThread) {
  for (let i = 0; i < cpus; i++)
    new Worker(new URL(import.meta.url), { argv }) // eslint-disable-line
} else {
  const app = uws.App()
  app.get('/*', ustatic(abs, options))
  app.listen(port, (token) => {
    if (!token)
      return console.log('Could not open port', port, '@', threadId)

    if (isMainThread || threadId === cpus)
      console.log('Serving', abs === cwd ? './' : abs.replace(cwd + '/', ''), 'on', port, '@', threadId)
  })
}
