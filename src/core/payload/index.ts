// Public payload API: the RHQ snapshot (PayloadV1) and its canonical form.
// Hashing lives at the edge; the core only guarantees a canonical
// serialisation to hash.
export {
  buildSnapshot,
  canonicalPercent,
  MAX_SNAPSHOT_ROWS,
} from "./payloadV1";
export type {
  BuildSnapshotInput,
  BuildSnapshotResult,
  IgnoredMoneyOnlyRefundReport,
  UnlinedRefundMode,
} from "./payloadV1";
export { canonicalJson } from "./canonical";
export { buildSummary, moneyByCurrency } from "./summary";
export type {
  BreakdownV1,
  MoneyByCurrency,
  MoneyString,
  PayloadV1,
  PercentString,
  RowCountError,
  SnapshotRowV1,
  SnapshotSettingsV1,
  SnapshotWarning,
  SnapshotWarningCode,
  SummaryV1,
} from "./types";
export {
  csvCell,
  neutraliseFormula,
  RHQ_SALES_CSV_HEADERS,
  snapshotRowsToCsv,
} from "./csv";
export type { CsvOptions } from "./csv";
