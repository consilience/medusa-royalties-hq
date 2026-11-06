import { line, order } from "../../__tests__/support/builders";
import type { CoreOrder, CoreRefund } from "../../types";
import { inferUnlinedRefunds } from "../unlined";

// The rules for refunds with no lines,
// which every Medusa refund is: money only, with no
// link to a return.

let refundSeq = 0;
function unlined(cash: bigint, createdAt = "2026-08-20T10:00:00Z"): CoreRefund {
  refundSeq += 1;
  return {
    id: `ref_${String(refundSeq).padStart(3, "0")}`,
    createdAt,
    lines: [],
    shipping: { amount: 0n, tax: 0n },
    unallocatedAmount: cash,
  };
}

const run = (o: CoreOrder) => inferUnlinedRefunds(o);

describe("inferUnlinedRefunds: an amount that names one line", () => {
  it("returns whole units when the amount is k units at the line's unit price", () => {
    const book = line({ quantity: 3, originalUnitPrice: 1000n });
    const r = unlined(1000n);
    const out = run(order({ lines: [book], refunds: [r] }));
    expect(out.order.refunds).toEqual([
      {
        id: r.id,
        createdAt: r.createdAt,
        lines: [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }],
        shipping: { amount: 0n, tax: 0n },
      },
    ]);
    expect(out.notes).toEqual([
      {
        kind: "inferred_from_amount",
        orderId: "order_1",
        refundId: r.id,
        createdAt: r.createdAt,
      },
    ]);
  });

  it("compares cash, tax included, and splits it by the line's recorded tax", () => {
    // Tax-exclusive: 3 × 10.00 + 6.00 tax charged 36.00, 12.00 a unit.
    const book = line({ quantity: 3, originalUnitPrice: 1000n, tax: 600n });
    const out = run(order({ lines: [book], refunds: [unlined(1200n)] }));
    expect(out.order.refunds[0]!.lines).toEqual([
      { lineId: book.id, quantity: 1, amount: 1000n, tax: 200n },
    ]);
  });

  it("puts the amount on the order's basis when prices include tax", () => {
    // Tax-inclusive: 3 × 12.00 with 6.00 tax inside; one unit is 12.00
    // on the basis, of which 2.00 tax.
    const book = line({ quantity: 3, originalUnitPrice: 1200n, tax: 600n });
    const out = run(
      order({ taxesIncluded: true, lines: [book], refunds: [unlined(1200n)] }),
    );
    expect(out.order.refunds[0]!.lines).toEqual([
      { lineId: book.id, quantity: 1, amount: 1200n, tax: 200n },
    ]);
  });

  it("returns the whole line when the amount is all the line has left", () => {
    // 10.00 off a 2 × 10.00 line after a 10.00 refund took one unit back.
    const book = line({ quantity: 3, originalUnitPrice: 1000n });
    const other = line({ originalUnitPrice: 4000n });
    const first = unlined(2000n, "2026-08-20T10:00:00Z");
    const second = unlined(1000n, "2026-08-21T10:00:00Z");
    const out = run(order({ lines: [book, other], refunds: [first, second] }));
    expect(out.order.refunds.map((r) => r.lines)).toEqual([
      [{ lineId: book.id, quantity: 2, amount: 2000n, tax: 0n }],
      [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }],
    ]);
  });

  it("matches nothing when the unit price is no whole number of minor units", () => {
    // 3 for 10.00 is no number of pennies each, so no amount is one of them.
    const book = line({ quantity: 3, originalUnitPrice: 333n, discountTotal: -1n });
    const other = line({ originalUnitPrice: 5000n });
    const r = unlined(333n);
    const out = run(order({ lines: [book, other], refunds: [r] }));
    expect(out.order.refunds).toEqual([r]);
    expect(out.notes).toEqual([]);
  });

  it("matches nothing when the amount is more units than the line has left", () => {
    const book = line({ quantity: 2, originalUnitPrice: 1000n });
    const other = line({ originalUnitPrice: 5000n });
    const first = unlined(1000n, "2026-08-20T10:00:00Z");
    const second = unlined(2000n, "2026-08-21T10:00:00Z");
    const out = run(order({ lines: [book, other], refunds: [first, second] }));
    expect(out.order.refunds[1]).toEqual(second);
  });

  it("takes the same product at the same unit price as one candidate, in line order", () => {
    const a1 = line({ variantId: "v1", originalUnitPrice: 1000n });
    const a2 = line({ variantId: "v1", originalUnitPrice: 1000n });
    const b = line({ originalUnitPrice: 5000n });
    const out = run(order({ lines: [a1, a2, b], refunds: [unlined(2000n)] }));
    expect(out.order.refunds[0]!.lines).toEqual([
      { lineId: a1.id, quantity: 1, amount: 1000n, tax: 0n },
      { lineId: a2.id, quantity: 1, amount: 1000n, tax: 0n },
    ]);
  });

  it("refunds the shipping when the amount is the shipping's", () => {
    const book = line({ originalUnitPrice: 1000n });
    const r = unlined(600n);
    const out = run(
      order({
        lines: [book],
        shipping: { amount: 500n, tax: 100n },
        refunds: [r],
      }),
    );
    expect(out.order.refunds).toEqual([
      {
        id: r.id,
        createdAt: r.createdAt,
        lines: [],
        shipping: { amount: 500n, tax: 100n },
      },
    ]);
    expect(out.notes.map((n) => n.kind)).toEqual(["inferred_from_amount"]);
  });

  it("refunds a gift card line when the amount is the gift card's", () => {
    const book = line({ originalUnitPrice: 1000n });
    const card = line({ originalUnitPrice: 2500n, isGiftCard: true });
    const out = run(order({ lines: [book, card], refunds: [unlined(2500n)] }));
    expect(out.order.refunds[0]!.lines).toEqual([
      { lineId: card.id, quantity: 1, amount: 2500n, tax: 0n },
    ]);
  });
});

describe("inferUnlinedRefunds: amounts that name no single line", () => {
  it("leaves an amount matching two different charges unlined and notes it", () => {
    // 10.00 is the book's and the shipping's: guessing would pay or cut
    // the wrong royalty, so it keeps the pro-rata spread.
    const book = line({ originalUnitPrice: 1000n });
    const r = unlined(1000n);
    const out = run(
      order({ lines: [book], shipping: { amount: 1000n, tax: 0n }, refunds: [r] }),
    );
    expect(out.order.refunds).toEqual([r]);
    expect(out.notes).toEqual([
      {
        kind: "ambiguous_amount",
        orderId: "order_1",
        refundId: r.id,
        createdAt: r.createdAt,
      },
    ]);
  });

  it("leaves two different products at the same price ambiguous", () => {
    const a = line({ originalUnitPrice: 1000n });
    const b = line({ originalUnitPrice: 1000n });
    const c = line({ originalUnitPrice: 5000n });
    const r = unlined(1000n);
    const out = run(order({ lines: [a, b, c], refunds: [r] }));
    expect(out.order.refunds).toEqual([r]);
    expect(out.notes.map((n) => n.kind)).toEqual(["ambiguous_amount"]);
  });

  it("leaves an amount matching nothing unlined, with no note", () => {
    const r = unlined(700n);
    const out = run(
      order({
        lines: [
          line({ originalUnitPrice: 1000n }),
          line({ originalUnitPrice: 2000n }),
        ],
        shipping: { amount: 600n, tax: 0n },
        refunds: [r],
      }),
    );
    expect(out.order.refunds).toEqual([r]);
    expect(out.notes).toEqual([]);
  });

  it("leaves refunds that name lines as they are, but counts what they took", () => {
    const book = line({ quantity: 2, originalUnitPrice: 1000n });
    const other = line({ originalUnitPrice: 5000n });
    const named: CoreRefund = {
      id: "ref_named",
      createdAt: "2026-08-19T10:00:00Z",
      lines: [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }],
      shipping: { amount: 0n, tax: 0n },
    };
    // 20.00 would be the whole book line, but one unit already went back.
    const r = unlined(2000n, "2026-08-20T10:00:00Z");
    const out = run(order({ lines: [book, other], refunds: [named, r] }));
    expect(out.order.refunds).toEqual([named, r]);
  });
});

describe("inferUnlinedRefunds: full returns", () => {
  it("makes the refund reaching the order total a refund of everything", () => {
    const book = line({ quantity: 2, originalUnitPrice: 1000n, tax: 400n });
    const r = unlined(2900n);
    const out = run(
      order({
        lines: [book],
        shipping: { amount: 400n, tax: 100n },
        refunds: [r],
      }),
    );
    expect(out.order.refunds).toEqual([
      {
        id: r.id,
        createdAt: r.createdAt,
        lines: [{ lineId: book.id, quantity: 2, amount: 2000n, tax: 400n }],
        shipping: { amount: 400n, tax: 100n },
      },
    ]);
    // A full return is not an inference from the amount.
    expect(out.notes).toEqual([]);
  });

  it("judges the total by what the store charged, when the edge knows it", () => {
    // Three lines at 3.33 with 20% tax: each rounds to 0.67 tax, 12.00 in
    // all, but the store charged 11.99 (it rounds once, from the order's
    // unrounded total). Refunding the 11.99 charged is the whole order.
    const books = [0, 1, 2].map(() => line({ quantity: 1, originalUnitPrice: 333n, tax: 67n }));
    const r = unlined(1199n);
    const out = run(order({ lines: books, taxesIncluded: false, chargedTotal: 1199n, refunds: [r] }));
    expect(out.order.refunds[0]!.lines.map((l) => l.quantity)).toEqual([1, 1, 1]);
  });

  it("returns what earlier refunds left", () => {
    const book = line({ quantity: 3, originalUnitPrice: 1000n });
    const first = unlined(1000n, "2026-08-20T10:00:00Z");
    const last = unlined(2000n, "2026-08-21T10:00:00Z");
    const out = run(order({ lines: [book], refunds: [first, last] }));
    expect(out.order.refunds.map((r) => r.lines)).toEqual([
      [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }],
      [{ lineId: book.id, quantity: 2, amount: 2000n, tax: 0n }],
    ]);
  });

  it("offsets earlier spread money, so the refunds total the sale exactly", () => {
    // 7.00 matched nothing and is spread; the 29.00 that completes the
    // return returns every line in full and takes the 7.00 back out of the
    // spread, or the order would be refunded 36.00 + 7.00.
    const a = line({ originalUnitPrice: 1000n });
    const b = line({ originalUnitPrice: 2000n });
    const first = unlined(700n, "2026-08-20T10:00:00Z");
    const last = unlined(2900n, "2026-08-21T10:00:00Z");
    const out = run(
      order({
        lines: [a, b],
        shipping: { amount: 600n, tax: 0n },
        refunds: [first, last],
      }),
    );
    expect(out.order.refunds).toEqual([
      first,
      {
        id: last.id,
        createdAt: last.createdAt,
        lines: [
          { lineId: a.id, quantity: 1, amount: 1000n, tax: 0n },
          { lineId: b.id, quantity: 1, amount: 2000n, tax: 0n },
        ],
        shipping: { amount: 600n, tax: 0n },
        unallocatedAmount: -700n,
      },
    ]);
  });

  it("drops refunds dated after the full return and notes them", () => {
    const book = line({ originalUnitPrice: 1000n });
    const full = unlined(1000n, "2026-08-20T10:00:00Z");
    const later = unlined(1000n, "2026-08-25T10:00:00Z");
    const out = run(order({ lines: [book], refunds: [later, full] }));
    expect(out.order.refunds.map((r) => r.id)).toEqual([full.id]);
    expect(out.notes).toEqual([
      {
        kind: "after_full_return",
        orderId: "order_1",
        refundId: later.id,
        createdAt: later.createdAt,
      },
    ]);
  });

  it("never treats an order that charged nothing as fully refunded", () => {
    const free = line({ originalUnitPrice: 0n });
    const r = unlined(100n);
    const out = run(order({ lines: [free], refunds: [r] }));
    expect(out.order.refunds).toEqual([r]);
  });
});

describe("inferUnlinedRefunds: cancellation after payment", () => {
  it("is a full return at the cancellation when no refund came first", () => {
    const book = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [book], cancelledAt: "2026-08-20T10:00:00Z" });
    expect(run(o).order.refunds).toEqual([
      {
        id: "order_1:cancellation",
        createdAt: "2026-08-20T10:00:00Z",
        lines: [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }],
        shipping: { amount: 0n, tax: 0n },
      },
    ]);
  });

  it("returns what refunds dated on or before it left, and voids later ones", () => {
    const book = line({ quantity: 3, originalUnitPrice: 1000n });
    const before = unlined(1000n, "2026-08-20T10:00:00Z");
    const tied = unlined(1000n, "2026-08-21T10:00:00Z");
    const after = unlined(1000n, "2026-08-22T10:00:00Z");
    const out = run(
      order({
        lines: [book],
        cancelledAt: "2026-08-21T10:00:00Z",
        refunds: [before, tied, after],
      }),
    );
    expect(out.order.refunds).toEqual([
      { ...before, lines: [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }], unallocatedAmount: undefined },
      { ...tied, lines: [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }], unallocatedAmount: undefined },
      {
        id: "order_1:cancellation",
        createdAt: "2026-08-21T10:00:00Z",
        lines: [{ lineId: book.id, quantity: 1, amount: 1000n, tax: 0n }],
        shipping: { amount: 0n, tax: 0n },
      },
    ].map(stripUndefined));
    expect(out.notes.map((n) => [n.kind, n.refundId])).toEqual([
      ["inferred_from_amount", before.id],
      ["inferred_from_amount", tied.id],
      ["after_full_return", after.id],
    ]);
  });

  it("adds nothing when a refund completed the return first (Medusa's own cancellation)", () => {
    // cancelOrderWorkflow refunds the capture, then sets canceled_at a few
    // milliseconds later.
    const book = line({ originalUnitPrice: 3600n });
    const r = unlined(3600n, "2026-11-04T14:09:19.379Z");
    const out = run(
      order({
        lines: [book],
        cancelledAt: "2026-11-04T14:09:19.452Z",
        refunds: [r],
      }),
    );
    expect(out.order.refunds).toEqual([
      {
        id: r.id,
        createdAt: r.createdAt,
        lines: [{ lineId: book.id, quantity: 1, amount: 3600n, tax: 0n }],
        shipping: { amount: 0n, tax: 0n },
      },
    ]);
    expect(out.notes).toEqual([]);
  });
});

describe("inferUnlinedRefunds: determinism", () => {
  it("gives the same answer whatever order the refunds are listed in", () => {
    const book = line({ quantity: 4, originalUnitPrice: 1000n });
    const other = line({ originalUnitPrice: 5000n });
    const a = unlined(1000n, "2026-08-20T10:00:00Z");
    const b = unlined(3000n, "2026-08-20T10:00:00Z");
    const c = unlined(1000n, "2026-08-21T10:00:00Z");
    const forward = run(order({ lines: [book, other], refunds: [a, b, c] }));
    const backward = run(order({ lines: [book, other], refunds: [c, b, a] }));
    expect(backward).toEqual(forward);
  });

  it("does not change the order it was given", () => {
    const book = line({ quantity: 3, originalUnitPrice: 1000n });
    const o = order({ lines: [book], refunds: [unlined(1000n)] });
    const before = JSON.stringify(o, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    run(o);
    expect(
      JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).toBe(before);
  });
});

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}
