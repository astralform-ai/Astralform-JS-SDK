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

/** The field names one `export interface SendOptions { … }` block declares. */
const sendOptionFields = (source: string): string[] => {
  const block = /^export interface SendOptions[^{]*\{([\s\S]*?)^\}/m.exec(source);
  if (!block) throw new Error("no `export interface SendOptions` block found");
  // Two-space indent then a name: a JSDoc line is `   *`, so it cannot match.
  return [...block[1]!.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
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

    const unreachable = session.filter(
      (f) => !manager.includes(f) && !(f in DELIBERATELY_OMITTED),
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
});
