import { resolveBundles } from "../../bundles";
import type {
  EffectiveLine,
  EffectiveRefundLine,
} from "../../bundles";
import { settings } from "../../__tests__/support/builders";
import { expectedMoney, fixtureFiles, loadFixture } from "../../__tests__/support/fixtureLoader";

// The hand-built fixtures (__tests__/fixtures/bundles/README.md).
// Each expectation lists only the fields it is about; the rest are checked
// by the unit and property tests.

function view(l: EffectiveLine | EffectiveRefundLine) {
  return {
    ...l,
    method: l.bundle?.method ?? null,
    bundle: l.bundle?.ref ?? null,
  };
}

const files = fixtureFiles();

describe("bundle fixtures", () => {
  it("finds the fixture set", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  for (const file of files) {
    const fx = loadFixture(file);
    describe(file, () => {
      for (const c of fx.cases) {
        it(c.name, () => {
          const result = resolveBundles(
            fx.order,
            fx.products,
            settings(c.settings),
          );
          const cur = fx.order.currency;

          if (c.expect.sales) {
            expect(result.sale.lines).toHaveLength(c.expect.sales.length);
            c.expect.sales.forEach((e, i) => {
              expect(view(result.sale.lines[i]!)).toMatchObject(
                expectedMoney(e, cur),
              );
            });
          }
          for (const er of c.expect.refunds ?? []) {
            const actual = result.refunds.find(
              (r) => r.refundId === er.refundId,
            );
            expect(actual).toBeDefined();
            expect(actual!.lines).toHaveLength(er.lines.length);
            er.lines.forEach((e, i) => {
              expect(view(actual!.lines[i]!)).toMatchObject(
                expectedMoney(e, cur),
              );
            });
          }
          if (c.expect.bundleSplitFallbacks) {
            expect(result.notes.bundleSplitFallbacks).toEqual(
              c.expect.bundleSplitFallbacks,
            );
          }
          if (c.expect.unknownBundleLines) {
            expect(
              result.notes.unknownBundleLines.map((u) => u.lineId),
            ).toEqual(c.expect.unknownBundleLines);
          }
        });
      }
    });
  }
});
