import {
  csvCell,
  neutraliseFormula,
  RHQ_SALES_CSV_HEADERS,
  snapshotRowsToCsv,
  type SnapshotRowV1,
} from "../../payload";

// The header row of RHQ's generic sales template, copied here because CI
// can't read it. If RHQ changes its template, this is the line to update.
const TEMPLATE_HEADER =
  "isbn,asin,apple_books_id,acx_id,google_play_id,other_product_id,sales_channel,marketplace,sale_country,currency,sales_month,units_sold,royalty_on_sales,units_returned,royalty_on_returns,kenp_read,list_price,discount_percent,title,author";

const BOM = "﻿";

function row(overrides: Partial<SnapshotRowV1> = {}): SnapshotRowV1 {
  return {
    identifiers: {
      rhq_product_id: null,
      isbn: "9781402894626",
      sku: "POPPY-PB",
      asin: "B00TEST123",
      store_product_id: "1234",
    },
    title: "Poppy's Promise",
    sale_country: "NZ",
    currency: "NZD",
    units_sold: 14,
    royalty_on_sales: "187.43",
    units_refunded: 1,
    royalty_on_refunds: "-13.39",
    list_price: "29.99",
    discount_percent: "8.5000",
    breakdown: null,
    ...overrides,
  };
}

/** Minimal RFC 4180 parser, to prove the output round-trips field for field. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i++;
    } else {
      field += c;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function body(csv: string): Record<string, string>[] {
  const [header, ...records] = parseCsv(csv.slice(BOM.length));
  return records.map((r) =>
    Object.fromEntries(header!.map((h, i) => [h, r[i]!])),
  );
}

const toCsv = (rows: SnapshotRowV1[]) =>
  snapshotRowsToCsv(rows, { period: "2026-08" });

describe("snapshotRowsToCsv: layout", () => {
  it("uses the RHQ template's header row, in order", () => {
    expect(RHQ_SALES_CSV_HEADERS.join(",")).toBe(TEMPLATE_HEADER);
    expect(toCsv([])).toBe(`${BOM}${TEMPLATE_HEADER}\r\n`);
  });

  it("starts with a UTF-8 BOM and ends every record with CRLF", () => {
    const csv = toCsv([row(), row({ currency: "GBP" })]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(4);
    expect(/(?<!\r)\n/.test(csv)).toBe(false);
  });

  it("fills the fixed columns and the row's figures", () => {
    const [r] = body(toCsv([row()]));
    expect(r).toEqual({
      isbn: "9781402894626",
      asin: "B00TEST123",
      apple_books_id: "",
      acx_id: "",
      google_play_id: "",
      other_product_id: "POPPY-PB",
      sales_channel: "e-commerce",
      // With no marketplace given, the platform's own code.
      marketplace: "medusa",
      sale_country: "NZ",
      currency: "NZD",
      sales_month: "2026-08",
      units_sold: "14",
      royalty_on_sales: "187.43",
      units_returned: "1",
      royalty_on_returns: "-13.39",
      kenp_read: "",
      list_price: "29.99",
      discount_percent: "8.5000",
      title: "Poppy's Promise",
      author: "",
    });
  });

  it("leaves null list price, discount and title empty", () => {
    const [r] = body(
      toCsv([row({ list_price: null, discount_percent: null, title: null })]),
    );
    expect(r).toMatchObject({
      list_price: "",
      discount_percent: "",
      title: "",
    });
  });

  it("uses a custom marketplace code when given", () => {
    const csv = snapshotRowsToCsv([row()], {
      period: "2026-08",
      marketplace: "my-shop",
    });
    expect(body(csv)[0]!.marketplace).toBe("my-shop");
  });
});

describe("snapshotRowsToCsv: identifier mapping", () => {
  const ids = (o: Partial<SnapshotRowV1["identifiers"]>) =>
    row({
      identifiers: {
        rhq_product_id: null,
        isbn: null,
        sku: null,
        asin: null,
        store_product_id: "99",
        ...o,
      },
    });

  it("puts an override that is a valid ISBN-13 in isbn, alone", () => {
    const [r] = body(toCsv([ids({ rhq_product_id: "9781402894626" })]));
    expect(r).toMatchObject({
      isbn: "9781402894626",
      asin: "",
      other_product_id: "",
    });
  });

  it("puts any other override in other_product_id, alone", () => {
    const [r] = body(toCsv([ids({ rhq_product_id: "RHQ-42" })]));
    expect(r).toMatchObject({ isbn: "", asin: "", other_product_id: "RHQ-42" });
  });

  it("maps isbn → isbn, asin → asin, sku → other_product_id", () => {
    const [r] = body(
      toCsv([ids({ isbn: "9781402894626", asin: "B01", sku: "S-1" })]),
    );
    expect(r).toMatchObject({
      isbn: "9781402894626",
      asin: "B01",
      other_product_id: "S-1",
    });
  });

  it("never writes store_product_id", () => {
    const csv = toCsv([ids({ sku: "S-1", store_product_id: "5550123" })]);
    expect(csv).not.toContain("5550123");
  });
});

describe("snapshotRowsToCsv: amounts", () => {
  it("writes zero-decimal currencies without a decimal point", () => {
    const [r] = body(
      toCsv([
        row({
          currency: "JPY",
          royalty_on_sales: "2430",
          royalty_on_refunds: "-1215",
          list_price: "1500",
        }),
      ]),
    );
    expect(r).toMatchObject({
      currency: "JPY",
      royalty_on_sales: "2430",
      royalty_on_returns: "-1215",
      list_price: "1500",
    });
  });

  it("writes three-decimal currencies with three places", () => {
    const [r] = body(
      toCsv([row({ currency: "KWD", royalty_on_sales: "12.345" })]),
    );
    expect(r!.royalty_on_sales).toBe("12.345");
  });

  it("does not neutralise negative amounts, which are numbers, not formulas", () => {
    const [r] = body(toCsv([row({ royalty_on_refunds: "-13.39" })]));
    expect(r!.royalty_on_returns).toBe("-13.39");
  });

  it("refuses an amount that is not a plain decimal", () => {
    expect(() => toCsv([row({ royalty_on_sales: "=1+1" })])).toThrow();
    expect(() => toCsv([row({ list_price: "1,000.00" })])).toThrow();
  });
});

describe("RFC 4180 quoting", () => {
  it.each([
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["line\nbreak", '"line\nbreak"'],
    ["cr\rhere", '"cr\rhere"'],
    ["", ""],
  ])("%j → %j", (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });

  it("round-trips awkward titles field for field", () => {
    const title = 'A "quoted", comma-laden title';
    const records = parseCsv(toCsv([row({ title })]).slice(BOM.length));
    expect(records[1]).toHaveLength(RHQ_SALES_CSV_HEADERS.length);
    expect(body(toCsv([row({ title })]))[0]!.title).toBe(title);
  });
});

describe("formula injection (OWASP CSV injection)", () => {
  it.each([
    ['=HYPERLINK("http://x")', '\'=HYPERLINK("http://x")'],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTab", "'\tTab"],
    ["\rCR", "'\rCR"],
    ["Safe = later", "Safe = later"],
    ["", ""],
  ])("neutraliseFormula(%j) → %j", (value, expected) => {
    expect(neutraliseFormula(value)).toBe(expected);
  });

  it("neutralises titles", () => {
    const [r] = body(toCsv([row({ title: "=cmd|' /C calc'!A0" })]));
    expect(r!.title).toBe("'=cmd|' /C calc'!A0");
  });

  it("neutralises identifiers, which are free text too", () => {
    const [r] = body(
      toCsv([
        row({
          identifiers: {
            rhq_product_id: null,
            isbn: null,
            sku: "=SKU",
            asin: "@ASIN",
            store_product_id: "1",
          },
        }),
      ]),
    );
    expect(r).toMatchObject({ other_product_id: "'=SKU", asin: "'@ASIN" });
  });

  it("keeps a neutralised maximum-length title within RHQ's 1,000 characters", () => {
    const title = `=${"x".repeat(999)}`;
    const [r] = body(toCsv([row({ title })]));
    expect([...r!.title!]).toHaveLength(1000);
    expect(r!.title!.startsWith("'=")).toBe(true);
  });
});
