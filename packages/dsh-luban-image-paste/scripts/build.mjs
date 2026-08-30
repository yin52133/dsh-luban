import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = resolve(packageDirectory, '..', '..')
const distributionDirectory = join(packageDirectory, 'dist')
const MAX_ARTIFACTS = 512
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024

async function gitOutput(args) {
  const { stdout } = await executeFile('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

async function runBuild(gitHead, buildId) {
  const entry = fileURLToPath(import.meta.resolve('tsdown/run'))
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: packageDirectory,
      env: {
        ...process.env,
        LUBAN_IMAGE_BUILD_HEAD: gitHead,
        LUBAN_IMAGE_BUILD_ID: buildId,
      },
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`tsdown failed (${signal ?? String(code)})`))
    })
  })
}

async function collectArtifacts(
  directory = distributionDirectory,
  budget = { artifacts: 0, bytes: 0 },
) {
  const entries = await readdir(directory, { withFileTypes: true })
  const artifacts = []
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    const relativePath = relative(distributionDirectory, absolute).split(sep).join('/')
    if (relativePath === 'build-provenance.json') continue
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      artifacts.push(...(await collectArtifacts(absolute, budget)))
      continue
    }
    const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Unable to create image-paste build provenance: unsafe artifact ${relativePath}`,
      )
    }
    if (
      metadata.size < 1 ||
      metadata.size > MAX_ARTIFACT_BYTES ||
      budget.artifacts + 1 > MAX_ARTIFACTS ||
      budget.bytes + metadata.size > MAX_TOTAL_BYTES
    ) {
      throw new Error(
        `Unable to create image-paste build provenance: artifact budget exceeded ${relativePath}`,
      )
    }
    budget.artifacts += 1
    budget.bytes += metadata.size
    const bytes = await readFile(absolute)
    if (bytes.byteLength !== metadata.size) {
      throw new Error(
        `Unable to create image-paste build provenance: artifact changed ${relativePath}`,
      )
    }
    artifacts.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

const headBefore = (await gitOutput(['rev-parse', '--verify', 'HEAD'])).trim().toLowerCase()
const statusBefore = await gitOutput(['status', '--porcelain=v1', '--untracked-files=normal'])
const buildId = randomUUID()
await runBuild(headBefore, buildId)
const statusAfter = await gitOutput(['status', '--porcelain=v1', '--untracked-files=normal'])
const headAfter = (await gitOutput(['rev-parse', '--verify', 'HEAD'])).trim().toLowerCase()
const artifacts = await collectArtifacts()
const statusFinal = await gitOutput(['status', '--porcelain=v1', '--untracked-files=normal'])
const headFinal = (await gitOutput(['rev-parse', '--verify', 'HEAD'])).trim().toLowerCase()

if (
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headBefore) ||
  headAfter !== headBefore ||
  headFinal !== headBefore ||
  artifacts.length === 0
) {
  throw new Error('Unable to create image-paste build provenance: Git HEAD changed during build')
}

await writeFile(
  join(distributionDirectory, 'build-provenance.json'),
  `${JSON.stringify({
    schemaVersion: 'dsh-luban/image-paste-build-provenance/v3',
    gitHead: headBefore,
    buildId,
    dirty: statusBefore.trim() !== '' || statusAfter.trim() !== '' || statusFinal.trim() !== '',
    artifacts,
  })}\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'w' },
)
