import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOTS = ["app", "lib"];
const ALLOWED_CONSOLE_FILE = path.normalize("lib/logger.ts");
const CONSOLE_CALL = /\bconsole\.(?:debug|info|log|warn|error)\s*\(/g;

function sourceFiles(root: string): string[] {
  const absolute = path.resolve(process.cwd(), root);
  const files: string[] = [];

  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(relative));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(path.normalize(relative));
  }

  return files;
}

describe("application logging safety", () => {
  it("routes runtime console output through the structured logger", () => {
    const bypasses: string[] = [];

    for (const file of ROOTS.flatMap(sourceFiles)) {
      if (file === ALLOWED_CONSOLE_FILE) continue;
      const content = readFileSync(path.resolve(process.cwd(), file), "utf8");
      if (CONSOLE_CALL.test(content)) bypasses.push(file);
      CONSOLE_CALL.lastIndex = 0;
    }

    expect(bypasses).toEqual([]);
  });
});
