export function parseViewsArg(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "views" || a === "v") {
      return validate(argv[i + 1]);
    }
    if (typeof a === "string" && a.startsWith("views=")) {
      return validate(a.slice("views=".length));
    }
    if (typeof a === "string" && a.startsWith("v=")) {
      return validate(a.slice("v=".length));
    }
  }
  return 0;
}

function validate(v: string | undefined): number {
  if (v === undefined) {
    throw new Error("views/v requires a numeric value (views >= 0)");
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid views value: ${v}`);
  }
  return n;
}
