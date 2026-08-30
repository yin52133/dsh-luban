import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HUD_BUILD_PROVENANCE_SCHEMA,
  inspectHudBuildProvenance,
  parseHudBuildProvenance,
} from '../src/build-provenance.js'
import {
  HUD_RUNTIME_ARTIFACT_SCHEMA,
  hudRuntimeArtifactBundleSha256,
  inspectHudRuntimeArtifact,
  parseHudRuntimeArtifactIdentity,
  type HudRuntimeArtifactFile,
} from '../src/runtime-artifact.js'

const directories = new Set<string>()
const GIT_HEAD = 'a'.repeat(40)
const BUILD_ID = '12345678-1234-4123-8123-123456789abc'

async function temporaryPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'luban-hud-artifact-'))
  directories.add(root)
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'dsh-luban-hud', version: '0.1.0' })}\n`,
    'utf8',
  )
  return root
}

async function writeArtifact(root: string, relativePath: string, source: string): Promise<void> {
  const target = join(root, ...relativePath.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, source, 'utf8')
}

function fileIdentity(relativePath: string, source: string): HudRuntimeArtifactFile {
  return Object.freeze({
    relativePath,
    sha256: createHash('sha256').update(source).digest('hex'),
    bytes: Buffer.byteLength(source, 'utf8'),
  })
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('HUD runtime artifact identity', (): void => {
  it('hashes the entrypoint and its recursive relative JavaScript import closure', async (): Promise<void> => {
    const root = await temporaryPackage()
    const sources = {
      'dist/chunk.js': 'import("./nested/dynamic.js");\nexport const chunk = true;\n',
      'dist/index.js':
        'import "./chunk.js";\nconst marker = true; import"./inline.js";\nexport{value}from"./nested/value.js";\nexport const entry = marker;\n',
      'dist/inline.js': 'export const inline = true;\n',
      'dist/nested/dynamic.js': 'export const dynamic = true;\n',
      'dist/nested/value.js': 'export const value = 1;\n',
    } as const
    for (const [relativePath, source] of Object.entries(sources)) {
      await writeArtifact(root, relativePath, source)
    }

    const identity = inspectHudRuntimeArtifact(pathToFileURL(join(root, 'dist', 'index.js')))
    const files = Object.entries(sources)
      .map(([relativePath, source]): HudRuntimeArtifactFile => fileIdentity(relativePath, source))
      .sort((left, right): number =>
        left.relativePath === right.relativePath
          ? 0
          : left.relativePath < right.relativePath
            ? -1
            : 1,
      )

    expect(identity).toEqual({
      schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
      packageName: 'dsh-luban-hud',
      packageVersion: '0.1.0',
      entrypoint: 'dist/index.js',
      files,
      bundleSha256: hudRuntimeArtifactBundleSha256(files),
    })
    expect(Object.isFrozen(identity)).toBe(true)
    expect(Object.isFrozen(identity.files)).toBe(true)
    expect(identity.files.every((file): boolean => Object.isFrozen(file))).toBe(true)
  })

  it('rejects path escape, symlink, non-literal dynamic import, and package drift', async (): Promise<void> => {
    const escapedRoot = await temporaryPackage()
    await writeArtifact(escapedRoot, 'dist/index.js', 'import "../outside.js";\n')
    await writeArtifact(escapedRoot, 'outside.js', 'export const outside = true;\n')
    expect((): void => {
      inspectHudRuntimeArtifact(pathToFileURL(join(escapedRoot, 'dist', 'index.js')))
    }).toThrow('relative import escapes dist')

    const dynamicRoot = await temporaryPackage()
    await writeArtifact(dynamicRoot, 'dist/index.js', 'const path = "./chunk.js"; import(path);\n')
    expect((): void => {
      inspectHudRuntimeArtifact(pathToFileURL(join(dynamicRoot, 'dist', 'index.js')))
    }).toThrow('non-literal dynamic import')

    const packageRoot = await temporaryPackage()
    await writeArtifact(packageRoot, 'dist/index.js', 'export const entry = true;\n')
    await writeFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: 'another-package', version: '0.1.0' })}\n`,
      'utf8',
    )
    expect((): void => {
      inspectHudRuntimeArtifact(pathToFileURL(join(packageRoot, 'dist', 'index.js')))
    }).toThrow('package identity is invalid')

    const symlinkRoot = await temporaryPackage()
    await writeArtifact(symlinkRoot, 'dist/index.js', 'import "./linked.js";\n')
    await writeArtifact(symlinkRoot, 'dist/target.js', 'export const linked = true;\n')
    try {
      await symlink(join(symlinkRoot, 'dist', 'target.js'), join(symlinkRoot, 'dist', 'linked.js'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    expect((): void => {
      inspectHudRuntimeArtifact(pathToFileURL(join(symlinkRoot, 'dist', 'index.js')))
    }).toThrow('unsafe file')
  })

  it('requires sorted, unique, internally consistent identity metadata', (): void => {
    const index = fileIdentity('dist/index.js', 'entry')
    const chunk = fileIdentity('dist/chunk.js', 'chunk')
    const sorted = [chunk, index]
    const valid = {
      schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
      packageName: 'dsh-luban-hud',
      packageVersion: '0.1.0',
      entrypoint: 'dist/index.js',
      files: sorted,
      bundleSha256: hudRuntimeArtifactBundleSha256(sorted),
    }
    expect(parseHudRuntimeArtifactIdentity(valid)).toEqual(valid)
    expect((): void => {
      parseHudRuntimeArtifactIdentity({ ...valid, files: [index, chunk] })
    }).toThrow('closure identity is invalid')
    expect((): void => {
      parseHudRuntimeArtifactIdentity({ ...valid, bundleSha256: '0'.repeat(64) })
    }).toThrow('closure identity is invalid')
  })
})

describe('HUD loaded build provenance', (): void => {
  it('binds the embedded build identity to the complete dist closure', async (): Promise<void> => {
    const root = await temporaryPackage()
    const source = 'export const entry = true;\n'
    await writeArtifact(root, 'dist/index.js', source)
    const runtime = inspectHudRuntimeArtifact(pathToFileURL(join(root, 'dist', 'index.js')))
    const artifact = fileIdentity('dist/index.js', source)
    const manifest = {
      schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
      gitHead: GIT_HEAD,
      buildId: BUILD_ID,
      dirty: false,
      artifacts: [{ path: 'index.js', sha256: artifact.sha256, bytes: artifact.bytes }],
    }
    const manifestBytes = `${JSON.stringify(manifest)}\n`
    await writeFile(join(root, 'dist', 'build-provenance.json'), manifestBytes, 'utf8')

    expect(
      inspectHudBuildProvenance(pathToFileURL(join(root, 'dist', 'index.js')), runtime, {
        gitHead: GIT_HEAD,
        buildId: BUILD_ID,
      }),
    ).toEqual({
      schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
      gitHead: GIT_HEAD,
      buildId: BUILD_ID,
      dirty: false,
      runtime: 'repo-dist',
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      runtimeBundleSha256: runtime.bundleSha256,
    })
  })

  it('rejects dirty, mismatched, changed, and incomplete distributions', async (): Promise<void> => {
    const root = await temporaryPackage()
    const source = 'export const entry = true;\n'
    await writeArtifact(root, 'dist/index.js', source)
    const runtime = inspectHudRuntimeArtifact(pathToFileURL(join(root, 'dist', 'index.js')))
    const artifact = fileIdentity('dist/index.js', source)
    const manifest = {
      schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
      gitHead: GIT_HEAD,
      buildId: BUILD_ID,
      dirty: true,
      artifacts: [{ path: 'index.js', sha256: artifact.sha256, bytes: artifact.bytes }],
    }
    await writeFile(
      join(root, 'dist', 'build-provenance.json'),
      `${JSON.stringify(manifest)}\n`,
      'utf8',
    )
    expect((): void => {
      inspectHudBuildProvenance(pathToFileURL(join(root, 'dist', 'index.js')), runtime, {
        gitHead: GIT_HEAD,
        buildId: BUILD_ID,
      })
    }).toThrow('clean loaded build')

    await writeFile(
      join(root, 'dist', 'build-provenance.json'),
      `${JSON.stringify({ ...manifest, dirty: false })}\n`,
      'utf8',
    )
    expect((): void => {
      inspectHudBuildProvenance(pathToFileURL(join(root, 'dist', 'index.js')), runtime, {
        gitHead: 'b'.repeat(40),
        buildId: BUILD_ID,
      })
    }).toThrow('clean loaded build')

    await writeArtifact(root, 'dist/untracked.js', 'export const extra = true;\n')
    expect((): void => {
      inspectHudBuildProvenance(pathToFileURL(join(root, 'dist', 'index.js')), runtime, {
        gitHead: GIT_HEAD,
        buildId: BUILD_ID,
      })
    }).toThrow('clean loaded build')
  })

  it('parses exact build diagnostics including dirty builds', (): void => {
    const value = {
      schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
      gitHead: GIT_HEAD,
      buildId: BUILD_ID,
      dirty: false,
      runtime: 'repo-dist',
      manifestSha256: 'b'.repeat(64),
      runtimeBundleSha256: 'c'.repeat(64),
    }
    expect(parseHudBuildProvenance(value)).toEqual(value)
    expect(parseHudBuildProvenance({ ...value, dirty: true })).toEqual({ ...value, dirty: true })
    expect((): void => {
      parseHudBuildProvenance({ ...value, extra: true })
    }).toThrow('build provenance is invalid')
  })
})
