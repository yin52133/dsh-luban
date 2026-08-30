import { createHash } from 'node:crypto'
import {
  HUD_RUNTIME_ARTIFACT_SCHEMA,
  hudRuntimeArtifactBundleSha256,
  type HudRuntimeArtifactFile,
  type HudRuntimeArtifactIdentity,
} from '../src/runtime-artifact.js'

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
