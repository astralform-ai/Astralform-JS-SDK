import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `index.ts` re-exports the payload catalog through an EXPLICIT named list — there
// is no `export *` — and `package.json` declares one entry point. So an interface
// added to `custom-events.ts` and not to that list compiles, ships, and is
// unnameable by a consumer:
//
//   import type { ToolProgressPayload } from "@astralform/js";
//   // TS2724: has no exported member named 'ToolProgressPayload'
//
// Typecheck cannot catch it because nothing in-repo imports these types. This
// test is the thing that does.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("public export surface", () => {
  it("re-exports every payload interface from the package entry point", () => {
    const declared = [...read("custom-events.ts").matchAll(/^export interface (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(20);

    const index = read("index.ts");
    const missing = declared.filter(
      (name) => !new RegExp(`^\\s*${name},\\s*$`, "m").test(index),
    );
    expect(missing).toEqual([]);
  });
});
