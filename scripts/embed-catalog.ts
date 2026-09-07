/**
 * Embeds the dress collection so photos can be matched against it.
 *
 * The collection arrives as a folder of JPEGs whose filenames are the article
 * codes the business already uses in conversation (B2501.jpg -> B2501). That
 * is what makes a match useful: the answer is a code someone can act on, not a
 * filename.
 *
 * Run once per collection drop; re-running only embeds what is new, so adding
 * a season means dropping the files in and running it again.
 *
 * Spends a fraction of a cent: roughly 300 tokens an image at $0.005 per
 * million, so all 406 come to well under one cent.
 *
 * Run:  npm run embed:catalog
 *   CATALOG_DIR=path      folder of images (default kataloq/kolleksiya)
 *   CATALOG_FORCE=1       re-embed items already stored
 *   CATALOG_DRY_RUN=1     count and price it, call nothing
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const DEFAULT_DIR = path.resolve(process.cwd(), "kataloq/kolleksiya");

/** Article codes start with letters and end with digits: B2501, SS2384. */
function seriesOf(code: string): string {
  return (/^([A-Za-z]+)/.exec(code)?.[1] ?? "?").toUpperCase();
}

async function main() {
  const { prepareImage, embedImage, toVectorLiteral, IMAGE_MODEL } =
    await import("../src/lib/image-match");
  const { pool } = await import("../src/lib/db");

  const dir = process.env.CATALOG_DIR ?? DEFAULT_DIR;
  const force = process.env.CATALOG_FORCE === "1";
  const dryRun = process.env.CATALOG_DRY_RUN === "1";

  if (!fs.existsSync(dir)) throw new Error(`Kataloq qovluğu yoxdur: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();

  const { rows: existing } = await pool.query(
    `SELECT code FROM katibe.catalog_item WHERE embedding IS NOT NULL`,
  );
  const have = new Set(existing.map((r) => r.code as string));
  const todo = files.filter((f) => force || !have.has(path.parse(f).name));

  console.log(
    `${files.length} fayl · ${have.size} artıq var · ${todo.length} embed olunacaq` +
      `${dryRun ? " · QURU İŞLƏMƏ" : ""}`,
  );
  if (dryRun || todo.length === 0) {
    await pool.end();
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const [i, file] of todo.entries()) {
    const code = path.parse(file).name;
    const full = path.join(dir, file);
    try {
      const vector = await embedImage(await prepareImage(full));
      await pool.query(
        `INSERT INTO katibe.catalog_item (code, series, file_path, embedding, model)
         VALUES ($1,$2,$3,$4::vector,$5)
         ON CONFLICT (code) DO UPDATE
           SET series = EXCLUDED.series, file_path = EXCLUDED.file_path,
               embedding = EXCLUDED.embedding, model = EXCLUDED.model,
               created_at = now()`,
        [code, seriesOf(code), full, toVectorLiteral(vector), IMAGE_MODEL],
      );
      ok++;
    } catch (e) {
      // One bad file must not end the run — the collection is the asset here,
      // and a re-run picks up whatever failed.
      failed.push(`${code}: ${(e as Error).message.slice(0, 80)}`);
    }
    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${todo.length}        `);
    }
  }
  console.log(`\rBitdi — ${ok} paltar embed olundu, ${failed.length} xəta.${" ".repeat(10)}`);
  for (const f of failed.slice(0, 10)) console.log(`  ${f}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
