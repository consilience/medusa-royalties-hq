# Changelog

All notable changes to `@royaltieshq/medusa-royalties-hq` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [semantic versioning](https://semver.org/).

## [0.1.2] - 2026-11-06

### Changed

- The README says how refunds are reported.

### Removed

- An unused script from `package.json`.

## [0.1.1] - 2026-11-05

### Changed

- The package is now `@royaltieshq/medusa-royalties-hq`. It was first published as `@royaltieshq/medusa-plugin`. If you installed that name, uninstall it, install this one and change `resolve` in `medusa-config.ts`.

## [0.1.0] - 2026-11-05

The first release.

### Added

- Monthly sales snapshots sent to Royalties HQ: units and net receipts per book, net of tax, with refunds, and no customer data.
- Automatic pushes on a chosen push day, or manual mode, where nothing is sent until a person pushes a month.
- Dry run, Push now and Check RHQ status on the Royalties HQ page, with each month's status and hold-back notes.
- A CSV download of any month in Royalties HQ's sales import format.
- Product selection, ISBN source, Royalties HQ product IDs and bundle splits per variant.
- Late sales: an order paid in a month already imported is reported in the next open month, and counted in the snapshot's summary.
- The API token sealed at rest with `ROYALTIES_HQ_ENCRYPTION_KEY`, write-only in the admin.
- A deployment guard: only the store address recorded when sending was switched on may send.
