# Contributing

Notes for working on `@royaltieshq/medusa-royalties-hq` in this repository. They cover files that are in the repository but not in the package, so this file isn't in the package either.

This repository receives one commit per release, `Release <version>`, holding that version's tree, so its history is the release history. Issues are switched off here: report problems to Royalties HQ support. A pull request isn't merged here: its change is carried into the next release, and the pull request is closed when that release is out.

## Development

Use Node 22 (`.nvmrc`), 22.22.0 or later: Medusa 2.22 needs it. Run `nvm use` if the shell's default is different.

| Script | What it does |
|---|---|
| `npm run build` | `medusa plugin:build`: compiles the plugin and its admin extensions to `.medusa/server`. |
| `npm run dev` | `medusa plugin:develop`: watch mode, publishing into a local store through yalc. |
| `npm run lint` | `medusa lint`. |
| `npm run typecheck` | `tsc --noEmit` for the server and the admin. |
| `npm run test:unit` | Jest unit tests (`src/**/__tests__/*.unit.spec.ts` and `scripts/__tests__`). |
| `npm run test:integration:modules` | Module integration tests against a local Postgres. |
| `npm run test:integration:http` | Builds, then boots a Medusa app with the plugin loaded from its build, against a fake Royalties HQ. |
| `npm run check:package` | `scripts/check-package.mjs`, run after a build: checks what `npm pack` would ship (every `exports` target present; README, changelog and `LICENSE` included; no tests; no declaration naming a package that isn't a peer dependency). |

```bash
npm run test:unit
DB_HOST=localhost DB_USERNAME=<pg user> DB_PASSWORD=<pg password> npm run test:integration:modules
DB_HOST=localhost DB_USERNAME=<pg user> DB_PASSWORD=<pg password> npm run test:integration:http
```

Use `DB_HOST=localhost`, not `127.0.0.1`: Medusa's test runner turns on SSL whenever the database URL doesn't contain `localhost`, and a plain local Postgres refuses SSL.

No test reaches a real Royalties HQ. Jest's setup file (`integration-tests/setup.js`) refuses any request to a `royaltieshq.com` host before it leaves the machine.

### The package's exports

`exports` in `package.json` lists the public entry points: `/modules/royaltiesHq` (the module, and `ROYALTIES_HQ_MODULE`), `/admin` (resolved under both `require` and `import` by Medusa's admin bundler), `/package.json`, and `/.medusa/server/src/modules/royaltiesHq`, the path Medusa loads the module from when a store lists the plugin. There is no pattern, so nothing else under `.medusa/server` can be imported, and a file that isn't an entry point can change in any release.

`scripts/install-test.sh <tgz> <medusa version>` installs a packed tarball with that version of Medusa into a new temporary project, as a store would (no `--legacy-peer-deps`). It checks the installed Medusa version, runs `scripts/check-exports.cjs` (every entry point resolves and loads, Medusa's own plugin resolution finds the module and the admin build, and a deep import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`), then type-checks `scripts/consumer-fixture/` with TypeScript 5.9.3, `--strict`, and `moduleResolution` `node16` and `bundler`.

```bash
npm run build && npm pack
scripts/install-test.sh royaltieshq-medusa-royalties-hq-<version>.tgz 2.22.3
```

### CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. Its `test` job runs lint, typecheck, the repository check, unit tests, build, package check, then the module and HTTP integration tests, with a Postgres 16 service. Its `install-test` job packs the plugin and runs `scripts/install-test.sh` with Medusa 2.22.3.
