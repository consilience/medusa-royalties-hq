
import { rhqImportUrl } from "../links";

describe("rhqImportUrl", () => {
  it("links the import's page on the install the API lives on", () => {
    expect(rhqImportUrl("https://acme.royaltieshq.com/api/v1", 342)).toBe(
      "https://acme.royaltieshq.com/sales-file-upload/342",
    );
  });

  it("ignores a trailing slash and keeps a custom domain and port", () => {
    expect(
      rhqImportUrl("https://royalties.example-press.com:8443/api/v1/", 7),
    ).toBe("https://royalties.example-press.com:8443/sales-file-upload/7");
  });

  it("keeps a sub-path install's prefix", () => {
    expect(rhqImportUrl("https://example.com/rhq/api/v1", 7)).toBe(
      "https://example.com/rhq/sales-file-upload/7",
    );
  });

  it("refuses an id that is not a positive integer", () => {
    for (const id of [0, -1, 1.5, Number.NaN]) {
      expect(() => rhqImportUrl("https://a.example/api/v1", id)).toThrow();
    }
  });
});
