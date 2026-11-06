// Usage: node scripts/add-audio.mjs [csvPath] [--dry-run] [--limit N]
// Adds an `audio` column (audio/<name-location-action>.mp3) and generates the clips.
import OpenAI from "openai";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { readFile, writeFile, rename, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";

process.loadEnvFile(".env");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");

const settings = JSON.parse(await readFile("settings.json", "utf8"));
const csvPath = resolve(positional[0] ?? settings.hospitals.path);
const { model, voice, dir } = settings.audio;
const audioDir = resolve(dir);

const slug = (r) => `${r.name}-${r.location}-${r.action}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const exists = (p) => access(p).then(() => true, () => false);

const rows = parse(await readFile(csvPath, "utf8"), { columns: true, skip_empty_lines: true, trim: true, bom: true });
const clips = new Map(); // slug -> row
for (const row of rows) {
  const s = slug(row);
  const key = `${row.name}|${row.location}|${row.action}`;
  const prior = clips.get(s);
  if (prior && prior.key !== key) throw new Error(`Slug collision: "${s}" for ${prior.key} and ${key}`);
  clips.set(s, { key, row });
  row.audio = `audio/${s}.mp3`;
}
console.log(`${rows.length} rows, ${clips.size} distinct clips`);

if (!dryRun) {
  await mkdir(audioDir, { recursive: true });
  const client = new OpenAI();
  const todo = [];
  for (const [s, { row }] of clips) {
    if (todo.length < limit && !(await exists(resolve(audioDir, `${s}.mp3`)))) todo.push([s, row]);
  }
  console.log(`Generating ${todo.length} clips (${clips.size - todo.length} skipped)`);
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < todo.length) {
      const [s, row] = todo[next++];
      const speech = await client.audio.speech.create({
        model, voice, input: `Transferring you to ${row.action} department at ${row.name}`,
      });
      await writeFile(resolve(audioDir, `${s}.mp3`), Buffer.from(await speech.arrayBuffer()));
    }
  }));
}

const columns = [...Object.keys(rows[0]).filter((c) => c !== "audio"), "audio"];
const tmp = `${csvPath}.tmp`;
await writeFile(tmp, stringify(rows, { header: true, columns }));
await rename(tmp, csvPath);
console.log(`Updated ${csvPath}`);
