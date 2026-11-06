# Core bundle fixtures (hand-built)

Hand-built `CoreOrder` fixtures for `resolveBundles`.

Most cases are **grouped bundles**: component lines sharing a `group` id with no parent line. Medusa has no grouped bundles, so its reader never sets `group`; those cases still pin the core's split maths, which the manual compositions (G, H) also use.

## Products

| Variant | Product | Regular price |
|---|---|---|
| `1001` | Book A | £10 |
| `1002` | Book B | £12 |
| `1003` | Book C | £8 |
| `1004` | Tote bag (non-book, unticked) | £5 |
| `1005` | Book A — Paperback | £10 |
| `1006` | Book A — Ebook | £6 |
| `1011` | Crime Collection (legacy), manual composition A+B+C | £25 |
| `1020` | Free sampler | £0 |

## Scenarios

| File | Scenario |
|---|---|
| `A-full-price-bundle.json` | £25 Crime Collection, prices spread by the platform, so the guard holds. Also `price_ratio` and `even` |
| `B-discounted-bundle.json` | The same with a 10% code allocated per component, and 10% commission |
| `C-one-component-refunded.json` | Book B refunded alone: stays with B under platform allocation, pooled over refunded components under `price_ratio` |
| `D-unticked-tote.json` | Book A ×2 plus an unticked tote: the tote is weighted, and its share comes back `included: false` |
| `E-print-ebook.json` | £13 paperback + ebook with the price on the paperback: `price_ratio` gives £8.13/£4.87, `even` gives £6.50/£6.50, and the guard fails |
| `F-full-price-on-one-component.json` | The whole £25 on one book: the guard fails and the fallback is noted |
| `G-legacy-manual-composition.json` | Bundle product with manual composition, fully refunded |
| `H-legacy-manual-multi-quantity.json` | The manual bundle ×2, one of the two refunded |
| `I-multi-quantity-bundle.json` | Bundle quantity 2 plus a standalone Book A |
| `J-jpy-tax-inclusive.json` | JPY (exponent 0), tax-inclusive, guard fails, `price_ratio` over gross, ex-tax and list price |
| `K-unknown-structure.json` | A £0 line beside a priced line with no group: reported, not guessed |

## Format

Money is a decimal string in the order's currency. `__tests__/support/fixtureLoader.ts` parses it to minor units. Line fields that are left out take neutral defaults: no discount, no tax, no group, not a gift card, no recorded regular price.

Each file has `cases`. A case gives the settings that differ from the test defaults, and the expected effective sale lines, refund lines and notes. An expectation lists only the fields it is about. `method` is `bundle.method`, or `null` for an ordinary line, and `bundle` is `bundle.ref`.
