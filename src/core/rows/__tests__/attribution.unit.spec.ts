import {
  selectForPeriod,
  type OrphanRefund,
  type SelectForPeriodInput,
} from "../../rows/attribution";
import type { CoreOrder, CoreRefund } from "../../types";
import { line, order } from "../../__tests__/support/builders";

// Monthly, push day 15, London: the cut-off examples' schedule.
const monthly = { frequencyMonths: 1, anchorMonth: 1, pushDay: 15 };

function refund(
  id: string,
  createdAt: string,
  overrides: Partial<CoreRefund> = {},
): CoreRefund {
  return {
    id,
    createdAt,
    lines: [],
    shipping: { amount: 0n, tax: 0n },
    ...overrides,
  };
}

function run(
  period: string,
  orders: CoreOrder[],
  overrides: Partial<SelectForPeriodInput> = {},
) {
  return selectForPeriod({
    period,
    orders,
    orphanRefunds: [],
    schedule: monthly,
    timezone: "Europe/London",
    recordedCutoffs: new Map(),
    committedPeriods: new Set(),
    refundsAlreadyPushed: new Map(),
    moneyOnlyRefundsAlreadyReported: new Map(),
    appliedMoneyOnlyRefundIds: new Map(),
    ordersAlreadyPushed: new Map(),
    ...overrides,
  });
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const refundIds = (r: ReturnType<typeof run>) =>
  r.refunds.map((x) => x.refund.id);

describe("selectForPeriod: sales", () => {
  it("selects eligible orders paid in the period and nothing else", () => {
    const jul = order({ id: "jul", paidAt: "2026-07-10T12:00:00+01:00" });
    const aug = order({ id: "aug", paidAt: "2026-08-10T12:00:00+01:00" });
    expect(ids(run("2026-07", [jul, aug]).sales)).toEqual(["jul"]);
    expect(ids(run("2026-08", [jul, aug]).sales)).toEqual(["aug"]);
  });

  it("places an order paid 23:30 local on the last day in that month, though UTC says the next", () => {
    // 31 Jul 23:30 in New York is 1 Aug 03:30 UTC.
    const late = order({ id: "late", paidAt: "2026-08-01T03:30:00Z" });
    const ny = { timezone: "America/New_York" };
    expect(ids(run("2026-07", [late], ny).sales)).toEqual(["late"]);
    expect(run("2026-08", [late], ny).sales).toEqual([]);
  });

  it("excludes test and unpaid orders paid in the period, with the reason", () => {
    const t = order({ id: "t", test: true });
    const u = order({ id: "u", financialStatus: "other" });
    const r = run("2026-08", [t, u]);
    expect(r.sales).toEqual([]);
    expect(r.excluded).toEqual([
      { orderId: "t", reason: "test" },
      { orderId: "u", reason: "status" },
    ]);
  });

  it("does not report orders of other periods as excluded", () => {
    const t = order({ id: "t", test: true, paidAt: "2026-06-10T12:00:00Z" });
    expect(run("2026-08", [t]).excluded).toEqual([]);
  });
});

describe("selectForPeriod: cut-off rule", () => {
  const paid30Jul = (refunds: CoreRefund[]) =>
    order({ id: "o", paidAt: "2026-07-30T12:00:00+01:00", refunds });

  it("nets a 3 Aug refund of a 30 Jul sale into July (before July's 15 Aug cut-off)", () => {
    const o = paid30Jul([refund("r", "2026-08-03T10:00:00+01:00")]);
    const jul = run("2026-07", [o]);
    expect(refundIds(jul)).toEqual(["r"]);
    expect(jul.refunds[0]!.salePeriod).toBe("2026-07");
    expect(jul.refunds[0]!.order.id).toBe("o");
    expect(refundIds(run("2026-08", [o]))).toEqual([]);
  });

  it("books a 20 Aug refund of the same sale in August", () => {
    const o = paid30Jul([refund("r", "2026-08-20T10:00:00+01:00")]);
    expect(refundIds(run("2026-07", [o]))).toEqual([]);
    const aug = run("2026-08", [o]);
    expect(refundIds(aug)).toEqual(["r"]);
    expect(aug.refunds[0]!.salePeriod).toBe("2026-07");
    // The sale itself stays in July only.
    expect(aug.sales).toEqual([]);
  });

  it("treats a refund exactly at the cut-off instant as on or before it (sale month)", () => {
    // July's cut-off: 15 Aug 00:00 BST = 14 Aug 23:00 UTC.
    const o = paid30Jul([refund("at", "2026-08-14T23:00:00Z")]);
    expect(refundIds(run("2026-07", [o]))).toEqual(["at"]);
    expect(refundIds(run("2026-08", [o]))).toEqual([]);
  });

  it("books a refund one second after the cut-off in its own month", () => {
    const o = paid30Jul([refund("after", "2026-08-14T23:00:01Z")]);
    expect(refundIds(run("2026-07", [o]))).toEqual([]);
    expect(refundIds(run("2026-08", [o]))).toEqual(["after"]);
  });

  it("splits several refunds on one order across periods", () => {
    const o = paid30Jul([
      refund("early", "2026-08-03T10:00:00+01:00"),
      refund("late", "2026-08-20T10:00:00+01:00"),
      refund("later", "2026-09-02T10:00:00+01:00"),
    ]);
    expect(refundIds(run("2026-07", [o]))).toEqual(["early"]);
    expect(refundIds(run("2026-08", [o]))).toEqual(["late"]);
    expect(refundIds(run("2026-09", [o]))).toEqual(["later"]);
  });

  it("dates a late refund by the shop's zone, not UTC", () => {
    // 1 Sep 03:00 UTC is still 31 Aug 23:00 in New York.
    const o = order({
      id: "o",
      paidAt: "2026-07-10T12:00:00-04:00",
      refunds: [refund("r", "2026-09-01T03:00:00Z")],
    });
    const ny = { timezone: "America/New_York" };
    expect(refundIds(run("2026-08", [o], ny))).toEqual(["r"]);
    expect(refundIds(run("2026-09", [o], ny))).toEqual([]);
  });

  it("nets a refund in month 2 of a 6-month cycle into the month-1 sale", () => {
    // Jan–Jun cycle: every month's cut-off is 15 Jul.
    const sixMonthly = { frequencyMonths: 6, anchorMonth: 1, pushDay: 15 };
    const o = order({
      id: "o",
      paidAt: "2026-01-20T12:00:00Z",
      refunds: [refund("r", "2026-02-10T12:00:00Z")],
    });
    const jan = run("2026-01", [o], { schedule: sixMonthly });
    expect(refundIds(jan)).toEqual(["r"]);
    expect(jan.refundCutoffAt).toBe("2026-07-15T00:00:00+01:00");
    expect(refundIds(run("2026-02", [o], { schedule: sixMonthly }))).toEqual(
      [],
    );
  });

  it("uses the recorded cut-off for the sale period over the current schedule", () => {
    // July was pushed when push day was 15; the owner has since moved it to
    // the 5th. A 10 Aug refund must still net into July.
    const now5th = { frequencyMonths: 1, anchorMonth: 1, pushDay: 5 };
    const o = paid30Jul([refund("r", "2026-08-10T10:00:00+01:00")]);
    const recordedCutoffs = new Map([["2026-07", "2026-08-15T00:00:00+01:00"]]);

    expect(
      refundIds(run("2026-07", [o], { schedule: now5th, recordedCutoffs })),
    ).toEqual(["r"]);
    expect(
      refundIds(run("2026-08", [o], { schedule: now5th, recordedCutoffs })),
    ).toEqual([]);

    // Without the record the new schedule applies (July not yet pushed).
    expect(refundIds(run("2026-07", [o], { schedule: now5th }))).toEqual([]);
    expect(refundIds(run("2026-08", [o], { schedule: now5th }))).toEqual(["r"]);
  });

  it("treats a cancellation after payment as a sale plus a refund", () => {
    const o = order({
      id: "cancelled",
      financialStatus: "refunded",
      paidAt: "2026-08-10T12:00:00+01:00",
      refunds: [refund("r", "2026-08-11T09:00:00+01:00")],
    });
    const aug = run("2026-08", [o]);
    expect(ids(aug.sales)).toEqual(["cancelled"]);
    expect(refundIds(aug)).toEqual(["r"]);
    expect(aug.excluded).toEqual([]);
  });

  it("ignores refunds of a test order but counts the order as excluded where its refund would land", () => {
    const t = order({
      id: "t",
      test: true,
      paidAt: "2026-07-30T12:00:00+01:00",
      refunds: [refund("r", "2026-08-20T10:00:00+01:00")],
    });
    const aug = run("2026-08", [t]);
    expect(aug.refunds).toEqual([]);
    expect(aug.excluded).toEqual([{ orderId: "t", reason: "test" }]);
    // In July it is excluded once, not once for the sale and again for the refund.
    expect(run("2026-07", [t]).excluded).toEqual([
      { orderId: "t", reason: "test" },
    ]);
  });

  it("ignores refunds of an unpaid order", () => {
    const u = order({
      id: "u",
      financialStatus: "other",
      paidAt: "2026-07-30T12:00:00+01:00",
      refunds: [refund("r", "2026-08-20T10:00:00+01:00")],
    });
    const aug = run("2026-08", [u]);
    expect(aug.refunds).toEqual([]);
    expect(aug.excluded).toEqual([{ orderId: "u", reason: "status" }]);
  });
});

describe("selectForPeriod: refundCutoffAt", () => {
  it("is the period's scheduled cut-off", () => {
    expect(run("2026-07", []).refundCutoffAt).toBe("2026-08-15T00:00:00+01:00");
  });

  it("is the recorded cut-off when the period was pushed, untouched", () => {
    const recordedCutoffs = new Map([["2026-07", "2026-08-15T00:00:00Z"]]);
    expect(run("2026-07", [], { recordedCutoffs }).refundCutoffAt).toBe(
      "2026-08-15T00:00:00Z",
    );
  });
});

describe("selectForPeriod: orphan refunds", () => {
  const orphan = (createdAt: string): OrphanRefund => ({
    orderId: "order_old",
    currency: "EUR",
    refund: refund("refund_old", createdAt, {
      lines: [
        { lineId: "a", quantity: 1, amount: 1200n, tax: 200n },
        { lineId: "b", quantity: 2, amount: 800n, tax: 0n },
      ],
      shipping: { amount: 300n, tax: 50n },
    }),
  });

  it("reports an orphan refund as unmatched in the period of its createdAt", () => {
    const r = run("2026-08", [], {
      orphanRefunds: [orphan("2026-08-03T10:00:00+01:00")],
    });
    expect(r.refunds).toEqual([]);
    expect(r.unmatchedRefunds).toEqual([
      {
        orderId: "order_old",
        refundId: "refund_old",
        currency: "EUR",
        amount: 2300n,
        tax: 250n,
      },
    ]);
  });

  it("does not report it in any other period", () => {
    const orphanRefunds = [orphan("2026-08-03T10:00:00+01:00")];
    expect(run("2026-07", [], { orphanRefunds }).unmatchedRefunds).toEqual([]);
    expect(run("2026-09", [], { orphanRefunds }).unmatchedRefunds).toEqual([]);
  });

  it("dates it in the shop's zone", () => {
    const orphanRefunds = [orphan("2026-09-01T03:00:00Z")];
    const ny = { timezone: "America/New_York", orphanRefunds };
    expect(run("2026-08", [], ny).unmatchedRefunds).toHaveLength(1);
    expect(run("2026-09", [], ny).unmatchedRefunds).toEqual([]);
  });

  it("refuses an orphan whose order is in the ledger (it would be counted twice)", () => {
    const o = order({ id: "order_old" });
    expect(() =>
      run("2026-08", [o], {
        orphanRefunds: [orphan("2026-08-03T10:00:00+01:00")],
      }),
    ).toThrow(/in the ledger/);
  });
});

describe("selectForPeriod: validation", () => {
  it("rejects a malformed period", () => {
    expect(() => run("2026-8", [])).toThrow(/period/i);
  });

  it("rejects an unknown time zone", () => {
    expect(() => run("2026-08", [], { timezone: "Mars/Olympus" })).toThrow(
      /time zone/i,
    );
  });

  it("does not need order lines to attribute (lines are the builder's concern)", () => {
    const o = order({ id: "o", lines: [line(), line()] });
    expect(ids(run("2026-08", [o]).sales)).toEqual(["o"]);
  });
});

describe("selectForPeriod: refunds captured after their period was committed", () => {
  // July (sold 30 Jul) has cut-off 15 Aug. A refund dated 10 Aug belongs to
  // July, but if the webhook or the daily reconcile only captured it after
  // July's snapshot was pushed, re-pushing July would rewrite a month RHQ
  // has already imported. It is booked forward instead, and reported.
  const paid30Jul = (refunds: CoreRefund[]) =>
    order({ id: "o", paidAt: "2026-07-30T12:00:00+01:00", refunds });
  const committed = { committedPeriods: new Set(["2026-07"]) };

  it("re-books it into the month of its date when that month is open", () => {
    const o = paid30Jul([refund("r", "2026-08-10T10:00:00+01:00")]);
    expect(refundIds(run("2026-07", [o], committed))).toEqual([]);
    const aug = run("2026-08", [o], committed);
    expect(refundIds(aug)).toEqual(["r"]);
    expect(aug.refunds[0]).toMatchObject({ salePeriod: "2026-07", late: true });
  });

  it("leaves it in the committed month when that month's snapshot carried it", () => {
    const o = paid30Jul([refund("r", "2026-08-10T10:00:00+01:00")]);
    const pushed = {
      ...committed,
      refundsAlreadyPushed: new Map([["2026-07", new Set(["r"])]]),
    };
    expect(refundIds(run("2026-07", [o], pushed))).toEqual(["r"]);
    expect(run("2026-07", [o], pushed).refunds[0]!.late).toBe(false);
    expect(refundIds(run("2026-08", [o], pushed))).toEqual([]);
  });

  it("moves on to the earliest open month when its own month is committed too", () => {
    const o = paid30Jul([refund("r", "2026-08-10T10:00:00+01:00")]);
    const both = { committedPeriods: new Set(["2026-07", "2026-08"]) };
    expect(refundIds(run("2026-08", [o], both))).toEqual([]);
    expect(refundIds(run("2026-09", [o], both))).toEqual(["r"]);
  });

  it("does not touch a refund whose attributed month is open", () => {
    const o = paid30Jul([refund("r", "2026-08-20T10:00:00+01:00")]);
    const aug = run("2026-08", [o], committed);
    expect(refundIds(aug)).toEqual(["r"]);
    expect(aug.refunds[0]!.late).toBe(false);
  });
});

describe("selectForPeriod: money-only refunds (unallocatedAmount)", () => {
  // Monthly, push day 15: August's cut-off is 15 September 00:00 London.
  // A money-only refund lowers the sale itself while the sale's period has
  // not gone out; once it has, it is ignored for royalties and only reported.
  const moneyOnly = (id: string, createdAt: string, amount = 300n) =>
    refund(id, createdAt, { unallocatedAmount: amount });
  const paidAug = (refunds: CoreRefund[]) =>
    order({ id: "o", paidAt: "2026-08-10T12:00:00+01:00", refunds });
  const augPushed = {
    recordedCutoffs: new Map([["2026-08", "2026-09-14T23:00:00Z"]]),
  };

  it("applies one made before the sale period was pushed to the sale, not as a refund row", () => {
    const o = paidAug([moneyOnly("m", "2026-09-01T10:00:00+01:00")]);
    const aug = run("2026-08", [o]);
    expect(aug.refunds).toEqual([]);
    expect(aug.saleAdjustments).toEqual([
      {
        orderId: "o",
        refundId: "m",
        currency: "GBP",
        amount: 300n,
        createdAt: "2026-09-01T10:00:00+01:00",
      },
    ]);
    expect(aug.ignoredMoneyOnly).toEqual([]);
    const sep = run("2026-09", [o]);
    expect(sep.refunds).toEqual([]);
    expect(sep.saleAdjustments).toEqual([]);
    expect(sep.ignoredMoneyOnly).toEqual([]);
  });

  it("keeps applying one the sale period's pushed snapshot carried, so a re-push is unchanged", () => {
    const o = paidAug([moneyOnly("m", "2026-09-01T10:00:00+01:00")]);
    const aug = run("2026-08", [o], {
      ...augPushed,
      appliedMoneyOnlyRefundIds: new Map([["2026-08", new Set(["m"])]]),
    });
    expect(aug.saleAdjustments.map((a) => a.refundId)).toEqual(["m"]);
    expect(aug.ignoredMoneyOnly).toEqual([]);
  });

  it("ignores one captured after the sale period was pushed, and reports it in the next month, never the sale's", () => {
    // Dated in August itself: the report still goes to September, so the
    // staged August snapshot is not changed by it.
    const o = paidAug([moneyOnly("m", "2026-08-20T10:00:00+01:00")]);
    const aug = run("2026-08", [o], augPushed);
    expect(aug.saleAdjustments).toEqual([]);
    expect(aug.ignoredMoneyOnly).toEqual([]);
    const sep = run("2026-09", [o], augPushed);
    expect(sep.refunds).toEqual([]);
    expect(sep.saleAdjustments).toEqual([]);
    expect(sep.ignoredMoneyOnly).toEqual([
      {
        orderId: "o",
        refundId: "m",
        currency: "GBP",
        amount: 300n,
        createdAt: "2026-08-20T10:00:00+01:00",
        reason: "sale_period_pushed",
      },
    ]);
  });

  it("ignores one made after the sale period's cut-off and reports it in its own month", () => {
    const o = paidAug([moneyOnly("m", "2026-10-02T10:00:00+01:00")]);
    expect(run("2026-08", [o]).saleAdjustments).toEqual([]);
    expect(run("2026-09", [o]).ignoredMoneyOnly).toEqual([]);
    const oct = run("2026-10", [o]);
    expect(oct.ignoredMoneyOnly).toMatchObject([
      { refundId: "m", reason: "after_cutoff" },
    ]);
  });

  it("reports an ignored one in the earliest open month when its month is committed, once", () => {
    const o = paidAug([moneyOnly("m", "2026-10-02T10:00:00+01:00")]);
    const committed = { committedPeriods: new Set(["2026-10"]) };
    expect(run("2026-10", [o], committed).ignoredMoneyOnly).toEqual([]);
    expect(
      run("2026-11", [o], committed).ignoredMoneyOnly.map((i) => i.refundId),
    ).toEqual(["m"]);
    // Once a pushed snapshot reported it, it is not reported again.
    const reported = {
      committedPeriods: new Set(["2026-10", "2026-11"]),
      moneyOnlyRefundsAlreadyReported: new Map([["2026-11", new Set(["m"])]]),
    };
    expect(run("2026-12", [o], reported).ignoredMoneyOnly).toEqual([]);
  });

  it("keeps reporting an ignored one in the month that reported it when that month is re-pushed", () => {
    const o = paidAug([moneyOnly("m", "2026-10-02T10:00:00+01:00")]);
    // October was imported, so November (staged) reported it.
    const history = {
      committedPeriods: new Set(["2026-10"]),
      moneyOnlyRefundsAlreadyReported: new Map([["2026-11", new Set(["m"])]]),
    };
    expect(
      run("2026-11", [o], history).ignoredMoneyOnly.map((i) => i.refundId),
    ).toEqual(["m"]);
    // And October's import undone: still November's, never twice.
    const undone = { ...history, committedPeriods: new Set<string>() };
    expect(run("2026-10", [o], undone).ignoredMoneyOnly).toEqual([]);
    expect(
      run("2026-11", [o], undone).ignoredMoneyOnly.map((i) => i.refundId),
    ).toEqual(["m"]);
  });

  it("splits a refund with lines and money-only money: the lines are a refund row, the rest adjusts the sale", () => {
    const o = paidAug([
      refund("r", "2026-09-01T10:00:00+01:00", {
        lines: [{ lineId: "l", quantity: 1, amount: 1000n, tax: 0n }],
        unallocatedAmount: 50n,
      }),
    ]);
    const aug = run("2026-08", [o]);
    expect(refundIds(aug)).toEqual(["r"]);
    expect(aug.saleAdjustments).toMatchObject([{ refundId: "r", amount: 50n }]);
  });

  it("ignores and reports an orphan's money-only money by its own date, outside the unmatched amount", () => {
    const orphanRefunds: OrphanRefund[] = [
      {
        orderId: "order_old",
        currency: "EUR",
        refund: moneyOnly("m", "2026-08-03T10:00:00+01:00", 700n),
      },
    ];
    const aug = run("2026-08", [], { orphanRefunds });
    expect(aug.ignoredMoneyOnly).toEqual([
      {
        orderId: "order_old",
        refundId: "m",
        currency: "EUR",
        amount: 700n,
        createdAt: "2026-08-03T10:00:00+01:00",
        reason: "order_not_in_ledger",
      },
    ]);
    // Nothing but money-only money: not also an unmatched refund row.
    expect(aug.unmatchedRefunds).toEqual([]);
  });
});

describe("selectForPeriod: sales paid after their month was committed", () => {
  // A deferred-payment order processed 28 Jul, but only found paid (and
  // stored) by reconciliation after July's snapshot was imported. Re-pushing
  // July would rewrite an imported month, so the sale is booked into the
  // earliest open month from July onward, like a late refund.
  const lateJul = (refunds: CoreRefund[] = []) =>
    order({ id: "late", paidAt: "2026-07-28T12:00:00+01:00", refunds });
  const julyImported = {
    committedPeriods: new Set(["2026-07"]),
    ordersAlreadyPushed: new Map([["2026-07", new Set(["other"])]]),
  };

  it("books it into August and marks it late", () => {
    const o = lateJul();
    expect(run("2026-07", [o], julyImported).sales).toEqual([]);
    const aug = run("2026-08", [o], julyImported);
    expect(ids(aug.sales)).toEqual(["late"]);
    expect(aug.lateSales).toEqual(["late"]);
  });

  it("leaves it in its own month when that month is not committed", () => {
    const staged = {
      ordersAlreadyPushed: julyImported.ordersAlreadyPushed,
    };
    const jul = run("2026-07", [lateJul()], staged);
    expect(ids(jul.sales)).toEqual(["late"]);
    expect(jul.lateSales).toEqual([]);
    expect(run("2026-08", [lateJul()], staged).sales).toEqual([]);
  });

  it("leaves it where it is when the committed month's snapshot carried it", () => {
    const carried = {
      ...julyImported,
      ordersAlreadyPushed: new Map([["2026-07", new Set(["late"])]]),
    };
    expect(ids(run("2026-07", [lateJul()], carried).sales)).toEqual(["late"]);
    expect(run("2026-08", [lateJul()], carried).sales).toEqual([]);
  });

  it("never re-books from a committed month whose pushed orders are unknown", () => {
    // A log from before pushedOrderIds was recorded: treating every one of
    // its sales as missing would book the whole month twice.
    const unknown = { committedPeriods: new Set(["2026-07"]) };
    expect(ids(run("2026-07", [lateJul()], unknown).sales)).toEqual(["late"]);
    expect(run("2026-08", [lateJul()], unknown).sales).toEqual([]);
  });

  it("stays in the month it was re-booked into once that month is committed too", () => {
    const both = {
      committedPeriods: new Set(["2026-07", "2026-08"]),
      ordersAlreadyPushed: new Map([
        ["2026-07", new Set<string>()],
        ["2026-08", new Set(["late"])],
      ]),
    };
    expect(ids(run("2026-08", [lateJul()], both).sales)).toEqual(["late"]);
    expect(run("2026-09", [lateJul()], both).sales).toEqual([]);
  });

  it("dates its refunds' cut-off from the month it was booked into", () => {
    const o = lateJul([
      // After July's cut-off (15 Aug) but before August's (15 Sep): nets
      // with the sale in August, where the sale now is.
      refund("before", "2026-09-10T10:00:00+01:00"),
      // After August's cut-off: its own month.
      refund("after", "2026-09-20T10:00:00+01:00"),
    ]);
    const aug = run("2026-08", [o], julyImported);
    expect(refundIds(aug)).toEqual(["before"]);
    expect(aug.refunds[0]).toMatchObject({
      salePeriod: "2026-08",
      late: false,
    });
    expect(refundIds(run("2026-09", [o], julyImported))).toEqual(["after"]);
  });
});

describe("selectForPeriod: what a pushed snapshot carried stays in it", () => {
  // July was imported without L (paid 28 Jul, stored late), so L
  // went into August as a late sale, and August was pushed carrying it.
  // Then the publisher undid July's import in RHQ. July is open again, but
  // L is already in August's snapshot: putting it back in July would count
  // it twice.
  const L = (refunds: CoreRefund[] = []) =>
    order({ id: "L", paidAt: "2026-07-28T12:00:00+01:00", refunds });
  const julyUndone = (augustCommitted: boolean) => ({
    committedPeriods: new Set(augustCommitted ? ["2026-08"] : []),
    ordersAlreadyPushed: new Map([
      ["2026-07", new Set(["other"])],
      ["2026-08", new Set(["L"])],
    ]),
  });

  it("keeps a late sale in August after July's import is undone, August imported", () => {
    expect(run("2026-07", [L()], julyUndone(true)).sales).toEqual([]);
    const aug = run("2026-08", [L()], julyUndone(true));
    expect(ids(aug.sales)).toEqual(["L"]);
    expect(aug.lateSales).toEqual(["L"]);
  });

  it("keeps a late sale in August after July's import is undone, August only staged", () => {
    expect(run("2026-07", [L()], julyUndone(false)).sales).toEqual([]);
    const aug = run("2026-08", [L()], julyUndone(false));
    expect(ids(aug.sales)).toEqual(["L"]);
    expect(aug.lateSales).toEqual(["L"]);
  });

  it("still books a sale carried nowhere by the late rule", () => {
    const history = {
      committedPeriods: new Set(["2026-07"]),
      ordersAlreadyPushed: new Map([["2026-07", new Set(["other"])]]),
    };
    expect(ids(run("2026-08", [L()], history).sales)).toEqual(["L"]);
  });

  // The same for a late refund: r (10 Aug) belongs to July by the cut-off,
  // but was captured after July was imported, so August carried it.
  const paid30Jul = (refunds: CoreRefund[]) =>
    order({ id: "o", paidAt: "2026-07-30T12:00:00+01:00", refunds });
  const r = () => refund("r", "2026-08-10T10:00:00+01:00");
  const augustCarried = new Map([
    ["2026-07", new Set<string>()],
    ["2026-08", new Set(["r"])],
  ]);

  it("keeps a late refund in the month that carried it when that month is re-pushed", () => {
    const o = paid30Jul([r()]);
    const history = {
      committedPeriods: new Set(["2026-07"]),
      refundsAlreadyPushed: augustCarried,
    };
    const aug = run("2026-08", [o], history);
    expect(refundIds(aug)).toEqual(["r"]);
    // Still reported late, so a re-push of August is byte-identical.
    expect(aug.refunds[0]).toMatchObject({ late: true });
    expect(refundIds(run("2026-07", [o], history))).toEqual([]);
  });

  it("keeps a late refund in August after July's import is undone", () => {
    const o = paid30Jul([r()]);
    for (const committed of [new Set(["2026-08"]), new Set<string>()]) {
      const history = {
        committedPeriods: committed,
        refundsAlreadyPushed: augustCarried,
      };
      expect(refundIds(run("2026-07", [o], history))).toEqual([]);
      expect(refundIds(run("2026-08", [o], history))).toEqual(["r"]);
    }
  });
});
