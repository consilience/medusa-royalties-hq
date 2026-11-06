// Links into the Royalties HQ web app, for push-result emails and the
// admin page.
//
// An accepted push returns only `import_id` and an API `links.self`, neither of
// which a person can open, so the page's address is built from the import id.

/**
 * `{install}/sales-file-upload/{importId}`, where the install is the API
 * base URL without its `/api/v1` suffix (an install on a sub-path keeps
 * its prefix, the web app lives beside its API).
 */
export function rhqImportUrl(baseUrl: string, importId: number): string {
  if (!Number.isInteger(importId) || importId <= 0) {
    throw new Error(`Not an RHQ import id: ${importId}`);
  }
  const url = new URL(baseUrl);
  const installPath = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/, "");
  return `${url.origin}${installPath}/sales-file-upload/${importId}`;
}
