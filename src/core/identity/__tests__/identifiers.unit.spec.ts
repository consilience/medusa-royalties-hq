import {
  aggregationKey,
  parseStoreProductId,
  resolveIdentifiers,
  type IdentifierSource,
  type Identifiers,
} from "../../identity";

const VARIANT = "123456";

function source(overrides: Partial<IdentifierSource> = {}): IdentifierSource {
  return {
    rhqProductId: null,
    isbnSourceValue: null,
    sku: null,
    asin: null,
    ...overrides,
  };
}

describe("resolveIdentifiers", () => {
  it("sends isbn, sku and asin when there is no override", () => {
    const result = resolveIdentifiers(
      source({
        isbnSourceValue: "978-0-306-40615-7",
        sku: " POPPY-PB ",
        asin: "B00TEST123",
      }),
      VARIANT,
    );
    expect(result).toEqual({
      identifiers: {
        rhq_product_id: null,
        isbn: "9780306406157",
        sku: "POPPY-PB",
        asin: "B00TEST123",
        store_product_id: "123456",
      },
      warnings: [],
      sendable: true,
    });
  });

  it("converts an ISBN-10 source value to ISBN-13", () => {
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "0-8044-2957-X" }),
      VARIANT,
    );
    expect(result.identifiers.isbn).toBe("9780804429573");
    expect(result.sendable).toBe(true);
  });

  it("makes a non-blank override the only identifier sent", () => {
    const result = resolveIdentifiers(
      source({
        rhqProductId: "  RHQ-42 ",
        isbnSourceValue: "9780306406157",
        sku: "POPPY-PB",
        asin: "B00TEST123",
      }),
      VARIANT,
    );
    expect(result).toEqual({
      identifiers: {
        rhq_product_id: "RHQ-42",
        isbn: null,
        sku: null,
        asin: null,
        store_product_id: "123456",
      },
      warnings: [],
      sendable: true,
    });
  });

  it("does not validate the other identifiers when an override wins", () => {
    // They are not sent, so an invalid ISBN behind an override is not a
    // problem the summary should report.
    const result = resolveIdentifiers(
      source({ rhqProductId: "RHQ-42", isbnSourceValue: "not-an-isbn" }),
      VARIANT,
    );
    expect(result.warnings).toEqual([]);
  });

  it.each(["", "   ", "\t\n"])(
    "ignores a blank override %j and falls back to the other identifiers",
    (blank) => {
      const result = resolveIdentifiers(
        source({ rhqProductId: blank, sku: "POPPY-PB" }),
        VARIANT,
      );
      expect(result.identifiers.rhq_product_id).toBeNull();
      expect(result.identifiers.sku).toBe("POPPY-PB");
      expect(result.sendable).toBe(true);
    },
  );

  it("nulls an invalid ISBN with a warning but keeps the SKU", () => {
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "5012345678900", sku: "5012345678900" }),
      VARIANT,
    );
    expect(result.identifiers.isbn).toBeNull();
    expect(result.identifiers.sku).toBe("5012345678900");
    expect(result.warnings).toEqual(["invalid_isbn"]);
    expect(result.sendable).toBe(true);
  });

  it("treats a blank ISBN source as absent, not invalid", () => {
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "  ", sku: "POPPY-PB" }),
      VARIANT,
    );
    expect(result.identifiers.isbn).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("turns blank sku and asin into null", () => {
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "9780306406157", sku: "  ", asin: "" }),
      VARIANT,
    );
    expect(result.identifiers.sku).toBeNull();
    expect(result.identifiers.asin).toBeNull();
  });

  it("is not sendable when nothing usable remains", () => {
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "garbage", sku: " ", asin: null }),
      VARIANT,
    );
    expect(result.identifiers).toEqual({
      rhq_product_id: null,
      isbn: null,
      sku: null,
      asin: null,
      store_product_id: "123456",
    });
    expect(result.warnings).toEqual(["invalid_isbn"]);
    expect(result.sendable).toBe(false);
  });

  it("is not sendable when every source is null", () => {
    expect(resolveIdentifiers(source(), VARIANT).sendable).toBe(false);
  });

  it("strips control characters before trimming and validating", () => {
    const result = resolveIdentifiers(
      source({
        isbnSourceValue: "\u0000978-0306406157\r\n",
        sku: "POPPY\u0007-PB\u007f",
        asin: "\u0085B00TEST123\u009f",
      }),
      VARIANT,
    );
    expect(result.identifiers.isbn).toBe("9780306406157");
    expect(result.identifiers.sku).toBe("POPPY-PB");
    expect(result.identifiers.asin).toBe("B00TEST123");
  });

  it("treats a value of only control characters as blank", () => {
    const result = resolveIdentifiers(
      source({ rhqProductId: "\u0000\u0001", sku: "\u001b" }),
      VARIANT,
    );
    expect(result.identifiers.rhq_product_id).toBeNull();
    expect(result.identifiers.sku).toBeNull();
    expect(result.sendable).toBe(false);
  });

  it("accepts exactly 255 characters", () => {
    const sku = "S".repeat(255);
    const result = resolveIdentifiers(source({ sku }), VARIANT);
    expect(result.identifiers.sku).toBe(sku);
    expect(result.warnings).toEqual([]);
  });

  it("counts length in code points, as the API's maxLength does", () => {
    // 255 astral characters are 510 UTF-16 code units but 255 characters.
    const sku = "\u{1F4D6}".repeat(255);
    const result = resolveIdentifiers(source({ sku }), VARIANT);
    expect(result.identifiers.sku).toBe(sku);
  });

  it("refuses an over-long field rather than truncating it", () => {
    const result = resolveIdentifiers(
      source({ sku: "S".repeat(256), asin: "B00TEST123" }),
      VARIANT,
    );
    expect(result.identifiers.sku).toBeNull();
    expect(result.identifiers.asin).toBe("B00TEST123");
    expect(result.warnings).toEqual(["identifier_too_long"]);
    expect(result.sendable).toBe(true);
  });

  it("reports identifier_too_long once even when several fields are too long", () => {
    const result = resolveIdentifiers(
      source({ sku: "S".repeat(300), asin: "A".repeat(300) }),
      VARIANT,
    );
    expect(result.warnings).toEqual(["identifier_too_long"]);
    expect(result.sendable).toBe(false);
  });

  it("does not fall back from an over-long override to the other identifiers", () => {
    // The override was chosen precisely because the other identifiers match
    // the wrong product (or none); silently sending them would misattribute.
    const result = resolveIdentifiers(
      source({ rhqProductId: "R".repeat(256), sku: "POPPY-PB" }),
      VARIANT,
    );
    expect(result.identifiers).toEqual({
      rhq_product_id: null,
      isbn: null,
      sku: null,
      asin: null,
      store_product_id: "123456",
    });
    expect(result.warnings).toEqual(["identifier_too_long"]);
    expect(result.sendable).toBe(false);
  });

  it("reports an over-long ISBN source as an invalid ISBN", () => {
    // No ISBN is that long, so the useful signal for the publisher is that
    // their ISBN source is wrong, and it counts in summary.invalid_isbns.
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "9".repeat(300), sku: "POPPY-PB" }),
      VARIANT,
    );
    expect(result.identifiers.isbn).toBeNull();
    expect(result.warnings).toEqual(["invalid_isbn"]);
  });

  it("reports both warnings together", () => {
    const result = resolveIdentifiers(
      source({ isbnSourceValue: "123", sku: "S".repeat(256) }),
      VARIANT,
    );
    expect(result.warnings).toEqual(["invalid_isbn", "identifier_too_long"]);
  });

  it("sends a Medusa variant id as store_product_id unchanged", () => {
    const result = resolveIdentifiers(
      source({ sku: "X" }),
      "variant_01JC4Q8Z5X3M7T2V9B6N1K0P8R",
    );
    expect(result.identifiers.store_product_id).toBe(
      "variant_01JC4Q8Z5X3M7T2V9B6N1K0P8R",
    );
    expect(result.sendable).toBe(true);
  });

  it("leaves store_product_id null for a blank variant id", () => {
    const result = resolveIdentifiers(source({ sku: "X" }), "  ");
    expect(result.identifiers.store_product_id).toBeNull();
    expect(result.sendable).toBe(true);
  });
});

describe("parseStoreProductId", () => {
  it.each([
    ["123456", "123456"],
    [" 123456 ", "123456"],
    ["9007199254740993123", "9007199254740993123"],
    // Medusa ids are prefixed ULIDs and go through as they are.
    ["variant_01JC4Q8Z5X3M7T2V9B6N1K0P8R", "variant_01JC4Q8Z5X3M7T2V9B6N1K0P8R"],
    [" variant_01JC4Q8Z5X3M7T2V9B6N1K0P8R ", "variant_01JC4Q8Z5X3M7T2V9B6N1K0P8R"],
    ["abc", "abc"],
  ])("reads %j as %j", (input, expected) => {
    expect(parseStoreProductId(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "1".repeat(256),
  ])("rejects %j", (input) => {
    expect(parseStoreProductId(input)).toBeNull();
  });
});

describe("aggregationKey", () => {
  function ids(overrides: Partial<Identifiers> = {}): Identifiers {
    return {
      rhq_product_id: null,
      isbn: null,
      sku: null,
      asin: null,
      store_product_id: null,
      ...overrides,
    };
  }

  it("is stable for equal tuples", () => {
    const a = ids({ isbn: "9780306406157", sku: "POPPY-PB" });
    const b = ids({ isbn: "9780306406157", sku: "POPPY-PB" });
    expect(aggregationKey(a)).toBe(aggregationKey(b));
  });

  it("ignores store_product_id, which is audit only", () => {
    expect(aggregationKey(ids({ sku: "A", store_product_id: "1" }))).toBe(
      aggregationKey(ids({ sku: "A", store_product_id: "2" })),
    );
  });

  it("distinguishes an override from an ISBN with the same text", () => {
    expect(aggregationKey(ids({ rhq_product_id: "9780306406157" }))).not.toBe(
      aggregationKey(ids({ isbn: "9780306406157" })),
    );
  });

  it("distinguishes null from the string 'null' and from empty", () => {
    const keys = [
      aggregationKey(ids({ sku: "A", asin: null })),
      aggregationKey(ids({ sku: "A", asin: "null" })),
      aggregationKey(ids({ sku: "A", asin: "" })),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it("does not collide when values contain delimiters or quotes", () => {
    const tuples: Identifiers[] = [
      ids({ sku: "a|b", asin: "c" }),
      ids({ sku: "a", asin: "b|c" }),
      ids({ sku: 'a","b', asin: null }),
      ids({ sku: "a", asin: "b" }),
      ids({ sku: "a,b", asin: null }),
      ids({ sku: "a", asin: ",b" }),
      ids({ sku: "a\\", asin: "b" }),
      ids({ sku: "a", asin: "\\b" }),
      ids({ sku: "[a]", asin: null }),
      ids({ sku: null, asin: "a" }),
      ids({ sku: "a", asin: null }),
      ids({ isbn: "a", sku: null }),
    ];
    const keys = tuples.map(aggregationKey);
    expect(new Set(keys).size).toBe(tuples.length);
  });
});
