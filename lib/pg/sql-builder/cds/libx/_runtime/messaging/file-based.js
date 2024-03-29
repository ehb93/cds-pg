const cds = require('../cds')
const LOG = cds.log('messaging')

const path = require('path')
const fs = require('fs').promises

const MessagingService = require('./service.js')

class FileBasedMessaging extends MessagingService {
  async init() {
    this.file = resolve((this.options.credentials && this.options.credentials.file) || '~/.cds-msg-box')
    try {
      await fs.lstat(this.file)
    } catch (e) {
      await fs.writeFile(this.file, '\n')
    }
    cds.once('listening', () => {
      this.startWatching()
    })
    return super.init()
  }

  async emit(event, ...etc) {
    const msg = this.message4(event, ...etc)
    const e = msg.event
    delete msg.event
    await this.queued(lock)(this.file)
    LOG._debug && LOG.debug('Emit', { topic: e, file: this.file })
    try {
      await fs.appendFile(this.file, `\n${e} ${JSON.stringify(msg)}`)
    } catch (e) {
      LOG._debug && LOG.debug('Error', e)
    } finally {
      unlock(this.file)
    }
  }

  startWatching() {
    const watcher = async () => {
      if (!(await touched(this.file, this.recent))) return // > not touched since last check
      // REVISIT: Bad if lock file wasn't cleaned up (due to crashes...)
      if (!(await this.queued(lock)(this.file, 1))) return // > file is locked -> try again next time
      try {
        const content = await fs.readFile(this.file, 'utf8')
        const lines = content.split('\n')
        const other = [] // used to collect non-matching entries
        for (const each of lines) {
          try {
            const match = /^([\s]*)([^\s]+) ({.*)/.exec(each)
            if (match) {
              const [, , topic, jsonString] = match
              const json = JSON.parse(jsonString)
              if (this.subscribedTopics.has(topic)) {
                const event = this.subscribedTopics.get(topic)
                if (!event) return
                super.emit({ event, ...json, inbound: true }).catch(e => LOG._debug && LOG.debug(e))
              } else other.push(each + '\n')
            }
          } catch (e) {
            // ignore invalid messages
          }
        }
        if (other.length < lines.length) await fs.writeFile(this.file, other.join(''))
        this.recent = await touched(this.file)
      } catch (e) {
        LOG._debug && LOG.debug(e)
      } finally {
        unlock(this.file)
      }
    }
    this.watching = setInterval(watcher, this.options.interval || 500)
  }

  disconnect() {
    this.watching = clearInterval(this.watching)
  }
}

const resolve = f => path.resolve(f.replace(/^~/, () => require('os').userInfo().homedir))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lock = async (file, n = 11) => {
  const lock = file + '.lock'
  try {
    while (n--) await fs.lstat(lock).then(() => n && sleep(150))
    return false
  } catch (_) {
    // lock file does not exist -> create it
    await fs.writeFile(lock, 'locked')
    return true
  }
}
const unlock = file => fs.unlink(file + '.lock').catch(() => {})
const touched = (file, t0 = 0) =>
  fs.lstat(file).then(
    ({ ctimeMs: t }) => t > t0 && t,
    () => 0
  )

module.exports = FileBasedMessaging
