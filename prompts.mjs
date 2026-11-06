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

// Replace {{key}} placeholders; an unknown placeholder throws so typos fail loudly.
const fill = (name, text, vars) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Prompt "${name}": no value for {{${key}}}`);
    return vars[key];
  });

// Memory first, file as fallback.
export async function getPrompt(name, vars = {}) {
  return fill(name, cache.get(name) ?? (await load(`${name}.txt`)), vars);
}
