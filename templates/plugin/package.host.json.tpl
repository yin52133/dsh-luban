{
  "name": __PACKAGE_NAME_JSON__,
  "version": __VERSION_JSON__,
  "description": __DESCRIPTION_JSON__,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "dist/",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md"
  ],
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0",
    "dsh": __DSH_ENGINE_JSON__
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/yin52133/dsh-luban.git",
    "directory": "packages/__PACKAGE_DIRECTORY_NAME__"
  },
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2"
  }
}
