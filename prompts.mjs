import { readdir, readFile } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";

const dir = resolve("prompts");
const cache = new Map();

const load = async (file) => {
  const text = (await readFile(resolve(dir, file), "utf8")).trim();
  cache.set(basename(file, extname(file)), text);
  return text;
};

// Load every prompt file at startup; the prompt name is the file name without extension.
await Promise.all((await readdir(dir)).map(load));

// Memory first, file as fallback.
export async function getPrompt(name) {
  return cache.get(name) ?? (await load(`${name}.txt`));
}
