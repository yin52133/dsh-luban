import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(packageDirectory, '..', '..', 'tools', 'browser-bridge')
const destination = join(packageDirectory, 'dist', 'browser-bridge')
const templatesSource = join(packageDirectory, 'templates')
const templatesDestination = join(packageDirectory, 'dist', 'templates')

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
