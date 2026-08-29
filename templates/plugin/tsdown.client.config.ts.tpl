import { defineConfig } from 'tsdown'

const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const isClientExternal = (specifier: string): boolean => clientExternals.has(specifier)

export default defineConfig([
  {
    name: __PACKAGE_NAME_JSON__,
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    sourcemap: true,
    clean: true,
    deps: {
      neverBundle: ['@deepseek-ai/cordis'],
    },
  },
  {
    name: `${__PACKAGE_NAME_JSON__}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'dist',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isClientExternal,
      alwaysBundle: (specifier: string): boolean => !isClientExternal(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(__PACKAGE_NAME_JSON__)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
