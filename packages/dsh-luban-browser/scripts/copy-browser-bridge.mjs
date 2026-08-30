import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = resolve(packageDirectory, '..', '..')
const source = join(packageDirectory, '..', '..', 'tools', 'browser-bridge')
const destination = join(packageDirectory, 'dist', 'browser-bridge')
const templatesSource = join(packageDirectory, 'templates')
const templatesDestination = join(packageDirectory, 'dist', 'templates')
const provenanceDestination = join(packageDirectory, 'dist', 'build-provenance.json')
const tsdownEntry = join(repositoryRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs')
const executeFile = promisify(execFile)
const MAX_BUILD_FILE_BYTES = 16 * 1024 * 1024
const MAX_BUILD_TREE_BYTES = 64 * 1024 * 1024
const MAX_BUILD_FILES = 2048

const gitOutput = async (args) => {
  const { stdout } = await executeFile('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}
const rawShaBefore = await gitOutput(['rev-parse', 'HEAD'])
const rawStatusBefore = await gitOutput(['status', '--porcelain=v1', '--untracked-files=normal'])

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
const tree = await hashDistributionTree(join(packageDirectory, 'dist'))
const rawStatusAfter = await gitOutput(['status', '--porcelain=v1', '--untracked-files=normal'])
const rawShaAfter = await gitOutput(['rev-parse', 'HEAD'])
const gitSha = rawShaBefore.trim().toLowerCase()
if (
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(gitSha) ||
  rawShaAfter.trim().toLowerCase() !== gitSha
) {
  throw new Error('Unable to create browser build provenance: Git HEAD changed during build')
}
const provenance = Object.freeze({
  schemaVersion: 'dsh-luban/browser-build-provenance/v2',
  gitSha,
  dirty: rawStatusBefore.trim() !== '' || rawStatusAfter.trim() !== '',
  treeSha256: tree.sha256,
  fileCount: tree.fileCount,
})
await writeFile(provenanceDestination, `${JSON.stringify(provenance)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'w',
})

async function hashDistributionTree(root) {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const name = relative(root, path).replaceAll('\\', '/')
      if (name === 'build-provenance.json') continue
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`Build output contains a symlink: ${name}`)
      if (metadata.isDirectory()) {
        await visit(path)
      } else if (metadata.isFile()) {
        if (metadata.size > MAX_BUILD_FILE_BYTES) {
          throw new Error(`Build output file exceeds the size limit: ${name}`)
        }
        files.push({ name, path, size: metadata.size })
        if (files.length > MAX_BUILD_FILES) throw new Error('Build output has too many files')
      } else {
        throw new Error(`Build output contains an unsupported entry: ${name}`)
      }
    }
  }
  await visit(root)
  files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_BUILD_TREE_BYTES) throw new Error('Build output exceeds the size limit')
  const digest = createHash('sha256')
  for (const file of files) {
    const contents = await readFile(file.path)
    if (contents.byteLength !== file.size) throw new Error(`Build output changed: ${file.name}`)
    digest.update(file.name, 'utf8')
    digest.update('\0')
    digest.update(String(contents.byteLength), 'ascii')
    digest.update('\0')
    digest.update(contents)
  }
  return Object.freeze({ sha256: digest.digest('hex'), fileCount: files.length })
}
