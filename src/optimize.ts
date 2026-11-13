// optimize_purchase v0: for one purchase, rank the cards someone holds by what they earn plus any credit that applies,
// with the conditions an agent must know before paying. Pure: data in, answer out.
import { PERIODS, type CardFile, type Category, type Entitlement, type TaxRule, type TaxRules } from "./entitlements.ts";
import { asEntitlement, benefitStatus, creditStatus, tracksUse, type Benefit, type State } from "./expiring.ts";

/** An earn figure from outside Tap (CardSavvy), used in place of Tap's own rate for that card. */
export type Earn = { usd: number; note: string; warnings: string[] };

export type Purchase = {
  merchant: string;
  category: Category;
  amount: number;
  /** ISO date; picks the rotating-category quarter. Defaults to today. */
  date?: string;
  /** "issuer_portal" = booked through the card issuer's travel site (Amex Travel, Chase Travel, Delta Stays…). */
  booked_via?: "direct" | "issuer_portal";
  /** How the agent pays. "staged_virtual_card" = a wallet-issued one-time card (e.g. Link for Muse at non-Link stores). */
  rail?: "card" | "staged_virtual_card";
};

export type CreditHit = { id: string; name: string; up_to_usd: number; note: string };
export type Option = {
  card: string;
  slug: string;
  earn_usd: number;
  earn_note: string;
  credits: CreditHit[];
  total_usd: number;
  warnings: string[];
};
/** A non-card benefit that covers this purchase. It sits beside the card pick: most stack with it, pay_with replaces it. */
export type BenefitHit = {
  id: string;
  source: string;
  name: string;
  how: Benefit["how"];
  up_to_usd: number | null;
  note: string;
  /** Where the terms come from, and how far to trust them. */ checked: string;
  /** For a pre-tax account: what the IRS rules say about this kind of purchase. */
  eligibility?: { status: TaxRule["status"]; note: string; source_url: string };
};
export type Answer = { best: Option | null; options: Option[]; benefits: BenefitHit[]; tips: string[]; assumptions: string[] };

const HOW: Record<Benefit["how"], string> = {
  pay_with: "pay from this account instead of a card",
  reimburse: "pay with the best card, then claim it back",
  discount: "apply it at checkout; it stacks with the card",
  allowance: "counts against this allowance",
  reward: "earned automatically; it stacks with the card",
};

function checkedBy(b: Benefit): string {
  const e = b.evidence;
  if (!e && b.account) return "what it can pay for is checked against the IRS rules (see eligibility); that the user has the account is as they said";
  if (!e) return "as the user described it; not checked against a document";
  if (e.by === "tap") return `Tap checked ${e.source} on ${e.checked_at}${e.needs_verify ? "; some terms aren't confirmed yet" : ""}`;
  // A quote that doesn't contain the saved amount is the cheapest sign the agent misread the document.
  const shows = b.value === undefined || e.quote.includes(String(b.value));
  return `from ${e.source}: "${e.quote}"${shows ? "" : ` (the quote doesn't show the ${b.value} amount: confirm it with the user)`}`;
}

// shortcut: categories a general "travel" credit covers, approximated; upgrade when a card's travel definition is stored as data.
const TRAVEL: Category[] = ["airfare", "airline_fees", "hotel", "vacation_rental", "vacation_packages", "travel", "rideshare", "local_transit", "tolls"];
const NEEDS_SETUP: Record<string, string> = { enrollment: "enrolled", activation: "activated it", registration: "registered", selection: "selected it" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function merchantHit(e: Entitlement, merchant: string) {
  const m = norm(merchant);
  return (e.trigger.merchants ?? []).some((x) => {
    const n = norm(x);
    return Math.min(n.length, m.length) >= 3 && (n.includes(m) || m.includes(n));
  });
}
function categoryHit(e: Entitlement, c: Category) {
  const cats = e.trigger.categories ?? [];
  return cats.includes(c) || (cats.includes("travel") && TRAVEL.includes(c));
}
// Named merchants must match (and the category too, if listed: an Uber ride isn't an Uber One membership); otherwise the category decides.
function applies(e: Entitlement, p: Purchase) {
  if ((e.trigger.merchants ?? []).length) return merchantHit(e, p.merchant) && (!(e.trigger.categories ?? []).length || categoryHit(e, p.category));
  return categoryHit(e, p.category) || !!e.trigger.categories?.includes("everything");
}

export function optimizePurchase(
  p: Purchase,
  cards: CardFile[],
  held: string[],
  extra: { centsPerPoint?: number; state?: State; earn?: Record<string, Earn>; taxRules?: TaxRules } = {},
): Answer {
  const centsPerPoint = extra.centsPerPoint ?? 1;
  // A given ISO date is read as written (new Date("2026-10-01") is UTC midnight, which is still September in Denver).
  const now = new Date();
  const today = p.date?.slice(0, 10) ?? now.toLocaleDateString("en-CA"); // en-CA = YYYY-MM-DD, local day
  const [year, month] = p.date ? [Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1] : [now.getFullYear(), now.getMonth()];
  const quarter = `${year}-Q${Math.floor(month / 3) + 1}`;
  const portal = p.booked_via === "issuer_portal";
  const staged = p.rail === "staged_virtual_card";
  const tips: string[] = [];

  const options = cards.filter((c) => held.includes(c.slug)).map((c): Option => {
    const warnings: string[] = [];
    // A portal-only entitlement applies when booked through that portal, or when the merchant itself is the channel (e.g. Delta Stays).
    const channelOk = (e: Entitlement) => !e.requires.includes("book_via_channel") || portal || merchantHit(e, p.merchant);
    const flag = (e: Entitlement) => e.confidence === "needs_verify" && warnings.push(`"${e.name}" isn't confirmed on the issuer's page yet.`);

    // Earn: the best matching rate.
    let earn = { usd: 0, note: "no earn rate on file", e: null as Entitlement | null };
    for (const e of c.entitlements) {
      if (e.kind !== "multiplier" || e.value === null || e.cadence === "one_time") continue;
      let rate = e.value;
      if (e.trigger.categories?.includes("rotating")) {
        const q = c.rotating?.find((r) => r.quarter === quarter);
        if (!q?.categories.includes(p.category)) continue;
        rate = q.rate;
      } else if (!applies(e, p)) continue;
      if (!channelOk(e)) {
        if (rate > 1) tips.push(`${c.card}: ${rate}${e.unit === "pct" ? "%" : "x"} if booked via ${e.trigger.channel}.`);
        continue;
      }
      const usd = e.unit === "pct" ? (p.amount * rate) / 100 : (p.amount * rate * centsPerPoint) / 100;
      if (usd > earn.usd) earn = { usd, note: `${e.name} (${rate}${e.unit === "pct" ? "%" : "x"})`, e };
    }
    const outside = extra.earn?.[c.slug];
    if (outside) {
      earn = { usd: outside.usd, note: outside.note, e: null };
      warnings.push(...outside.warnings);
    }
    if (earn.e) {
      flag(earn.e);
      const setup = earn.e.requires.find((r) => NEEDS_SETUP[r]);
      if (setup) warnings.push(`Only earns this if you've ${NEEDS_SETUP[setup]} ${earn.e.cadence === "quarterly" ? "this quarter" : ""}`.trim() + ".");
      if (staged && !earn.e.trigger.categories?.includes("everything"))
        warnings.push("Paid with a wallet's one-time card, the charge may not count as this merchant or category, so the bonus may not apply.");
    }

    // Credits: any that this purchase could use.
    const credits: CreditHit[] = [];
    for (const e of c.entitlements) {
      if (e.kind !== "credit" || e.unit !== "USD" || !e.value || e.requires.includes("minimum_spend")) continue;
      if (!applies(e, p)) continue;
      const byMerchant = (e.trigger.merchants ?? []).length > 0;
      if (!channelOk(e)) {
        tips.push(`${c.card}: "${e.name}" applies if booked via ${e.trigger.channel}.`);
        continue;
      }
      // Already used this period (per the status file): it won't pay out again until the period resets.
      const told = creditStatus(e, extra.state?.cards?.[c.slug], today);
      if (told.status === "used") {
        warnings.push(`"${e.name}" was already used this period (${told.on}).`);
        continue;
      }
      flag(e);
      const perPeriod = e.value / (PERIODS[e.cadence] ?? 1);
      const setup = e.requires.filter((r) => NEEDS_SETUP[r]).map((r) => NEEDS_SETUP[r]);
      const note = [
        `up to $${perPeriod} per ${e.cadence.replaceAll("_", " ")} period`,
        setup.length ? `only if you've ${setup.join(" and ")}` : "",
        told.status === "unused" ? `you said it was unused on ${told.on}` : "not confirmed unused this period: ask the user",
      ].filter(Boolean).join("; ");
      credits.push({ id: e.id, name: e.name, up_to_usd: round(Math.min(p.amount, perPeriod)), note });
      if (staged && byMerchant) warnings.push(`"${e.name}" is tied to the merchant; a wallet's one-time card may not trigger it.`);
    }

    const creditUsd = credits.reduce((s, x) => Math.max(s, x.up_to_usd), 0); // credits don't stack on one purchase; take the biggest
    return { card: c.card, slug: c.slug, earn_usd: round(earn.usd), earn_note: earn.note, credits, total_usd: round(earn.usd + creditUsd), warnings };
  });

  options.sort((a, b) => b.total_usd - a.total_usd);
  // A warning every card carries is about the purchase, not the card: say it once.
  const shared = options.length > 1 ? options[0].warnings.filter((w) => options.every((o) => o.warnings.includes(w))) : [];
  for (const o of options) o.warnings = o.warnings.filter((w) => !shared.includes(w));
  tips.push(...shared);

  const benefits: BenefitHit[] = [];
  let unchecked = false; // a benefit with neither a document nor IRS rules behind it
  for (const b of extra.state?.benefits ?? []) {
    if (b.except?.includes(p.category)) continue;
    // A pre-tax account is checked against the IRS rules first: they decide, whatever the user said it covers.
    const rule = b.account && extra.taxRules?.rules[extra.taxRules.accounts[b.account]]?.find((r) => r.category === p.category);
    const listed = !!(b.categories?.length || b.merchants?.length) && applies(asEntitlement(b), p);
    if (!rule && !listed) continue;
    if (rule && rule.status === "not_eligible") {
      tips.push(`${b.name} (${b.source}) can't pay for this: ${rule.note}`);
      continue;
    }
    const told = benefitStatus(b, today);
    if (told.status === "used") {
      tips.push(`"${b.name}" (${b.source}) was already used this period (${told.on}).`);
      continue;
    }
    const usd = b.value === undefined ? null : b.unit === "pct" ? (p.amount * b.value) / 100 : Math.min(p.amount, b.value);
    const note = [
      HOW[b.how],
      b.instructions ?? "",
      tracksUse(b) ? (told.status === "unused" ? `you said it was unused on ${told.on}` : "not confirmed unused this period: ask the user") : "",
    ].filter(Boolean).join("; ");
    if (!b.evidence && !b.account) unchecked = true;
    benefits.push({
      id: b.id, source: b.source, name: b.name, how: b.how, up_to_usd: usd === null ? null : round(usd), note, checked: checkedBy(b),
      ...(rule && { eligibility: { status: rule.status, note: rule.note, source_url: rule.source_url } }),
    });
  }
  if (benefits.some((b) => b.how === "pay_with"))
    tips.unshift("A benefit account (HSA, FSA, commuter) can pay for this with pre-tax money, which usually beats card rewards. If it's eligible and the user pays from it, the card ranking doesn't apply.");
  if (staged) tips.unshift("Pay with the card itself (or a pass-through token) where you can: a wallet's one-time card can lose merchant credits and category bonuses.");
  return {
    best: options[0] ?? null,
    options,
    benefits,
    tips: [...new Set(tips)],
    assumptions: [
      extra.earn ? "Earn rates and point values from CardSavvy where it knows the card; Tap's own otherwise." : `Points and miles valued at ${centsPerPoint}¢ each.`,
      extra.state ? "Credits marked used in the status file are left out; partial use isn't tracked." : "Credit amounts assume the full period's credit is still unused.",
      ...(unchecked
        ? ["Some benefits are as the user described them, not checked against a document; ask for their benefits guide or plan summary."]
        : []),
      ...(benefits.some((b) => b.eligibility?.status === "depends") ? ["Pre-tax account eligibility depends on the item: check it against the eligibility note before paying from the account."] : []),
    ],
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
