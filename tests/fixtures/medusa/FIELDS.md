# Medusa order fixtures: field list

Captured from Medusa 2.22.3 with one call per order:

```ts
query.graph({ entity: "order", fields: FIELDS, filters: { id } })
```

No customer, email, address or billing field is requested. `<nn>-<slug>.order-changes.json` holds
`query.graph({ entity: "order_change", fields: ["*", "actions.*"], filters: { order_id } })` for the same order.

`query.graph` never rejected a field: unknown paths are silently dropped. Requested but absent from every result:
`payment_status`, `fulfillment_status` (computed only by the admin order routes), `gift_card_*`, `refundable_amount`,
`refunded_total`, `paid_total`, `pending_difference` at order level (they live under `summary.*`),
and `items.item_total` / `item_subtotal` / `item_tax_total`.

## Value types before JSON serialisation

| Paths | Type in memory | In the JSON |
|---|---|---|
| Order, item, shipping-method, adjustment, tax-line totals (`total`, `subtotal`, `tax_total`, `discount_total`, `unit_price`, `amount`, `rate`, ...) and `items.quantity`, `items.detail.*_quantity`, `summary.*` | `BigNumber` | number (via `toJSON`) |
| Every `raw_*` | plain `{ value: string, precision: 20 }` | same |
| Payment-module amounts (`payment_collections.*amount`, `payments.amount`, `captures.amount`, `refunds.amount`) | JS `number` | number |
| `created_at`, `captured_at`, `canceled_at`, ... | `Date` | ISO string |

## FIELDS

```
id
display_id
status
currency_code
created_at
updated_at
canceled_at
version
region_id
sales_channel_id
is_draft_order
payment_status
fulfillment_status
metadata
summary.*
total
raw_total
subtotal
raw_subtotal
tax_total
raw_tax_total
discount_total
raw_discount_total
discount_tax_total
raw_discount_tax_total
shipping_total
raw_shipping_total
shipping_subtotal
raw_shipping_subtotal
shipping_tax_total
raw_shipping_tax_total
shipping_discount_total
raw_shipping_discount_total
item_total
raw_item_total
item_subtotal
raw_item_subtotal
item_tax_total
raw_item_tax_total
item_discount_total
raw_item_discount_total
original_total
raw_original_total
original_subtotal
raw_original_subtotal
original_tax_total
raw_original_tax_total
original_item_total
raw_original_item_total
original_item_subtotal
raw_original_item_subtotal
original_item_tax_total
raw_original_item_tax_total
original_shipping_total
raw_original_shipping_total
original_shipping_subtotal
raw_original_shipping_subtotal
original_shipping_tax_total
raw_original_shipping_tax_total
gift_card_total
raw_gift_card_total
gift_card_tax_total
raw_gift_card_tax_total
credit_line_total
raw_credit_line_total
refundable_amount
raw_refundable_amount
refunded_total
raw_refunded_total
paid_total
raw_paid_total
pending_difference
raw_pending_difference
items.id
items.title
items.subtitle
items.quantity
items.raw_quantity
items.is_tax_inclusive
items.is_discountable
items.requires_shipping
items.variant_id
items.product_id
items.variant_sku
items.variant_barcode
items.variant_title
items.product_title
items.product_handle
items.metadata
items.created_at
items.updated_at
items.unit_price
items.raw_unit_price
items.subtotal
items.raw_subtotal
items.total
items.raw_total
items.tax_total
items.raw_tax_total
items.discount_total
items.raw_discount_total
items.discount_tax_total
items.raw_discount_tax_total
items.original_total
items.raw_original_total
items.original_subtotal
items.raw_original_subtotal
items.original_tax_total
items.raw_original_tax_total
items.item_total
items.raw_item_total
items.item_subtotal
items.raw_item_subtotal
items.item_tax_total
items.raw_item_tax_total
items.refundable_total
items.raw_refundable_total
items.refundable_total_per_unit
items.raw_refundable_total_per_unit
items.compare_at_unit_price
items.raw_compare_at_unit_price
items.detail.*
items.adjustments.*
items.tax_lines.*
items.variant.id
items.variant.sku
items.variant.ean
items.variant.upc
items.variant.barcode
items.variant.metadata
shipping_methods.id
shipping_methods.name
shipping_methods.amount
shipping_methods.raw_amount
shipping_methods.is_tax_inclusive
shipping_methods.shipping_option_id
shipping_methods.subtotal
shipping_methods.raw_subtotal
shipping_methods.total
shipping_methods.raw_total
shipping_methods.tax_total
shipping_methods.raw_tax_total
shipping_methods.discount_total
shipping_methods.raw_discount_total
shipping_methods.original_total
shipping_methods.raw_original_total
shipping_methods.tax_lines.*
shipping_methods.adjustments.*
payment_collections.id
payment_collections.status
payment_collections.currency_code
payment_collections.amount
payment_collections.raw_amount
payment_collections.authorized_amount
payment_collections.raw_authorized_amount
payment_collections.captured_amount
payment_collections.raw_captured_amount
payment_collections.refunded_amount
payment_collections.raw_refunded_amount
payment_collections.completed_at
payment_collections.created_at
payment_collections.updated_at
payment_collections.payments.id
payment_collections.payments.amount
payment_collections.payments.raw_amount
payment_collections.payments.currency_code
payment_collections.payments.provider_id
payment_collections.payments.captured_at
payment_collections.payments.canceled_at
payment_collections.payments.created_at
payment_collections.payments.data
payment_collections.payments.captures.*
payment_collections.payments.refunds.*
payment_collections.payments.refunds.refund_reason.*
returns.*
returns.items.*
transactions.*
credit_lines.*
fulfillments.id
fulfillments.created_at
fulfillments.shipped_at
fulfillments.canceled_at
fulfillments.items.*
```
