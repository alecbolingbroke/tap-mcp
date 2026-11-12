// Scenario tests for whats_expiring against the real pilot data. Run: npm run test:expiring
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { CardFile } from "../src/entitlements.ts";
import { checkState, expiring } from "../src/expiring.ts";

const dir = new URL("../data/entitlements/", import.meta.url).pathname;
const cards: CardFile[] = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(dir + f, "utf8")));
const HELD = ["discover-it-cash-back", "delta-skymiles-gold-amex", "atmos-rewards-ascent-visa-signature"];
const find = (r: ReturnType<typeof expiring>, what: string) => r.due.find((d) => d.what.includes(what));

// Audit #1's miss: in November, an unused Delta Stays credit lapses Dec 31 and says how to book it.
let r = expiring({}, cards, HELD, "2026-11-02");
const stays = find(r, "Delta Stays");
assert.equal(stays?.expires, "2026-12-31");
assert.equal(stays?.days_left, 59);
assert.ok(stays?.notes.some((n) => n.startsWith("Book through")));
// A monthly credit loses this month's slice, not the yearly total ($120/yr rideshare → $10 in November).
assert.equal(find(r, "Rideshare")?.value, "$10");
assert.equal(find(r, "Rideshare")?.expires, "2026-11-30");
// Without an anniversary the companion fare can't be placed, and the answer says so instead of dropping it silently.
assert.ok(r.gaps.some((g) => g.includes("Companion")));

// Marking it used this year removes it; a use from last year doesn't.
assert.equal(find(expiring({ cards: { "delta-skymiles-gold-amex": { used: { "delta-stays-credit": "2026-03-10" } } } }, cards, HELD, "2026-11-02"), "Delta Stays"), undefined);
assert.ok(find(expiring({ cards: { "delta-skymiles-gold-amex": { used: { "delta-stays-credit": "2025-12-30" } } } }, cards, HELD, "2026-11-02"), "Delta Stays"));

// Card anniversary: the year ends the day before the next anniversary, across a year boundary.
r = expiring({ cards: { "atmos-rewards-ascent-visa-signature": { anniversary: "01-15" } } }, cards, HELD, "2026-11-02");
assert.equal(find(r, "ompanion")?.expires, "2027-01-14");
assert.equal(find(r, "ompanion")?.value, "1 companion fare");
assert.ok(find(r, "ompanion")?.notes.some((n) => n.includes("spend")));

// Balances: inside the window, soonest first; outside the window or without an expiry, left out.
r = expiring(
  {
    balances: [
      { name: "Wallet code", program: "Alaska", value: 500, unit: "USD", expires: "2027-09-08" },
      { name: "Flight credit", program: "Delta", value: 200, unit: "USD", expires: "2027-07-01" },
      { name: "Points", program: "Atmos", value: 120000, unit: "points" },
    ],
  },
  cards,
  [],
  "2026-11-02",
  365,
);
assert.deepEqual(r.due.map((d) => d.what), ["Flight credit (Delta)", "Wallet code (Alaska)"]);
assert.equal(expiring({ balances: [{ name: "Wallet code", program: "Alaska", value: 500, unit: "USD", expires: "2027-09-08" }] }, cards, [], "2026-11-02").due.length, 0);

// The status file is the trust boundary: bad dates are refused, not misread.
assert.throws(() => checkState({ cards: { x: { anniversary: "1/15" } } }));
assert.throws(() => checkState({ balances: [{ name: "a", program: "b", value: 1, unit: "USD", expires: "09/08/27" }] }));

// Impossible dates are refused too, not rolled into the next day or year.
assert.throws(() => checkState({ balances: [{ name: "a", program: "b", value: 1, unit: "USD", expires: "2027-09-31" }] }));
assert.throws(() => checkState({ cards: { x: { anniversary: "13-01" } } }));
assert.doesNotThrow(() => checkState({ cards: { x: { anniversary: "02-29" } } }));

console.log("expiring: all scenarios pass");
