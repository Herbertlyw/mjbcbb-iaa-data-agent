// Validate physical integer inputs before recomputing captured JOIN aggregates.

export type JoinIntegerType =
  | "Int8" | "UInt8"
  | "Int16" | "UInt16"
  | "Int32" | "UInt32"
  | "Int64" | "UInt64";

/** Recognize the bounded integer types supported by captured JOIN proofs. */
export function joinIntegerType(type: string): JoinIntegerType | null {
  const plain = type.replace(/\s/gu, "").replace(/^Nullable\((.*)\)$/iu, "$1").toLowerCase();
  switch (plain) {
    case "int8": return "Int8";
    case "uint8": return "UInt8";
    case "int16": return "Int16";
    case "uint16": return "UInt16";
    case "int32": return "Int32";
    case "uint32": return "UInt32";
    case "int64": return "Int64";
    case "uint64": return "UInt64";
    default: return null;
  }
}

/** Reject rounded numbers and values outside their declared physical type. */
export function joinIntegerValue(value: unknown, type: JoinIntegerType): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  // Query/resource bytes are untrusted; bound the spelling before BigInt parsing.
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,19})$/u.test(value)) return null;
  const integer = BigInt(value);
  const bits = BigInt(type.replace(/\D/gu, ""));
  const unsigned = type.startsWith("U");
  const minimum = unsigned ? 0n : -(1n << (bits - 1n));
  const maximum = (1n << (unsigned ? bits : bits - 1n)) - 1n;
  return integer >= minimum && integer <= maximum ? integer.toString() : null;
}

/** Bound a database SUM using its input type and independently counted rows. */
export function joinIntegerSumSafe(rows: number, type: JoinIntegerType): boolean {
  if (!Number.isSafeInteger(rows) || rows < 1) return false;
  const count = BigInt(rows);
  const bits = BigInt(type.replace(/\D/gu, ""));
  if (type.startsWith("U")) return count * ((1n << bits) - 1n) <= (1n << 64n) - 1n;
  return count * (1n << (bits - 1n)) <= 1n << 63n;
}
