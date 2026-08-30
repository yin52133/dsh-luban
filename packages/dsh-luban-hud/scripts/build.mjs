import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const distributionDirectory = join(packageDirectory, 'dist')
const MAX_ARTIFACTS = 512
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
async function runBuild(buildId) {
  const entry = fileURLToPath(import.meta.resolve('tsdown/run'))
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: packageDirectory,
      env: {
        ...process.env,
        // Build metadata is diagnostic only and must not depend on Git state.
        LUBAN_HUD_BUILD_HEAD: '0'.repeat(40),
        LUBAN_HUD_BUILD_ID: buildId,
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
      throw new Error(`Unable to create HUD build provenance: unsafe artifact ${relativePath}`)
    }
    if (
      metadata.size < 1 ||
      metadata.size > MAX_ARTIFACT_BYTES ||
      budget.artifacts + 1 > MAX_ARTIFACTS ||
      budget.bytes + metadata.size > MAX_TOTAL_BYTES
    ) {
      throw new Error(
        `Unable to create HUD build provenance: artifact budget exceeded ${relativePath}`,
      )
    }
    budget.artifacts += 1
    budget.bytes += metadata.size
    const bytes = await readFile(absolute)
    if (bytes.byteLength !== metadata.size) {
      throw new Error(`Unable to create HUD build provenance: artifact changed ${relativePath}`)
    }
    artifacts.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

const buildId = randomUUID()
await runBuild(buildId)
const artifacts = await collectArtifacts()

if (artifacts.length === 0) throw new Error('HUD build produced no artifacts')

await writeFile(
  join(distributionDirectory, 'build-provenance.json'),
  `${JSON.stringify({
    schemaVersion: 'dsh-luban/hud-build-provenance/v1',
    gitHead: '0'.repeat(40),
    buildId,
    dirty: true,
    artifacts,
  })}\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'w' },
)
