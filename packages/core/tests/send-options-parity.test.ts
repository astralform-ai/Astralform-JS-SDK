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
 * Tolerates a `readonly` prefix and a quoted key, and — more importantly —
 * THROWS on a declaration line it cannot read. A regex that silently skipped an
 * unfamiliar shape would make the parity assertions below pass while the field
 * was missing from the manager, which is the exact failure this file exists to
 * make loud. The `length` floors would not catch it: they catch a scan that
 * matched nothing, not one that missed one.
 */
const sendOptionFields = (source: string): string[] => {
  const block = /^export interface SendOptions[^{]*\{([\s\S]*?)^\}/m.exec(source);
  if (!block) throw new Error("no `export interface SendOptions` block found");
  const body = block[1]!;

  const names = [...body.matchAll(/^ {2}(?:readonly )?["']?(\w+)["']?\??:/gm)].map(
    (m) => m[1]!,
  );

  // Every line that declares something must have produced a name.
  const declarations = body
    .split("\n")
    .filter((l) => /^ {2}\S/.test(l) && !/^\s*(\/[/*]|\*)/.test(l) && l.includes(":"));
  if (declarations.length !== names.length) {
    throw new Error(
      `read ${names.length} field(s) from ${declarations.length} declaration line(s) — ` +
        "a field is written in a shape this scan cannot read; widen the pattern.",
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
