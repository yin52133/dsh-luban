import { defineConfig } from 'tsdown'

const sharedExternals = [/^@deepseek-ai\//u, /^dsh-luban-core$/u, /^react(?:\/|$)/u]
const buildHead = process.env.LUBAN_HUD_BUILD_HEAD
const buildId = process.env.LUBAN_HUD_BUILD_ID
if (
  buildHead === undefined ||
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(buildHead) ||
  buildId === undefined ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(buildId)
) {
  throw new Error('HUD builds require an injected Git HEAD and build ID')
}
const buildIdentity = {
  __DSH_LUBAN_HUD_BUILD_HEAD__: JSON.stringify(buildHead),
  __DSH_LUBAN_HUD_BUILD_ID__: JSON.stringify(buildId),
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
    define: buildIdentity,
    deps: { neverBundle: sharedExternals },
  },
  {
    entry: { client: 'src/client.ts' },
    outDir: 'dist',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    outExtensions: (): { readonly js: string; readonly dts: string } => ({
      js: '.js',
      dts: '.d.ts',
    }),
    dts: true,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: sharedExternals,
      alwaysBundle: (specifier: string): boolean =>
        !sharedExternals.some((pattern): boolean => pattern.test(specifier)),
    },
    outputOptions: {
      banner: "window.__ModuleLoader__.load({ id: 'dsh-luban-hud', factory: (require) => {",
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      sourcemapExcludeSources: false,
    },
  },
])
