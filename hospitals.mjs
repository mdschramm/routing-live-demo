import { readFile, writeFile, rename, copyFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parse } from "csv-parse/sync";

const MAX_ROWS = 10_000;
const samplePath = resolve("hospitals.csv");

async function dataPath() {
  const settings = JSON.parse(await readFile(resolve("settings.json"), "utf8"));
  return resolve(settings.hospitals?.path ?? "data/hospitals.csv");
}

const exists = (p) => access(p).then(() => true, () => false);

function parseRows(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const columns = Object.keys(rows[0] ?? {});
  if (!columns.length || columns.some((c) => !c)) throw new Error("Header must have non-empty column names");
  if (new Set(columns).size !== columns.length) throw new Error("Header has duplicate column names");
  if (rows.length > MAX_ROWS) throw new Error(`Too many rows (max ${MAX_ROWS})`);
  rows.forEach((row, i) => {
    for (const c of columns) {
      if (!row[c]) throw new Error(`Row ${i + 2}: "${c}" is empty`);
    }
  });
  // Sorted left-to-right by column so duplicates are adjacent.
  rows.sort(compareRows(columns));
  return { columns, rows };
}

export const compareRows = (columns) => (a, b) => {
  for (const c of columns) {
    const d = a[c].localeCompare(b[c]);
    if (d) return d;
  }
  return 0;
};

export const sameRow = (columns, a, b) => columns.every((c) => a[c] === b[c]);

// { column: [distinct values] } for the given rows.
export function uniqueValues(rows, columns) {
  return Object.fromEntries(columns.map((c) => [c, [...new Set(rows.map((r) => r[c]))]]));
}

// Copy the sample ./hospitals.csv into data/ only if data/ has no file yet.
export async function seedHospitals() {
  const target = await dataPath();
  if (await exists(target) || !(await exists(samplePath))) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(samplePath, target);
}

// Validate, then atomically replace the whole file. Throws on invalid input.
export async function saveHospitalsCsv(text) {
  let rows;
  try {
    ({ rows } = parseRows(text));
  } catch (error) {
    throw Object.assign(new Error(error.message), { status: 400 });
  }
  if (!rows.length) throw Object.assign(new Error("CSV has no data rows"), { status: 400 });
  const target = await dataPath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, target);
  return rows.length;
}

// { columns, rows } (rows sorted), or null if there is no file.
export async function loadHospitals() {
  const target = await dataPath();
  if (!(await exists(target))) return null;
  const { columns, rows } = parseRows(await readFile(target, "utf8"));
  const settings = JSON.parse(await readFile(resolve("settings.json"), "utf8"));
  const hidden = settings.hospitals?.nonFilterableColumns ?? [];
  return { columns, filterColumns: columns.filter((c) => !hidden.includes(c)), rows };
}
