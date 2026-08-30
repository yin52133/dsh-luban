import { createHash } from 'node:crypto'
import {
  HUD_RUNTIME_ARTIFACT_SCHEMA,
  hudRuntimeArtifactBundleSha256,
  type HudRuntimeArtifactFile,
  type HudRuntimeArtifactIdentity,
} from '../src/runtime-artifact.js'
import { HUD_BUILD_PROVENANCE_SCHEMA, type HudBuildProvenance } from '../src/build-provenance.js'

const fixtureFile = Object.freeze({
  relativePath: 'dist/index.js',
  sha256: createHash('sha256').update('hud-test-runtime-artifact').digest('hex'),
  bytes: 25,
}) satisfies HudRuntimeArtifactFile

const fixtureFiles = Object.freeze([fixtureFile])

export const HUD_RUNTIME_ARTIFACT_FIXTURE = Object.freeze({
  schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
  packageName: 'dsh-luban-hud',
  packageVersion: '0.1.0-test',
  entrypoint: 'dist/index.js',
  files: fixtureFiles,
  bundleSha256: hudRuntimeArtifactBundleSha256(fixtureFiles),
}) satisfies HudRuntimeArtifactIdentity

export const HUD_BUILD_PROVENANCE_FIXTURE = Object.freeze({
  schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
  gitHead: 'a'.repeat(40),
  buildId: '12345678-1234-4123-8123-123456789abc',
  dirty: false,
  runtime: 'repo-dist',
  manifestSha256: 'b'.repeat(64),
  runtimeBundleSha256: HUD_RUNTIME_ARTIFACT_FIXTURE.bundleSha256,
}) satisfies HudBuildProvenance
