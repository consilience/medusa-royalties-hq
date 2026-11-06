/**
 * Canonical JSON: object keys sorted (UTF-16 code unit order, which is what
 * Array.prototype.sort gives without a comparator) at every depth, no
 * whitespace, strings escaped by JSON.stringify.
 *
 * Why: the payload hash is how the app tells "this month's snapshot changed"
 * from "the same snapshot again". Hashing
 * JSON.stringify output would make the hash depend on the order properties
 * happened to be assigned in, so a harmless refactor would look like a data
 * change. The edge should send exactly this string as the request body, so
 * the hash it stores is the hash of what RHQ received.
 *
 * It is strict about what it accepts: a bigint or a fractional number here
 * means money escaped the decimal-string rule, and silently printing it would
 * put a float on the wire. `undefined` object members are dropped, exactly as
 * JSON.stringify drops them, so the canonical form equals the parsed body.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, "$");
}

function serialise(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // Counts only (units, schema_version): money is always a string.
      if (!Number.isSafeInteger(value)) {
        throw new Error(
          `canonicalJson: ${path} is ${value}; only safe integers may be JSON numbers`,
        );
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => serialise(v, `${path}[${i}]`)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const v = record[key];
        if (v === undefined) continue;
        members.push(
          `${JSON.stringify(key)}:${serialise(v, `${path}.${key}`)}`,
        );
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new Error(
        `canonicalJson: ${path} is a ${typeof value}, which JSON cannot carry exactly`,
      );
  }
}
