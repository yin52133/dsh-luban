import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = fileURLToPath(import.meta.resolve('tsdown/run'))

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entry], {
    cwd: packageDirectory,
    stdio: 'inherit',
    windowsHide: true,
  })
  child.once('error', reject)
  child.once('close', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(`tsdown failed (${signal ?? String(code)})`))
  })
})
