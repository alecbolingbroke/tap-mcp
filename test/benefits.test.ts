// Benefits beyond cards (health plan, employer, memberships): onboarding, checkout matching, IRS checks for pre-tax accounts,
// membership data, document evidence, use tracking and expiry. Run: npm test
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { CardFile, MembershipFile, TaxRules } from "../src/entitlements.ts";
import { expiring, withMemberships, type State } from "../src/expiring.ts";
import { optimizePurchase, type Purchase } from "../src/optimize.ts";
import { askUser, markBenefit, setBenefits, setCards, setMemberships } from "../src/state.ts";

const data = new URL("../data/", import.meta.url).pathname;
const readDir = <T>(sub: string): T[] => readdirSync(data + sub).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(data + sub + f, "utf8")));
const cards = readDir<CardFile>("entitlements/");
const memberships = readDir<MembershipFile>("memberships/");
const taxRules: TaxRules = JSON.parse(readFileSync(data + "tax-accounts.json", "utf8"));
const today = "2026-11-10";
const HELD = ["delta-skymiles-gold-amex"];
// What the server does on every read: the user's benefits plus their memberships', checked against the IRS rules.
const opt = (s: State, p: Omit<Purchase, "date"> & { date?: string }) =>
  optimizePurchase({ date: today, ...p }, cards, HELD, { state: withMemberships(s, memberships), taxRules });

// Onboarding: once cards are saved, Tap asks about other benefits once; an empty answer means "none" and stops the question.
let s = setCards({}, cards, HELD, { "delta-skymiles-gold-amex": "03-15" });
assert.ok(askUser(s, cards, today).some((q) => q.includes("set_benefits") && q.includes("evidence")));
assert.ok(!askUser(setBenefits(s, []), cards, today).some((q) => q.includes("set_benefits")));
assert.ok(!askUser(setMemberships(s, ["costco-executive"], ["costco-executive"]), cards, today).some((q) => q.includes("set_benefits")));

s = setBenefits(s, [
  { source: "Health plan", name: "HSA", how: "pay_with", account: "hsa", instructions: "Pay with the HSA debit card." },
  { source: "Employer", name: "Gym reimbursement", how: "reimburse", categories: ["fitness"], value: 50, unit: "USD", cadence: "monthly",
    evidence: { source: "2026 Benefits Guide", quote: "Employees are reimbursed up to $50 per month for gym memberships." } },
  { source: "Employer", name: "Dependent care FSA", how: "pay_with", account: "dependent_care_fsa", value: 400, unit: "USD", expires: "2026-12-31" },
  { source: "Employer", name: "Phone stipend", how: "allowance", categories: ["phone"], value: 40, unit: "USD", cadence: "monthly" },
]);
s = setMemberships(s, memberships.map((m) => m.slug), ["costco-executive", "walmart-plus"]);
assert.deepEqual(s.benefits?.map((b) => b.id), ["health-plan-hsa", "employer-gym-reimbursement", "employer-dependent-care-fsa", "employer-phone-stipend"]);

// HSA at a pharmacy: the IRS rules say it depends on the item, with the source; the tip says pre-tax beats card rewards.
let a = opt(s, { merchant: "CVS", category: "pharmacy", amount: 40 });
const hsa = a.benefits.find((b) => b.id === "health-plan-hsa")!;
assert.equal(hsa.eligibility?.status, "depends");
assert.ok(hsa.eligibility?.source_url.startsWith("https://www.irs.gov/"));
assert.ok(a.tips[0].includes("pre-tax"));
assert.ok(a.assumptions.some((x) => x.includes("depends on the item")));

// HSA at the gym: IRS Pub 502 says no, so it's left out with the reason. The documented reimbursement shows, quoting the guide.
a = opt(s, { merchant: "Orangetheory", category: "fitness", amount: 80 });
assert.deepEqual(a.benefits.map((b) => b.id), ["employer-gym-reimbursement"]);
assert.ok(a.tips.some((t) => t.startsWith("HSA (Health plan) can't pay for this") && t.includes("Gym and health club dues")));
assert.equal(a.benefits[0].up_to_usd, 50);
assert.ok(a.benefits[0].checked.startsWith('from 2026 Benefits Guide: "'));
assert.ok(askUser(s, cards, today, a).some((q) => q.includes(`benefit "employer-gym-reimbursement"`)));

// Childcare: the dependent care FSA is eligible, the HSA isn't.
a = opt(s, { merchant: "Bright Horizons", category: "childcare", amount: 300 });
assert.deepEqual(a.benefits.map((b) => [b.id, b.eligibility?.status]), [["employer-dependent-care-fsa", "eligible"]]);
assert.ok(a.tips.some((t) => t.startsWith("HSA")));

// No document: the answer says so, and asks for the guide.
a = opt(s, { merchant: "Verizon", category: "phone", amount: 70 });
assert.ok(a.benefits[0].checked.startsWith("as the user described it"));
assert.ok(a.assumptions.some((x) => x.includes("benefits guide")));

// A quote that doesn't show the saved amount gets flagged; an agent can't label its own evidence as checked by Tap.
let t = setBenefits(s, [{ source: "Employer", name: "Phone stipend", how: "allowance", categories: ["phone"], value: 40, unit: "USD", cadence: "monthly",
  evidence: { source: "Offer letter", quote: "A monthly phone stipend is provided.", by: "tap" } as never }]);
a = opt(t, { merchant: "Verizon", category: "phone", amount: 70 });
assert.ok(a.benefits[0].checked.includes("doesn't show the 40 amount"));
assert.equal(t.benefits?.find((b) => b.id === "employer-phone-stipend")?.evidence?.by, undefined);

// Memberships come from Tap's checked data: Costco's 2% at Costco (not on Costco gas), Walmart+ fuel at Exxon, nothing at a bistro.
a = opt(s, { merchant: "Costco Wholesale", category: "grocery", amount: 200 });
const costco = a.benefits.find((b) => b.id === "costco-executive/2pct-reward")!;
assert.equal(costco.up_to_usd, 4);
assert.ok(costco.checked.startsWith("Tap checked https://www.costco.com/"));
assert.equal(opt(s, { merchant: "Costco Gas", category: "gas", amount: 60 }).benefits.length, 0);
assert.deepEqual(opt(s, { merchant: "Exxon", category: "gas", amount: 50 }).benefits.map((b) => b.id), ["walmart-plus/fuel"]);
assert.equal(opt(s, { merchant: "Local Bistro", category: "dining", amount: 80 }).benefits.length, 0);
assert.throws(() => setMemberships(s, memberships.map((m) => m.slug), ["aaa"]), /Unknown memberships/);

// Used this month: the reimbursement drops out with a tip; next month it's back; re-describing keeps the used date.
s = markBenefit(s, "employer-gym-reimbursement", true, "2026-11-03");
a = opt(s, { merchant: "Orangetheory", category: "fitness", amount: 80 });
assert.ok(!a.benefits.some((b) => b.id === "employer-gym-reimbursement"));
assert.ok(a.tips.some((x) => x.includes("already used")));
assert.equal(opt(s, { merchant: "Orangetheory", category: "fitness", amount: 80, date: "2026-12-02" }).benefits.length, 1);
t = setBenefits(s, [{ source: "Employer", name: "Gym reimbursement", how: "reimburse", categories: ["fitness"], value: 60, unit: "USD", cadence: "monthly" }]);
assert.equal(t.benefits?.find((b) => b.id === "employer-gym-reimbursement")?.used, "2026-11-03");

// Expiring: the FSA deadline and next month's unused allowances show (with ids for mark_benefit); membership rewards never do.
const view = withMemberships(s, memberships);
const r = expiring(view, cards, HELD, "2026-12-20", 30);
assert.ok(r.due.some((d) => d.benefit === "employer-dependent-care-fsa" && d.expires === "2026-12-31" && d.value === "$400"));
assert.ok(r.due.some((d) => d.benefit === "employer-gym-reimbursement" && d.expires === "2026-12-31"));
assert.ok(!expiring(view, cards, HELD, today, 30).due.some((d) => d.benefit === "employer-gym-reimbursement"));
assert.ok(!r.due.some((d) => d.benefit?.includes("/")));

// Trust boundary: a benefit has to say what it covers, use known values and real dates; removals must exist.
assert.throws(() => setBenefits(s, [{ source: "Employer", name: "Perk", how: "allowance" }]), /categories, merchants or an account/);
assert.throws(() => setBenefits(s, [{ source: "Employer", name: "Perk", how: "allowance", categories: ["yachts" as "fitness"] }]), /unknown category/);
assert.throws(() => setBenefits(s, [{ source: "Employer", name: "Perk", how: "gift" as "allowance", categories: ["fitness"] }]), /how must be/);
assert.throws(() => setBenefits(s, [{ source: "Employer", name: "Perk", how: "pay_with", account: "ira" as "hsa" }]), /account must be/);
assert.throws(() => setBenefits(s, [{ source: "x", name: "y", how: "allowance", categories: ["fitness"], expires: "2026-02-30" }]), /YYYY-MM-DD/);
assert.throws(() => setBenefits(s, [{ source: "x", name: "y", how: "allowance", categories: ["fitness"], evidence: { source: "Guide", quote: " " } }]), /evidence/);
assert.throws(() => setBenefits(s, [], ["nope"]), /No saved benefit/);
assert.equal(setBenefits(s, [], ["employer-phone-stipend"]).benefits?.length, 3);
assert.throws(() => markBenefit(s, "nope", true, today), /No saved benefit/);

console.log("benefits: all scenarios pass");
