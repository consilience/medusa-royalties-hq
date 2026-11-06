import { isValidIsbn13 } from "../identity";
import { TITLE_MAX_LENGTH } from "../rows/aggregate";
import type { SnapshotRowV1 } from "./types";

/**
 * The header row of RHQ's sales import template, in order, so the file is the
 * one a publisher downloads and recognises.
 */
export const RHQ_SALES_CSV_HEADERS = [
  "isbn",
  "asin",
  "apple_books_id",
  "acx_id",
  "google_play_id",
  "other_product_id",
  "sales_channel",
  "marketplace",
  "sale_country",
  "currency",
  "sales_month",
  "units_sold",
  "royalty_on_sales",
  "units_returned",
  "royalty_on_returns",
  "kenp_read",
  "list_price",
  "discount_percent",
  "title",
  "author",
] as const;

type Column = (typeof RHQ_SALES_CSV_HEADERS)[number];

export interface CsvOptions {
  /** "YYYY-MM"; becomes every row's sales_month. */
  period: string;
  /** RHQ marketplace code; the connection's own when known. */
  marketplace?: string;
}

/**
 * UTF-8 byte order mark. Included because the export's main reader is a
 * publisher opening it in Excel, which without a BOM decodes UTF-8 as the
 * Windows code page and mangles every accented or non-Latin title. RHQ's
 * importer strips a UTF-8 BOM before reading the header
 * (ReadsHeaderRow::decodeHeaderChunk, and PhpSpreadsheet's CSV reader), so
 * the same file still imports unchanged.
 */
const BOM = "﻿";

/** RFC 4180 record separator; Excel expects CRLF. */
const CRLF = "\r\n";

// The API's Money pattern. Amount cells are checked against it so that no
// cell escapes neutralisation by pretending to be a number: a genuine
// "-13.39" is left alone, anything else is refused.
const MONEY = /^-?\d+(?:\.\d+)?$/;
const PERCENT = /^\d{1,3}(?:\.\d+)?$/;

/**
 * Prefixes a value that a spreadsheet would run as a formula with a single
 * quote (OWASP "CSV Injection": cells starting with = + - @, tab or carriage
 * return). Titles and identifiers come from the store's catalogue, which any
 * staff member can edit, and this file is opened by the publisher in Excel.
 *
 * The quote changes the value: a SKU really starting with "-" arrives in RHQ
 * as "'-…" and will not match. That is the documented OWASP trade-off, and
 * the lesser harm; the API path, which is not a spreadsheet, is unaffected.
 */
export function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * One RFC 4180 field: quoted only when it holds a comma, a double quote, CR
 * or LF, with embedded quotes doubled. Quoting only when needed keeps the
 * output byte-identical to a hand-made template file for ordinary rows.
 */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function text(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : neutraliseFormula(value);
}

function amount(value: string | null, column: Column): string {
  if (value === null) return "";
  if (!MONEY.test(value)) {
    throw new Error(
      `CSV ${column}: ${JSON.stringify(value)} is not a decimal amount`,
    );
  }
  return value;
}

function title(value: string | null): string {
  if (value === null) return "";
  const cell = neutraliseFormula(value);
  // RHQ caps titles at 1,000 characters; a title already at the cap would go
  // over by the one quote that neutralising adds and fail the whole import.
  const chars = [...cell];
  return chars.length > TITLE_MAX_LENGTH
    ? chars.slice(0, TITLE_MAX_LENGTH).join("")
    : cell;
}

/**
 * Identifier columns, as RHQ maps them: an
 * override is sent alone, in `isbn` when it is a valid ISBN-13 (so RHQ's ISBN
 * checks see it) and in `other_product_id` otherwise; without one, isbn →
 * isbn, asin → asin, sku → other_product_id. store_product_id is audit only
 * and never reaches a sales line.
 */
function identifierCells(
  ids: SnapshotRowV1["identifiers"],
): Pick<Record<Column, string>, "isbn" | "asin" | "other_product_id"> {
  if (ids.rhq_product_id !== null) {
    return isValidIsbn13(ids.rhq_product_id)
      ? { isbn: text(ids.rhq_product_id), asin: "", other_product_id: "" }
      : { isbn: "", asin: "", other_product_id: text(ids.rhq_product_id) };
  }
  return {
    isbn: text(ids.isbn),
    asin: text(ids.asin),
    other_product_id: text(ids.sku),
  };
}

/**
 * The snapshot's rows as an RHQ generic sales CSV: the same rows the
 * API receives, for a publisher who imports by hand or wants to inspect a
 * push in a spreadsheet. UTF-8 with a BOM, CRLF line endings, a CRLF after
 * the last record too.
 */
export function snapshotRowsToCsv(
  rows: readonly SnapshotRowV1[],
  options: CsvOptions,
): string {
  const lines = [RHQ_SALES_CSV_HEADERS.join(",")];
  for (const row of rows) {
    if (row.discount_percent !== null && !PERCENT.test(row.discount_percent)) {
      throw new Error(
        `CSV discount_percent: ${JSON.stringify(row.discount_percent)} is not a percentage`,
      );
    }
    const cells: Record<Column, string> = {
      ...identifierCells(row.identifiers),
      apple_books_id: "",
      acx_id: "",
      google_play_id: "",
      // Fixed, as the API fixes them: these are e-commerce sales of this
      // store's marketplace.
      sales_channel: "e-commerce",
      marketplace: text(options.marketplace ?? "medusa"),
      sale_country: text(row.sale_country),
      currency: text(row.currency),
      sales_month: text(options.period),
      units_sold: String(row.units_sold),
      royalty_on_sales: amount(row.royalty_on_sales, "royalty_on_sales"),
      units_returned: String(row.units_refunded),
      royalty_on_returns: amount(row.royalty_on_refunds, "royalty_on_returns"),
      kenp_read: "",
      list_price: amount(row.list_price, "list_price"),
      discount_percent: row.discount_percent ?? "",
      title: title(row.title),
      author: "",
    };
    lines.push(RHQ_SALES_CSV_HEADERS.map((c) => csvCell(cells[c])).join(","));
  }
  return `${BOM}${lines.join(CRLF)}${CRLF}`;
}
