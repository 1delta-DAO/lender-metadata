import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function readTextIfExists(
  path: string
): Promise<string | undefined> {
  try {
    await stat(path);
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function ensureDirFor(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function writeTextIfChanged(
  path: string,
  content: string
): Promise<"written" | "skipped"> {
  const prev = await readTextIfExists(path);
  if (prev === content) return "skipped";
  await ensureDirFor(path);
  return await write(path, content);
}

export async function write(
  path: string,
  content: string
): Promise<"written" | "skipped"> {
  await writeFile(path, content, "utf8");
  return "written";
}
