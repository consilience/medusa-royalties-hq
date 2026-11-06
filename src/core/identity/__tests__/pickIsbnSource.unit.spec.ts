import { pickIsbnSource, type IsbnCandidates } from "../../identity";

function candidates(overrides: Partial<IsbnCandidates> = {}): IsbnCandidates {
  return { ean: null, barcode: null, upc: null, sku: null, ...overrides };
}

describe("pickIsbnSource: auto", () => {
  it("takes the first valid ISBN in the order ean, barcode, upc, sku", () => {
    const all = candidates({
      ean: "9780306406157",
      barcode: "9781861972712",
      upc: "9780141036144",
      sku: "9780747532743",
    });
    expect(pickIsbnSource(all, "auto")).toBe("9780306406157");
    expect(pickIsbnSource({ ...all, ean: null }, "auto")).toBe("9781861972712");
    expect(pickIsbnSource({ ...all, ean: null, barcode: null }, "auto")).toBe(
      "9780141036144",
    );
    expect(
      pickIsbnSource({ ...all, ean: null, barcode: null, upc: null }, "auto"),
    ).toBe("9780747532743");
  });

  it("skips blank and invalid candidates", () => {
    // A store keeps a plain EAN-13 (not 978/979) or a UPC in these fields as
    // often as an ISBN; neither is an ISBN, so auto must look further.
    expect(
      pickIsbnSource(
        candidates({
          ean: "5012345678900",
          barcode: "  ",
          upc: "036000291452",
          sku: "9780306406157",
        }),
        "auto",
      ),
    ).toBe("9780306406157");
  });

  it("accepts an ISBN-10 and formatted values, returned as stored", () => {
    // Normalising (and converting ISBN-10) is resolveIdentifiers' job; the
    // picker only chooses which stored value to hand it.
    expect(pickIsbnSource(candidates({ barcode: "0-8044-2957-X" }), "auto")).toBe(
      "0-8044-2957-X",
    );
    expect(
      pickIsbnSource(candidates({ ean: "978-0-306-40615-7" }), "auto"),
    ).toBe("978-0-306-40615-7");
  });

  it("ignores control characters when judging a candidate, as resolveIdentifiers does", () => {
    expect(
      pickIsbnSource(candidates({ ean: "9780306406157\r\n" }), "auto"),
    ).toBe("9780306406157\r\n");
    expect(
      pickIsbnSource(candidates({ ean: "\u00009780306406157" }), "auto"),
    ).toBe("\u00009780306406157");
  });

  it("is null when no candidate is an ISBN, so no invalid-ISBN warning is raised", () => {
    // Auto found nothing; a SKU such as "POPPY-PB" is not a wrong ISBN.
    expect(pickIsbnSource(candidates({ sku: "POPPY-PB" }), "auto")).toBeNull();
    expect(pickIsbnSource(candidates(), "auto")).toBeNull();
  });
});

describe("pickIsbnSource: a named field", () => {
  it.each(["ean", "barcode", "upc", "sku"] as const)(
    "returns %s as it is, even when it is not a valid ISBN",
    (field) => {
      // The publisher chose this field, so an invalid value must still reach
      // resolveIdentifiers and be reported as an invalid ISBN.
      const all = candidates({
        ean: "ean-value",
        barcode: "barcode-value",
        upc: "upc-value",
        sku: "sku-value",
      });
      expect(pickIsbnSource(all, field)).toBe(`${field}-value`);
    },
  );

  it("does not fall back to another field when the named one is blank", () => {
    expect(
      pickIsbnSource(candidates({ ean: null, sku: "9780306406157" }), "ean"),
    ).toBeNull();
  });
});
