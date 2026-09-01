import { execFile } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = resolve(packageDirectory, '..', '..')
const source = join(packageDirectory, '..', '..', 'tools', 'browser-bridge')
const destination = join(packageDirectory, 'dist', 'browser-bridge')
const templatesSource = join(packageDirectory, 'templates')
const templatesDestination = join(packageDirectory, 'dist', 'templates')
const tsdownEntry = join(repositoryRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs')
const executeFile = promisify(execFile)

await executeFile(process.execPath, [tsdownEntry], {
  cwd: packageDirectory,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024,
})

await Promise.all([
  rm(destination, { recursive: true, force: true }),
  rm(templatesDestination, { recursive: true, force: true }),
])
await Promise.all([
  mkdir(destination, { recursive: true }),
  mkdir(templatesDestination, { recursive: true }),
])
await cp(source, destination, {
  recursive: true,
  filter: (path) => {
    const normalized = path.replaceAll('\\', '/')
    return (
      !normalized.includes('/.venv/') &&
      !normalized.endsWith('/.venv') &&
      !normalized.includes('/tests/') &&
      !normalized.endsWith('/tests') &&
      !normalized.includes('/__pycache__/') &&
      !normalized.endsWith('/__pycache__') &&
      !normalized.endsWith('.pyc')
    )
  },
})
await cp(templatesSource, templatesDestination, { recursive: true })
