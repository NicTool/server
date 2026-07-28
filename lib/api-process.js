import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'

import { etcDir } from './config.js'

const RESTART_DELAY_MS = 1000

/**
 * Runs @nictool/api as a supervised child bound to a TCP port, restarting it if
 * it exits unexpectedly. The alternative in_process mode dispatches through
 * Hapi's inject() instead and never binds a socket.
 */
export class ApiProcess extends EventEmitter {
  constructor({ configDir, host = 'localhost', port }) {
    super()
    this.configDir = configDir
    this.host = host
    this.port = port
    this.child = null
    this.stopping = false
  }

  get url() {
    return `http://${this.host}:${this.port}`
  }

  async start() {
    // import.meta.resolve finds the API wherever npm placed it — hoisted to a
    // workspace root or nested under this package.
    const entry = import.meta.resolve('@nictool/api/server.js')

    this.stopping = false
    this.child = fork(new URL(entry), [], {
      env: {
        ...process.env,
        NICTOOL_CONF_DIR: etcDir(this.configDir),
        NICTOOL_HTTP_HOST: this.host,
        NICTOOL_HTTP_PORT: String(this.port),
      },
      stdio: 'inherit',
    })

    this.child.once('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return

      console.error(`API exited unexpectedly (code=${code} signal=${signal}); restarting`)
      this.emit('exit', code, signal)
      setTimeout(() => {
        this.start().catch((err) => this.emit('error', err))
      }, RESTART_DELAY_MS).unref()
    })

    console.log(`API listening on ${this.url} (pid ${this.child.pid})`)
    this.emit('started', this.child.pid)
    return this.child.pid
  }

  async stop() {
    this.stopping = true
    const child = this.child
    if (!child) return

    await new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill('SIGTERM')
    })
    this.child = null
    this.emit('stopped')
  }
}

export default ApiProcess
