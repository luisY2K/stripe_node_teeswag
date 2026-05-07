export function parseMonthArg(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "month" || a === "m") {
      return validate(argv[i + 1]);
    }
    if (typeof a === "string" && a.startsWith("month=")) {
      return validate(a.slice("month=".length));
    }
    if (typeof a === "string" && a.startsWith("m=")) {
      return validate(a.slice("m=".length));
    }
  }
  return 0;
}

function validate(v: string | undefined): number {
  if (v === undefined) {
    throw new Error("month/m requires a numeric value (months >= 0)");
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid month value: ${v}`);
  }
  return n;
}
