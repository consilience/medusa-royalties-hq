import { mulDivRound, type Minor } from "../money";
import { toEpochMillis } from "../period";
import type { CoreOrder, CoreRefund, CoreRefundLine } from "../types";
import { isMoneyOnly } from "./attribution";

// Refunds with no lines.
// Every Medusa refund is one: a payment refund carries an amount and nothing
// else, and nothing links it to a return.
//
// The merchant almost always meant one thing (the postage, the gift card,
// one of three books), and spreading the money pro rata took it off books
// nobody returned and never gave the book back. So an amount that is
// exactly what one line has left, or a whole number of its units, is
// rewritten as the refund that names that line. Rewriting, rather than a
// second path through the core, is the point: attribution, netting and
// aggregation then treat it exactly as a refund that named the line, so
// there is one set of rules for units, shipping, gift cards and bundles.

export type UnlinedRefundNoteKind =
  /** An unlined refund rewritten as the refund of the line its amount names. */
  | "inferred_from_amount"
  /** An unlined amount that two or more different charges match: left to the spread. */
  | "ambiguous_amount"
  /** A refund dated after the order's full return: it has nothing left to return. */
  | "after_full_return";

export interface UnlinedRefundNote {
  kind: UnlinedRefundNoteKind;
  orderId: string;
  refundId: string;
  createdAt: string;
}

export interface InferredOrder {
  /** The order with its refunds rewritten, in date order, then by id. */
  order: CoreOrder;
  notes: UnlinedRefundNote[];
}

/** What one charge (a line, or the shipping) has left to refund. */
interface Slot {
  /** null: the shipping. */
  lineId: string | null;
  /**
   * Whether an amount can name it. A charge of nothing (a free line, a
   * zero-priced component) cannot be what money came back for, but its
   * units still go back in a full return.
   */
  candidate: boolean;
  /** Lines of the same product at the same unit price share a group. */
  group: string;
  qty: number;
  /** As charged: on the order's basis, and its recorded tax. */
  amount: Minor;
  tax: Minor;
  leftQty: number;
  leftAmount: Minor;
  leftTax: Minor;
}

/**
 * Rewrites an order's refunds that have no lines. Pure: the order passed in is not changed.
 *
 * Deterministic: refunds are taken in date order, then by id, so the answer
 * does not depend on the order the edge listed them in, and a refund's
 * reading never depends on refunds made after it. That keeps a pushed
 * month's content stable when later refunds arrive.
 */
export function inferUnlinedRefunds(order: CoreOrder): InferredOrder {
  const sorted = [...order.refunds].sort(byDateThenId);
  const slots = slotsOf(order);
  const notes: UnlinedRefundNote[] = [];
  const note = (kind: UnlinedRefundNoteKind, r: CoreRefund) =>
    notes.push({
      kind,
      orderId: order.id,
      refundId: r.id,
      createdAt: r.createdAt,
    });

  // The full-return check runs first, on the refunds as recorded: matching
  // never changes an amount, so it could not change the answer anyway.
  const full = fullReturnOf(order, sorted);
  const standing = full === null ? sorted : sorted.slice(0, full.prior);

  const refunds = standing.map((refund) => {
    let out = refund;
    const cash = refund.unallocatedAmount ?? 0n;
    if (isMoneyOnly(refund) && cash > 0n) {
      const matches = groupsOf(slots.filter((s) => s.candidate))
        .map((group) => match(group, cash, order.taxesIncluded))
        .filter((m): m is Rewrite => m !== null);
      if (matches.length === 1) {
        out = {
          id: refund.id,
          createdAt: refund.createdAt,
          lines: matches[0]!.lines,
          shipping: matches[0]!.shipping,
        };
        note("inferred_from_amount", refund);
      } else if (matches.length > 1) {
        note("ambiguous_amount", refund);
      }
    }
    take(slots, out);
    return out;
  });

  if (full !== null) {
    refunds.push(remainder(slots, refunds, full.refund));
    // A cancellation plus refunds never exceeds the sale: a refund dated
    // after the full return has nothing left to return, so it adds nothing.
    for (const later of sorted.slice(full.voidFrom)) {
      note("after_full_return", later);
    }
  }

  return { order: { ...order, refunds }, notes };
}

interface FullReturn {
  /** How many of the sorted refunds came before it and stand on their own. */
  prior: number;
  /** The sorted refunds from this index on are dated after it: void. */
  voidFrom: number;
  /** Its id and date: the completing refund's, or the cancellation's. */
  refund: Pick<CoreRefund, "id" | "createdAt">;
}

/**
 * The order's full return, if it has one: the earlier of
 *
 * - the refund that brings the order's refunds up to its total, whatever
 *   their shape. A Medusa refund of the whole payment, or several adding up
 *   to it, is otherwise money only and would keep paying royalty on books
 *   that came back. The total is what every line and the shipping charged,
 *   tax included; an order that charged nothing is never full by amount
 *   (any refund would reach it);
 * - the cancellation after payment (cancelledAt). A refund at the same
 *   instant counts as before it, so a cancellation never follows a
 *   completing refund it tied with. Medusa refunds the capture a moment
 *   before it sets canceled_at, so there the refund completes the
 *   return and the cancellation adds nothing.
 */
function fullReturnOf(
  order: CoreOrder,
  sorted: readonly CoreRefund[],
): FullReturn | null {
  let completing: FullReturn | null = null;
  let total = cashOf(
    order.shipping.amount,
    order.shipping.tax,
    order.taxesIncluded,
  );
  for (const l of order.lines) {
    const amount = l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal;
    total += cashOf(amount, l.tax, order.taxesIncluded);
  }
  // The charge itself when recorded: a store rounds its total once, so the
  // sum of rounded lines can sit a few minor units above what was charged,
  // and a refund of the whole charge would then never complete the return.
  if (order.chargedTotal != null && order.chargedTotal > 0n) total = order.chargedTotal;
  if (total > 0n) {
    let refunded = 0n;
    for (let i = 0; i < sorted.length; i += 1) {
      refunded += refundCash(sorted[i]!, order.taxesIncluded);
      if (refunded >= total) {
        completing = { prior: i, voidFrom: i + 1, refund: sorted[i]! };
        break;
      }
    }
  }

  const cancelledAt = order.cancelledAt ?? null;
  if (cancelledAt === null) return completing;
  const cancelled = toEpochMillis(cancelledAt);
  if (
    completing !== null &&
    toEpochMillis(completing.refund.createdAt) <= cancelled
  ) {
    return completing;
  }
  const prior = sorted.filter(
    (r) => toEpochMillis(r.createdAt) <= cancelled,
  ).length;
  return {
    prior,
    voidFrom: prior,
    refund: { id: `${order.id}:cancellation`, createdAt: cancelledAt },
  };
}

/** Everything a refund paid back, tax included. */
function refundCash(r: CoreRefund, taxesIncluded: boolean): Minor {
  let cash =
    cashOf(r.shipping.amount, r.shipping.tax, taxesIncluded) +
    (r.unallocatedAmount ?? 0n);
  for (const l of r.lines) cash += cashOf(l.amount, l.tax, taxesIncluded);
  return cash;
}

/**
 * The full return: whatever the refunds before it left, as one refund.
 *
 * Remaining money is never refunded below zero: if an earlier refund took
 * more than a line (a data slip, or money that was moved off the other
 * lines on the sale side), that line has nothing left, and a
 * positive "refund" of the excess would pay it out a second time.
 *
 * Money spread pro rata by an earlier refund that named no line is on no
 * line, so every line still shows it as left. The full return takes it
 * back out as negative unlined money, so the order's refunds add up to its
 * sale exactly: where both fall by the sale month's cut-off, the spread and
 * its offset cancel and the sale nets to nothing.
 */
function remainder(
  slots: readonly Slot[],
  standing: readonly CoreRefund[],
  at: Pick<CoreRefund, "id" | "createdAt">,
): CoreRefund {
  const pos = (m: Minor) => (m > 0n ? m : 0n);
  const lines: CoreRefundLine[] = [];
  let shipping = { amount: 0n, tax: 0n };
  for (const s of slots) {
    const amount = pos(s.leftAmount);
    const tax = pos(s.leftTax);
    const quantity = Math.max(0, s.leftQty);
    if (s.lineId === null) {
      shipping = { amount, tax };
    } else if (quantity > 0 || amount > 0n || tax > 0n) {
      lines.push({ lineId: s.lineId, quantity, amount, tax });
    }
  }
  let spread = 0n;
  for (const r of standing) spread += r.unallocatedAmount ?? 0n;
  return {
    id: at.id,
    createdAt: at.createdAt,
    lines,
    shipping,
    ...(spread !== 0n ? { unallocatedAmount: -spread } : {}),
  };
}

function byDateThenId(a: CoreRefund, b: CoreRefund): number {
  const d = toEpochMillis(a.createdAt) - toEpochMillis(b.createdAt);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Cash a charge took: tax included, whatever the order's basis. */
const cashOf = (amount: Minor, tax: Minor, taxesIncluded: boolean): Minor =>
  taxesIncluded ? amount : amount + tax;

/**
 * Every charge, in line order, then the shipping. Gift cards are
 * candidates: an amount that is the gift card's is its refund, and leaves
 * the books alone.
 */
function slotsOf(order: CoreOrder): Slot[] {
  const slots: Slot[] = [];
  for (const l of order.lines) {
    const amount = l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal;
    const cash = cashOf(amount, l.tax, order.taxesIncluded);
    // The same variant at the same unit price, as a reduced fraction so 2
    // for 20.00 and 1 for 10.00 are the same without dividing inexactly:
    // whichever of the lines the refund is put on, the rows come out the
    // same, so the choice is not ambiguous. A line with no variant stands
    // alone.
    let group = `line:${l.id}`;
    if (l.variantId !== null && l.quantity > 0) {
      const g = gcd(cash, BigInt(l.quantity));
      group = [
        "variant",
        l.variantId,
        l.isGiftCard ? "gift" : "goods",
        `${cash / g}/${BigInt(l.quantity) / g}`,
      ].join("|");
    }
    slots.push({
      lineId: l.id,
      candidate: cash > 0n,
      group,
      qty: l.quantity,
      amount,
      tax: l.tax,
      leftQty: l.quantity,
      leftAmount: amount,
      leftTax: l.tax,
    });
  }
  const s = order.shipping;
  slots.push({
    lineId: null,
    candidate: cashOf(s.amount, s.tax, order.taxesIncluded) > 0n,
    group: "shipping",
    qty: 0,
    amount: s.amount,
    tax: s.tax,
    leftQty: 0,
    leftAmount: s.amount,
    leftTax: s.tax,
  });
  return slots;
}

function groupsOf(slots: Slot[]): Slot[][] {
  const groups = new Map<string, Slot[]>();
  for (const s of slots) {
    const g = groups.get(s.group);
    if (g === undefined) groups.set(s.group, [s]);
    else g.push(s);
  }
  return [...groups.values()];
}

interface Rewrite {
  lines: CoreRefundLine[];
  shipping: { amount: Minor; tax: Minor };
}

/**
 * What a candidate would be refunded for a cash amount, or null.
 *
 * The whole remainder is tried first: an amount equal to everything a line
 * has left returns all its units, even when earlier money-only refunds left
 * less than their full price. Otherwise the amount must be a whole number of
 * units at the line's unit price, which must itself be whole minor units
 * (three for 10.00 are no number of pennies each, so no amount is "one of
 * them"), and no more units than the group has left.
 */
function match(
  group: readonly Slot[],
  cash: Minor,
  taxesIncluded: boolean,
): Rewrite | null {
  const none = { amount: 0n, tax: 0n };
  for (const s of group) {
    if (cashOf(s.leftAmount, s.leftTax, taxesIncluded) !== cash) continue;
    if (s.lineId === null) {
      return { lines: [], shipping: { amount: s.leftAmount, tax: s.leftTax } };
    }
    return {
      lines: [
        {
          lineId: s.lineId,
          quantity: Math.max(0, s.leftQty),
          amount: s.leftAmount,
          tax: s.leftTax,
        },
      ],
      shipping: none,
    };
  }

  const first = group[0]!;
  const charged = cashOf(first.amount, first.tax, taxesIncluded);
  if (first.lineId === null || first.qty <= 0) return null;
  const qty = BigInt(first.qty);
  if (charged % qty !== 0n) return null;
  const unit = charged / qty;
  if (cash % unit !== 0n) return null;
  let units = cash / unit;
  const left = group.reduce((n, s) => n + BigInt(Math.max(0, s.leftQty)), 0n);
  if (units > left) return null;

  const lines: CoreRefundLine[] = [];
  for (const s of group) {
    const available = BigInt(Math.max(0, s.leftQty));
    const taken = units < available ? units : available;
    if (taken === 0n) continue;
    units -= taken;
    const money = taken * unit;
    // Split by the line's own recorded tax, never a rate recalculated from
    // a rounded unit price.
    const exTax = taxesIncluded ? s.amount - s.tax : s.amount;
    const ex = mulDivRound(
      money,
      exTax,
      cashOf(s.amount, s.tax, taxesIncluded),
    );
    lines.push({
      lineId: s.lineId!,
      quantity: countOf(taken),
      amount: taxesIncluded ? money : ex,
      tax: money - ex,
    });
  }
  return { lines, shipping: none };
}

/** A unit count known to fit (it is at most a line's quantity). */
function countOf(n: bigint): number {
  return parseInt(n.toString(), 10);
}

/** Takes a refund's lines and shipping off what the slots have left. */
function take(slots: Slot[], refund: CoreRefund): void {
  for (const r of refund.lines) {
    const s = slots.find((x) => x.lineId === r.lineId);
    if (s === undefined) continue;
    s.leftQty -= r.quantity;
    s.leftAmount -= r.amount;
    s.leftTax -= r.tax;
  }
  const ship = slots.find((x) => x.lineId === null);
  if (ship !== undefined) {
    ship.leftAmount -= refund.shipping.amount;
    ship.leftTax -= refund.shipping.tax;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
