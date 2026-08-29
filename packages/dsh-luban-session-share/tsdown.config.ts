import { defineConfig } from 'tsdown'

const sharedExternals = [/^@deepseek-ai\//u, /^@luban\//u, /^react(?:\/|$)/u]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
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
      banner:
        "window.__ModuleLoader__.load({ id: 'dsh-luban-session-share', factory: (require) => {",
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      sourcemapExcludeSources: false,
    },
  },
])
