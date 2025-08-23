import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
export async function readTextIfExists(path) {
    try {
        await stat(path);
        return await readFile(path, "utf8");
    }
    catch {
        return undefined;
    }
}
export async function ensureDirFor(filePath) {
    await mkdir(dirname(filePath), { recursive: true });
}
export async function writeTextIfChanged(path, content) {
    const prev = await readTextIfExists(path);
    if (prev === content)
        return "skipped";
    await ensureDirFor(path);
    return await write(path, content);
}
export async function write(path, content) {
    await writeFile(path, content, "utf8");
    return "written";
}
