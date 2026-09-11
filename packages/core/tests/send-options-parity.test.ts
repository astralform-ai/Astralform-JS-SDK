import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `StreamManager` declares its OWN `SendOptions` and forwards to the session
// with a spread. So a field the session accepts but the manager does not
// declare is unreachable through the manager: the caller cannot type it, even
// though the spread would carry it and the session would honour it.
//
// Typecheck cannot catch that. Both interfaces are internally consistent — the
// bug is the relationship between them — and `tsconfig.json` excludes `tests`,
// so an assertion written in this suite is not type-checked either. A scan of
// the source is the only thing that sees it, the same way
// `public-exports.test.ts` is the only thing that sees an unexported type.
//
// It has now happened twice, in both directions. #55 found `repository` dropped
// by the manager's hand-copied forward and replaced that with the spread; its
// commit message recorded that `enabledClientTools` had already been lost the
// other way, which #73 fixed. This is what stops a third.

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/**
 * The field names one `export interface SendOptions { … }` block declares.
 *
 * Reads a `readonly` prefix and a key quoted but otherwise word-chars, and —
 * more importantly — THROWS when the names it read do not account for every
 * member in the block. Anything else it cannot parse, `"content-type"?:`
 * included, trips that throw rather than being handled: a scan that silently
 * skipped an unfamiliar shape would make the parity assertions below pass while
 * the field was missing from the manager, which is the exact failure this file
 * exists to make loud. The `length` floors would not catch it — they catch a
 * scan that matched nothing, not one that missed one.
 */
const sendOptionFields = (source: string): string[] => {
  const block = /^export interface SendOptions[^{]*\{([\s\S]*?)^\}/m.exec(source);
  if (!block) throw new Error("no `export interface SendOptions` block found");
  const body = block[1]!;

  const names = [...body.matchAll(/^ {2}(?:readonly )?["']?(\w+)["']?\??:/gm)].map(
    (m) => m[1]!,
  );

  // Every MEMBER must have produced a name — members, not lines. Counting lines
  // held only while a line declared at most one field: `a?: string; b?: number;`
  // gives one line and, since the pattern is `^`-anchored, one name, so the
  // counts agreed and `b` went unscanned. That is the silent miss this check
  // exists to prevent, one level up. Comments carry both `:` and `;`, so they
  // come out first.
  //
  // The counter is over `;`-separated members, and that bounds it twice. A `;`
  // inside a member's own type over-counts — `(e: { pct: number; label:
  // string }) => void` reads as two — which throws rather than misses, so it
  // is friction, not a hole. It takes two inline properties to carry a `;` at
  // all; `{ pct: number }` has none and is read correctly.
  //
  // The hole is the reverse: TS also accepts `,` between members, so
  // `goal?: string, other?: string;` is one member and one name, counts agree,
  // and `other` goes unscanned. Splitting on `/[;,]/` is not the fix — commas
  // are everywhere in legitimate types (`Record<string, string>`), so that
  // trades a rare silent miss for constant false throws. Written here because
  // it is a real limit and a reader deserves to know it rather than trust the
  // guard further than it goes.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const members = code.split(";").filter((m) => m.trim() !== "");
  if (members.length !== names.length) {
    throw new Error(
      `read ${names.length} field(s) from ${members.length} member(s) — a field is ` +
        "written in a shape this scan cannot read (two on one line? an unusual " +
        "key? a ';' inside a member's type?); split the line, hoist an inline " +
        "object type to a named alias, or widen the pattern.",
    );
  }

  return names;
};

/**
 * Session fields the manager deliberately does NOT accept, and why. An entry
 * here is a claim that omitting it is correct — not that nobody got round to it.
 */
const DELIBERATELY_OMITTED: Record<string, string> = {
  conversationId:
    "`send` overwrites it on the forward (the manager owns the pointer), so a " +
    "caller's value would be silently discarded rather than honoured.",
};

describe("SendOptions parity between the session and the manager", () => {
  const session = sendOptionFields(read("types.ts"));
  const manager = sendOptionFields(read("stream-manager.ts"));

  it("the manager declares every session field bar the deliberate omissions", () => {
    // A scan that matched nothing would satisfy every assertion below.
    expect(session.length).toBeGreaterThan(5);
    expect(manager.length).toBeGreaterThan(5);

    // `hasOwn`, not `in`: `in` walks the prototype chain, so a field named
    // `constructor` or `toString` would be excused by an entry nobody wrote.
    const unreachable = session.filter(
      (f) => !manager.includes(f) && !Object.hasOwn(DELIBERATELY_OMITTED, f),
    );
    expect(unreachable).toEqual([]);
  });

  it("every deliberate omission is in fact absent", () => {
    // Otherwise an entry outlives its reason and silently excuses a later field
    // that lands on the manager for unrelated reasons.
    const stale = Object.keys(DELIBERATELY_OMITTED).filter((f) =>
      manager.includes(f),
    );
    expect(stale).toEqual([]);
  });

  it("and carries no field the session would drop", () => {
    // The other direction, which `stream-manager.ts` asserts in prose above its
    // forward: "The manager's `SendOptions` carries no key the session does not
    // accept, so the spread is equivalent today and cannot drift tomorrow."
    // Nothing checked that. A manager-only field types fine, spreads into
    // `session.send`, and is dropped on the floor — the same silent loss as
    // `enabledClientTools`, pointing the other way.
    expect(manager.filter((f) => !session.includes(f))).toEqual([]);
  });
});
