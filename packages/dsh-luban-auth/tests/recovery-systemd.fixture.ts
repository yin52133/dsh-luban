import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthManager } from '../src/auth-manager.js'
import { MemoryAudit } from './helpers.js'

const directory = process.argv[3]
assert(directory !== undefined)
const manager = new AuthManager({
  filePath: join(directory, 'users.json'),
  audit: new MemoryAudit(),
  clock: { now: Date.now },
  sessionTtlMs: 60_000,
  maxFailures: 3,
  lockoutMs: 30_000,
  loginRateLimit: 10,
})
await manager.initialize()
try {
  if (process.argv[2] === 'prepare') {
    assert(await manager.createInitialAdmin('王', 'Previous test 2026!'))
    const session = await manager.issueBrowserSession('王', '127.0.0.1')
    await writeFile(join(directory, 'old-token'), session.cookieToken, { flag: 'wx', mode: 0o600 })
  } else if (process.argv[2] === 'verify') {
    assert.deepEqual(await manager.verify('王', 'Recovery test 2026!', '127.0.0.1'), { ok: true })
    assert.equal((await manager.verify('王', 'Previous test 2026!', '127.0.0.1')).ok, false)
    assert.equal(
      await manager.authenticateToken(await readFile(join(directory, 'old-token'), 'utf8')),
      null,
    )
  } else {
    throw new Error('Unknown fixture command')
  }
} finally {
  await manager.close()
}
