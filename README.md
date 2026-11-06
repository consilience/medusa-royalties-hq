# Royalties HQ for Medusa

`@royaltieshq/medusa-royalties-hq` is a Medusa v2 plugin that sends a store's book sales to [Royalties HQ](https://royaltieshq.com), where they become royalty statements.

- Each month's sales go to Royalties HQ as one sales snapshot: units and net receipts per book, net of tax, with refunds made after a month's cut-off reported as refunds, and earlier ones taken off the sale.
- No customer data and no tax amounts leave the store.
- Months are sent on a push day you choose, or only when you press Push now (manual mode).
- Any month downloads as a CSV in Royalties HQ's sales import format, to check the figures or to import by hand.

## Requirements

- Medusa `^2.22.0`, on Node 22.22.0 or later (Medusa's own requirement).
- A Royalties HQ account with a Medusa sales connection, and that connection's API token. Royalties HQ shows the token once, when you create the connection.
- Redis locking (Medusa's Locking Module with its Redis provider) when the store runs more than one process (a server and a worker count as two). Medusa's Postgres locking provider is not supported: it can let two pushes of one month through.

## Setup

### 1. Install

```bash
npm install @royaltieshq/medusa-royalties-hq
```

### 2. Configure `medusa-config.ts`

```ts
module.exports = defineConfig({
  // …
  plugins: [{
    resolve: "@royaltieshq/medusa-royalties-hq",
    options: { backendUrl: process.env.MEDUSA_BACKEND_URL },
  }],
})
```

`backendUrl` is the store's public backend URL. The plugin records it when sending is first switched on and refuses to send from anywhere else, so a copy of the store (a staging server restored from a backup, say) never pushes over the live store's months. When the store really moves, confirm the new address on the Royalties HQ page.

### 3. Set the environment

| Variable | |
|---|---|
| `ROYALTIES_HQ_ENCRYPTION_KEY` | Seals the API token in the database. 32 bytes, base64: `openssl rand -base64 32`. Required to enter the token in the admin. |
| `ROYALTIES_HQ_ENCRYPTION_KEY_PREVIOUS` | Optional. The key before a rotation, accepted for opening only. |
| `ROYALTIES_HQ_API_TOKEN` | Optional. Sets the token from the environment instead of the admin. |

### 4. Migrate

```bash
npx medusa db:migrate
```

### 5. Connect in the admin

1. **Settings → Royalties HQ**: enter the API base URL from Royalties HQ (it ends `/api/v1`) and the token, then **Test connection**.
2. Set the store's time zone, the country of sale, the first month to send, the push day and how fees and bundles are treated. Save.
3. **Royalties HQ → Products**: tick the products to report. A variant's ISBN is read from its EAN, barcode, UPC or SKU, as the settings say (by default the first that is an ISBN); a variant can also carry its Royalties HQ product ID instead.
4. Switch sending on.

## Day to day

The **Royalties HQ** page lists each month since the first month to send: what Royalties HQ holds for it, the last attempt and any hold-back note. **Check RHQ status** reads back what Royalties HQ has imported. **Dry run** checks a month with Royalties HQ without storing it. **CSV** downloads a month.

A month counts an order when its payment is fully captured. An order paid in a month Royalties HQ has already imported is reported in the next open month, and the snapshot says so. Refunds by the month's cut-off reduce its sales; later ones go into the month they fall in.

## Licence

PolyForm Shield 1.0.0. See [LICENSE](LICENSE).
