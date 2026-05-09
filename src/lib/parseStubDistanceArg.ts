export type StubDistance = "long" | "short";

/**
 * Parse optional stub-distance flags:
 * - `stub long` / `stub short`
 * - `stub=long` / `stub=short`
 * - `--stub-long` / `--stub-short`
 *
 * Case 6 and the stub-promo spike default to `"short"` (~7d) when omitted — see those scripts.
 */
export function parseStubDistanceArg(
  argv: readonly string[],
): StubDistance | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stub-long") {
      return "long";
    }
    if (a === "--stub-short") {
      return "short";
    }
    if (a === "stub") {
      return validate(argv[i + 1]);
    }
    if (typeof a === "string" && a.startsWith("stub=")) {
      return validate(a.slice("stub=".length));
    }
  }
  return undefined;
}

function validate(v: string | undefined): StubDistance {
  if (v === "long" || v === "short") {
    return v;
  }
  throw new Error(`Invalid stub value: ${v ?? "<missing>"} (expected long|short)`);
}
