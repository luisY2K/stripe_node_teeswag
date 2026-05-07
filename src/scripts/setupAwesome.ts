import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";

async function main(): Promise<void> {
  await ensureAwesomeCatalog({ verbose: true });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
