// The status-file tools: onboarding questions, card + credit + balance writes, and the atomic save. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CardFile } from "../src/entitlements.ts";
import { creditStatus } from "../src/expiring.ts";
import { optimizePurchase } from "../src/optimize.ts";
import { askUser, loadState, markCredit, saveState, setBalance, setCards } from "../src/state.ts";

const dir = new URL("../data/entitlements/", import.meta.url).pathname;
const cards: CardFile[] = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(dir + f, "utf8")));
const today = "2026-11-10";
const lulu = cards.find((c) => c.slug === "amex-platinum")!.entitlements.find((e) => e.name.toLowerCase().includes("lululemon"))!.id;

// No cards yet: the only question is which cards.
assert.match(askUser({}, cards, today)[0], /Which credit cards/);

// set_my_cards: unknown slugs and bad dates are refused; anniversaries merge.
assert.throws(() => setCards({}, cards, ["not-a-card"]), /Unknown card/);
assert.throws(() => setCards({}, cards, ["amex-platinum"], { "amex-platinum": "13-01" }), /MM-DD/);
let s = setCards({}, cards, ["amex-platinum", "amex-platinum"], { "amex-platinum": "03-15" });
assert.deepEqual(s.held, ["amex-platinum"]);
assert.equal(s.cards?.["amex-platinum"].anniversary, "03-15");

// At purchase time, a credit nobody has confirmed becomes a question with the exact ids to save the answer.
const purchase = { merchant: "lululemon", category: "apparel" as const, amount: 98, date: today };
let asks = askUser(s, cards, today, optimizePurchase(purchase, cards, s.held!, { state: s }));
assert.ok(asks.some((q) => q.includes(`credit "${lulu}"`) && q.includes("enrolled")));

// Confirmed unused: no more asking this quarter, and the credit still counts.
s = markCredit(s, cards, "amex-platinum", lulu, false, "2026-11-01");
let answer = optimizePurchase(purchase, cards, s.held!, { state: s });
assert.ok(answer.best?.credits.some((c) => c.id === lulu && c.note.includes("unused on 2026-11-01")));
assert.ok(!askUser(s, cards, today, answer).some((q) => q.includes(lulu)));

// Used: the credit drops out, and the "unused" note for it is cleared.
s = markCredit(s, cards, "amex-platinum", lulu, true, "2026-11-05");
answer = optimizePurchase(purchase, cards, s.held!, { state: s });
assert.equal(answer.best?.credits.length, 0);
assert.equal(s.cards?.["amex-platinum"].checked?.[lulu], undefined);
assert.throws(() => markCredit(s, cards, "amex-platinum", "nope", true, today), /no credit/);

// Balances: replace by name + program, 0 removes.
s = setBalance(s, { name: "Voucher", program: "Alaska", value: 100, unit: "USD", expires: "2026-11-20" });
s = setBalance(s, { name: "Voucher", program: "Alaska", value: 150, unit: "USD", expires: "2026-11-20" });
assert.equal(s.balances?.length, 1);
assert.equal(s.balances?.[0].value, 150);
assert.equal(setBalance(s, { name: "Voucher", program: "Alaska", value: 0, unit: "USD" }).balances?.length, 0);
assert.throws(() => setBalance(s, { name: "x", program: "y", value: 1, unit: "USD", expires: "2026-02-30" }), /YYYY-MM-DD/);

// Save + load round-trips, through a temp file (never a half-written one).
const path = mkdtempSync(`${tmpdir()}/tap-`) + "/sub/state.json";
saveState(path, s);
assert.deepEqual(loadState(path), s);
assert.deepEqual(readdirSync(path.replace("/state.json", "")), ["state.json"]);

// No renewal date saved: a "used" from over a year ago doesn't hide the credit (it would never come back otherwise).
const travel = cards.find((c) => c.slug === "chase-sapphire-reserve")!.entitlements.find((e) => e.cadence === "card_anniversary" && e.kind === "credit")!;
assert.equal(creditStatus(travel, { used: { [travel.id]: "2025-10-01" } }, today).status, "unknown");
assert.equal(creditStatus(travel, { used: { [travel.id]: "2026-06-01" } }, today).status, "used");

console.log("state: all scenarios pass");
