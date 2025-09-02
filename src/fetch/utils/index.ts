import * as fs from "fs";

/**
 * Reads a JSON file from a given path and parses it into a typed object.
 *
 * @param path - The file path to the JSON file
 * @returns The parsed object of type T
 */
export function readJsonFile(path: string) {
  try {
    const data = fs.readFileSync(path, { encoding: "utf-8" });
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`Failed to read or parse JSON file at ${path}: ${error}`);
  }
}
