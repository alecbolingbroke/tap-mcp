// Scenario tests for optimize_purchase against the real pilot data. Run: npm run test:optimize
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { CardFile } from "../src/entitlements.ts";
import { parseEarn } from "../src/cardsavvy.ts";
import { optimizePurchase } from "../src/optimize.ts";

const dir = new URL("../data/entitlements/", import.meta.url).pathname;
const cards: CardFile[] = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(dir + f, "utf8")));
const HELD = ["discover-it-cash-back", "delta-skymiles-gold-amex", "atmos-rewards-ascent-visa-signature"];

// Dinner in Q4 2026: Discover's 5% restaurants quarter beats 2x, and says to activate.
let a = optimizePurchase({ merchant: "Local Bistro", category: "dining", amount: 80, date: "2026-11-01" }, cards, HELD);
assert.equal(a.best?.slug, "discover-it-cash-back");
assert.equal(a.best?.earn_usd, 4);
assert.ok(a.best?.warnings.some((w) => w.includes("activated")));

// The first day of a quarter belongs to that quarter in any timezone (a UTC parse made 10-01 read as Q3 in Denver).
a = optimizePurchase({ merchant: "Local Bistro", category: "dining", amount: 80, date: "2026-10-01" }, cards, HELD);
assert.equal(a.best?.slug, "discover-it-cash-back");

// Same dinner in Q1 2027 (categories unknown): falls back to Delta's 2x dining.
a = optimizePurchase({ merchant: "Local Bistro", category: "dining", amount: 80, date: "2027-02-01" }, cards, HELD);
assert.equal(a.best?.slug, "delta-skymiles-gold-amex");

// Prepaid Delta Stays booking: the $100 credit applies (audit #1's missed credit).
a = optimizePurchase({ merchant: "Delta Stays", category: "hotel", amount: 240 }, cards, HELD);
assert.equal(a.best?.slug, "delta-skymiles-gold-amex");
assert.ok(a.best?.credits.some((c) => c.name.includes("Stays") && c.up_to_usd === 100));

// Marriott booked direct with Amex Platinum: no hotel credit, but a tip about the portal.
a = optimizePurchase({ merchant: "Marriott", category: "hotel", amount: 300 }, cards, ["amex-platinum"]);
assert.equal(a.best?.credits.length, 0);
assert.ok(a.tips.some((t) => t.includes("Amex Travel")));

// lululemon via a wallet's one-time card: credit shows, with the staged-card warning.
a = optimizePurchase({ merchant: "lululemon", category: "apparel", amount: 98, rail: "staged_virtual_card" }, cards, ["amex-platinum"]);
assert.ok(a.best?.credits.some((c) => c.name.toLowerCase().includes("lululemon")));
assert.ok(a.best?.warnings.some((w) => w.includes("one-time card")));
assert.ok(a.tips[0].startsWith("Pay with the card itself"));

// Uber ride: Sapphire's Lyft-only 5x and Amex's Uber One membership credit must NOT apply; Uber Cash does.
a = optimizePurchase({ merchant: "Uber", category: "rideshare", amount: 25 }, cards, ["chase-sapphire-reserve", "amex-platinum"]);
const csr = a.options.find((o) => o.slug === "chase-sapphire-reserve")!;
const plat = a.options.find((o) => o.slug === "amex-platinum")!;
assert.ok(!csr.earn_note.includes("Lyft"));
assert.ok(plat.credits.some((c) => c.name === "Uber Cash"));
assert.ok(!plat.credits.some((c) => c.name.includes("Uber One")));

// No cards held: no answer, no crash.
assert.equal(optimizePurchase({ merchant: "X", category: "gas", amount: 10 }, cards, []).best, null);

// CardSavvy's earn replaces Tap's rate; Tap's credit still counts on top (CardSavvy's per-purchase tool ignores credits).
const lulu = { merchant: "lululemon", category: "apparel" as const, amount: 98, date: "2026-11-10" };
a = optimizePurchase(lulu, cards, ["amex-platinum"], { earn: { "amex-platinum": { usd: 1.47, note: "1x base", warnings: [] } } });
assert.equal(a.best?.earn_usd, 1.47);
assert.equal(a.best?.total_usd, 76.47);
assert.ok(a.assumptions[0].includes("CardSavvy"));

// A credit used this quarter drops out with a warning, and comes back next quarter.
const state = { cards: { "amex-platinum": { used: { [cards.find((c) => c.slug === "amex-platinum")!.entitlements.find((e) => e.name.toLowerCase().includes("lululemon"))!.id]: "2026-10-15" } } } };
a = optimizePurchase(lulu, cards, ["amex-platinum"], { state });
assert.equal(a.best?.credits.length, 0);
assert.ok(a.best?.warnings.some((w) => w.includes("already used")));
a = optimizePurchase({ ...lulu, date: "2027-01-05" }, cards, ["amex-platinum"], { state });
assert.ok(a.best?.credits.some((c) => c.name.toLowerCase().includes("lululemon") && c.note.includes("not confirmed unused")));

// CardSavvy's reply (shape captured 2026-11-10): maps names to slugs, keeps its miscoding note, drops cards nobody asked about and bad rows.
const reply = { result: { ranked: [
  { card_name: "Atmos Rewards Ascent Visa Signature", value: 10.44, formula: "3x Flights", confidence: "high", warnings: [], assumptions: ["Scored as Flights because of how Airline (booked direct) codes, not as Hotels.", "Points valued at 1.45¢ each."] },
  { card_name: "Delta SkyMiles Gold", value: "5.76" },
  { card_name: "Chase Sapphire Reserve", value: 3 },
] } };
const earn = parseEarn(reply, HELD);
assert.deepEqual(Object.keys(earn), ["atmos-rewards-ascent-visa-signature"]);
assert.ok(earn["atmos-rewards-ascent-visa-signature"].warnings[0].startsWith("Scored as Flights"));
assert.deepEqual(parseEarn({ error: "x" }, HELD), {});

// Household items on Amazon ("general"): base rates only, the best card wins even by cents, and a warning every card shares is said once.
const amazonNote = "Amazon codes as online retail, not grocery, even for grocery items in your cart.";
const flat = (usd: number) => ({ usd, note: "base", warnings: [amazonNote] });
a = optimizePurchase({ merchant: "Amazon", category: "general", amount: 32.71 }, cards, HELD, { earn: { "discover-it-cash-back": flat(0.41), "delta-skymiles-gold-amex": flat(0.39), "atmos-rewards-ascent-visa-signature": flat(0.47) } });
assert.equal(a.best?.slug, "atmos-rewards-ascent-visa-signature");
assert.ok(a.options.every((o) => !o.warnings.includes(amazonNote)) && a.tips.filter((t) => t === amazonNote).length === 1);
assert.equal(optimizePurchase({ merchant: "Amazon", category: "general", amount: 30 }, cards, HELD).benefits.length, 0);
// CardSavvy's "not as General" note is dropped; a real miscoding note is kept.
assert.deepEqual(parseEarn({ result: { ranked: [{ card_name: "Delta SkyMiles Gold", value: 0.39, assumptions: ["Scored as Amazon because of how Amazon codes, not as General."] }] } }, HELD)["delta-skymiles-gold-amex"].warnings, []);

console.log("optimize_purchase: 14 scenarios pass");
