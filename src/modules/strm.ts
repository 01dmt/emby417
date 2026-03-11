import { promises as fs } from "node:fs";

export async function readStrmContent(strmPath: string): Promise<string> {
  const raw = await fs.readFile(strmPath, "utf-8");
  const firstLine = raw.split(/\r?\n/)[0];
  return firstLine.trim();
}

export function normalizeStrmContent(content: string): string {
  return content.trim();
}
