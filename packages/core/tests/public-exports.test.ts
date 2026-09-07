import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `index.ts` re-exports through an EXPLICIT named list — there is no `export *`
// — and `package.json` declares one entry point. So a type declared in a source
// file and left off that list compiles, ships, and is unnameable by a consumer:
//
//   import type { ToolSource } from "@astralform/js";
//   // TS2724: has no exported member named 'ToolSource'
//
// Typecheck cannot catch it because nothing in-repo imports these types. This
// test is the thing that does.
//
// THE CONTRACT: every type exported from a scanned file is public surface and
// must be on the list. The opt-out is not a marker — it is not exporting the
// type. `types.ts` already relies on this: `AstralformBaseConfig` is declared
// without `export`, so it is invisible to this guard and to consumers alike.
//
// The one case that opting out cannot serve is a type that must cross module
// boundaries in-repo without being public. Mark that one `@internal` in the
// doc comment above it and this guard skips it. Nothing needs it today; the
// fixture below is what keeps the escape hatch honest.

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/** Is `line` inside the doc comment attached to the declaration below it? */
const isCommentLine = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

/**
 * Every type name a source file exports — `export interface` AND `export type`
 * aliases, since a consumer cannot name either one without it being re-exported.
 * Declarations whose attached comment says `@internal` are skipped.
 */
const declaredPublicTypes = (source: string): string[] => {
  const lines = source.split("\n");
  const names: string[] = [];

  lines.forEach((line, i) => {
    // `export type { A, B };` is a re-export, not a declaration — `\w` after the
    // keyword is what excludes it.
    const declared = /^export (?:interface|type) (\w+)/.exec(line);
    if (!declared) return;

    for (let j = i - 1; j >= 0 && isCommentLine(lines[j]!); j--) {
      if (lines[j]!.includes("@internal")) return;
    }
    names.push(declared[1]!);
  });

  return names;
};

/**
 * Every name `index.ts` actually re-exports. Parsing the blocks beats a
 * per-name regex: the list mixes multi-line blocks with single-line ones like
 * `export type { ChatEvent, BlockDeltaPayload, TurnUsage } from "./types.js";`,
 * and an `^\s*Name,\s*$` matcher reports those five as missing.
 */
const namesExportedBy = (index: string): Set<string> => {
  const names = new Set<string>();

  // `[^}]` spans newlines, so one pattern covers both block shapes.
  for (const [, body] of index.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const raw of body.split(",")) {
      // `export { A, type B }` — the inline `type` prefix is not part of the name.
      const spec = raw.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      // `X as Y` publishes Y, not X.
      const name = spec.split(/\s+as\s+/).pop()!.trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }

  return names;
};

describe("public export surface", () => {
  const exported = namesExportedBy(read("index.ts"));

  it.each([
    // #61 added this file's guard; #63 shipped `ToolSource` in `types.ts` and
    // nearly shipped it unnameable, which is why `types.ts` is here too.
    ["custom-events.ts", 20],
    ["types.ts", 60],
  ])("re-exports every public type declared in %s", (file, floor) => {
    const declared = declaredPublicTypes(read(file));
    // A scan that silently matched nothing would pass every assertion below.
    expect(declared.length).toBeGreaterThan(floor);

    expect(declared.filter((name) => !exported.has(name))).toEqual([]);
  });

  it("reads the export list without over-collecting", () => {
    // The inverse failure to the one above: a parser that swept up every
    // identifier in `index.ts` would make the guard vacuous. `types.ts`
    // declares this one without `export`, so it must not appear.
    expect(exported.has("AstralformBaseConfig")).toBe(false);
    // And the positive control for the shape the old `^\s*Name,\s*$` matcher
    // got wrong: a name sharing a single-line block with its neighbours.
    expect(exported.has("BlockDeltaPayload")).toBe(true);
  });

  it("collects type aliases and honours the @internal opt-out", () => {
    const fixture = [
      "export interface Plain {}",
      'export type Alias = "a" | "b";',
      "/** @internal Shared across modules, not public surface. */",
      "export interface Hidden {}",
      "/**",
      " * @internal",
      " */",
      "export type HiddenAlias = string;",
      "interface NotExported {}",
      "export type { Plain };",
    ].join("\n");

    expect(declaredPublicTypes(fixture)).toEqual(["Plain", "Alias"]);
  });

  it("resolves the shapes the export list actually uses", () => {
    const fixture = [
      'export { Value, type Inline } from "./a.js";',
      "export type {",
      "  Multi,",
      "  Line,",
      '} from "./b.js";',
      'export { Origin as Public } from "./c.js";',
    ].join("\n");

    expect([...namesExportedBy(fixture)].sort()).toEqual([
      "Inline",
      "Line",
      "Multi",
      "Public",
      "Value",
    ]);
  });
});
