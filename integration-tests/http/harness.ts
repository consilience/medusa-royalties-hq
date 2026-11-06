// Shared facts for the HTTP harness. The JWT secret signs admin tokens in
// helpers/admin.ts; it only ever exists in a throwaway test database's app.
export const HARNESS = {
  jwtSecret: "harness-only-secret",
  // Seals stored tokens in the harness only (32 bytes, base64).
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
}
