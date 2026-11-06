
import {
  importProblemKind,
  sanitiseRhqMessage,
  summariseImportErrors,
  SUMMARY_MAX_CHARS,
} from "../importErrors";

// RHQ's own view of a staged month's import, reduced to what the Status page
// may show: a count, one short sanitised line, and a stable reason code.

describe("sanitiseRhqMessage", () => {
  it("strips control and direction-override characters and folds whitespace", () => {
    expect(
      sanitiseRhqMessage("Unexpected\u0000 error\r\n\twhile‮ importing\u0007"),
    ).toBe("Unexpected error while importing");
  });

  it("truncates to the limit, marking the cut", () => {
    const out = sanitiseRhqMessage("x".repeat(1000));
    expect(out).toHaveLength(SUMMARY_MAX_CHARS);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("never decodes HTML: markup stays text for React to escape", () => {
    expect(sanitiseRhqMessage("&lt;b&gt; <script>x</script>")).toBe(
      "&lt;b&gt; <script>x</script>",
    );
  });

  it("gives null for nothing left", () => {
    expect(sanitiseRhqMessage(" \u0000\n ")).toBeNull();
  });
});

describe("summariseImportErrors", () => {
  it("takes RHQ's count, the first message and no reason (today's shape)", () => {
    expect(
      summariseImportErrors({
        counts: { rows: 2, errors: 1, warnings: 0 },
        errorEntries: [
          {
            key: "rows",
            message:
              "Unexpected error while importing: the import could not be saved",
            reason: null,
          },
        ],
      }),
    ).toEqual({
      count: 1,
      summary:
        "Unexpected error while importing: the import could not be saved",
      reason: null,
    });
  });

  it("prefers the entry with a reason code (the proposed shape)", () => {
    expect(
      summariseImportErrors({
        counts: { rows: 2, errors: 2, warnings: 0 },
        errorEntries: [
          { key: "rows.1", message: "Unknown product.", reason: null },
          {
            key: "rows",
            message: "The import could not be completed.",
            reason: "import_failed",
          },
        ],
      }),
    ).toEqual({
      count: 2,
      summary: "The import could not be completed.",
      reason: "import_failed",
    });
  });

  it("drops a reason that is not a plain code", () => {
    expect(
      summariseImportErrors({
        counts: { rows: 0, errors: 1, warnings: 0 },
        errorEntries: [
          { key: "rows", message: "m", reason: "<b>import failed</b>" },
        ],
      }).reason,
    ).toBeNull();
  });

  it("records a clean month as zero errors", () => {
    expect(
      summariseImportErrors({
        counts: { rows: 2, errors: 0, warnings: 1 },
        errorEntries: [],
      }),
    ).toEqual({ count: 0, summary: null, reason: null });
  });
});

describe("importProblemKind", () => {
  it("is null without errors", () => {
    expect(importProblemKind({ count: 0, summary: null, reason: null })).toBe(
      null,
    );
    expect(
      importProblemKind({ count: null, summary: null, reason: null }),
    ).toBe(null);
  });

  it("is import_failed for the code, or today's message", () => {
    expect(
      importProblemKind({
        count: 1,
        summary: "Whatever",
        reason: "import_failed",
      }),
    ).toBe("import_failed");
    expect(
      importProblemKind({
        count: 1,
        summary: "Unexpected error while importing: boom",
        reason: null,
      }),
    ).toBe("import_failed");
  });

  it("is errors for any other non-zero count", () => {
    expect(
      importProblemKind({
        count: 3,
        summary: "Unknown product.",
        reason: null,
      }),
    ).toBe("errors");
  });
});
