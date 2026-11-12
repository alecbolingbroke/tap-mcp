// whats_expiring: what the user is about to lose. Two sources: balances they hold (codes, earned credits, certificates) with an
// expiry date, and this period's recurring card credits they haven't used yet. Pure: data in, answer out. All dates are ISO
// YYYY-MM-DD and compared as calendar days (UTC arithmetic on date-only values, so the user's timezone can't shift a day).
import { ACCOUNTS, CATEGORIES, PERIODS, type Account, type CardFile, type Category, type Entitlement, type MembershipFile } from "./entitlements.ts";

/** The user's own status. Lives outside the repo (~/.tap/state.json): it holds personal balances. */
export type State = {
  /** Card slugs the user holds (set_my_cards). */
  held?: string[];
  cards?: Record<string, {
    /** "MM-DD" the card year starts. */ anniversary?: string;
    /** entitlement id → ISO date last used. */ used?: Record<string, string>;
    /** entitlement id → ISO date the user said it was still unused (so Tap stops asking this period). */ checked?: Record<string, string>;
  }>;
  balances?: { name: string; program: string; owner?: string; value: number; unit: "USD" | "points" | "count"; expires?: string; notes?: string }[];
  /** Benefits outside cards (set_benefits). Missing = never asked; [] = the user has none. */
  benefits?: Benefit[];
  /** Membership slugs from data/memberships (Costco Executive…): their benefits come from Tap's checked data, not from here. */
  memberships?: string[];
};

export const BENEFIT_HOWS = ["pay_with", "reimburse", "discount", "allowance", "reward"] as const;
export const BENEFIT_CADENCES = ["monthly", "quarterly", "semiannual", "calendar_year", "one_time", "ongoing"] as const;
/** A benefit from a health plan, employer or membership, as the user described it. Unlike card perks it's per person, so it lives here. */
export type Benefit = {
  id: string;
  /** Who gives it: "Health plan", "Employer", "Costco". */ source: string;
  name: string;
  /** pay_with: a separate account pays (HSA, FSA, commuter card). reimburse: pay, then claim it back. discount: cheaper at checkout.
   * allowance: a set amount per period. reward: earned automatically (a membership's % back). */
  how: (typeof BENEFIT_HOWS)[number];
  /** A pre-tax account: Tap then checks each purchase against the IRS rules in data/tax-accounts.json. */ account?: Account;
  categories?: Category[];
  /** Categories excluded even at a listed merchant (Costco's reward skips gas). */ except?: Category[];
  merchants?: string[];
  /** Per cadence period (50 + monthly = $50 a month), or a percent with unit "pct". */ value?: number;
  unit?: "USD" | "pct";
  cadence?: (typeof BENEFIT_CADENCES)[number];
  /** "MM-DD" the benefit year starts, when it isn't Jan 1. */ resets_on?: string;
  /** ISO date it must be used by (an FSA deadline, a one-time stipend). */ expires?: string;
  /** How to use it, e.g. "pay with the HSA debit card", "submit the receipt in the benefits app". */ instructions?: string;
  /** Where the terms come from: a quote from the user's plan document, or (by "tap") Tap's checked membership data. */
  evidence?: { source: string; quote: string; checked_at?: string; by?: "tap"; needs_verify?: boolean };
  /** ISO dates: last used, and last confirmed unused (mark_benefit). */ used?: string;
  checked?: string;
};

/** The user's own benefits plus those of the memberships they hold, read from data so a re-check reaches everyone. */
export function withMemberships(state: State, files: MembershipFile[]): State {
  const extra = (state.memberships ?? []).flatMap((slug): Benefit[] => {
    const m = files.find((f) => f.slug === slug);
    return (m?.benefits ?? []).map(({ source_url, source_excerpt, confidence, ...b }) => ({
      ...b,
      id: `${slug}/${b.id}`,
      source: m!.membership,
      evidence: { source: source_url, quote: source_excerpt, checked_at: m!.checked_at, by: "tap", ...(confidence === "needs_verify" && { needs_verify: true }) },
    }));
  });
  return extra.length ? { ...state, benefits: [...(state.benefits ?? []), ...extra] } : state;
}

/** A benefit in the card-entitlement shape, so period() and creditStatus() work on it unchanged. */
export const asEntitlement = (b: Benefit): Entitlement => ({
  id: b.id, kind: b.how === "discount" ? "perk" : "credit", name: b.name, value: b.value ?? null, unit: b.unit ?? null,
  cadence: b.cadence ?? "ongoing", resets_on: b.resets_on, trigger: { merchants: b.merchants, categories: b.categories },
  requires: [], limits: null, source_url: "", checked_at: "", confidence: "issuer",
});
/** A fixed amount that resets each period, so "used it yet?" is worth asking. */
export const tracksUse = (b: Benefit) => b.value !== undefined && b.unit !== "pct" && !!b.cadence && b.cadence !== "ongoing";
export const benefitStatus = (b: Benefit, today: string) =>
  creditStatus(asEntitlement(b), { used: b.used ? { [b.id]: b.used } : undefined, checked: b.checked ? { [b.id]: b.checked } : undefined }, today);

export type Due = { expires: string; days_left: number; what: string; value: string; card?: string; /** card slug + credit id, for mark_credit */ mark?: { card: string; credit: string }; /** benefit id, for mark_benefit */ benefit?: string; notes: string[] };
export type ExpiringAnswer = { due: Due[]; gaps: string[] };

const DAY = 86_400_000;
const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** A real calendar date: the round trip refuses 2027-09-31, which Date.UTC would silently turn into 10-01. */
export const isIsoDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(day(s)) === s;
export const isMonthDay = (s: string) => isIsoDate(`2000-${s}`); // 2000 is a leap year, so 02-29 passes

/** The current period [start, end] (inclusive days) of a recurring entitlement, or null if it doesn't recur on a calendar. */
export function period(e: Entitlement, today: string, anniversary?: string): { start: number; end: number } | null {
  const t = day(today);
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7) - 1;
  const span = (start: number, next: number) => ({ start, end: next - DAY });
  // A year that starts on a fixed MM-DD (calendar year with a reset date, or the card anniversary).
  const yearFrom = (mmdd: string) => {
    const at = (yr: number) => Date.UTC(yr, +mmdd.slice(0, 2) - 1, +mmdd.slice(3, 5));
    const startYear = at(y) <= t ? y : y - 1;
    return span(at(startYear), at(startYear + 1));
  };
  switch (e.cadence) {
    case "monthly": return span(Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1));
    case "quarterly": { const q = m - (m % 3); return span(Date.UTC(y, q, 1), Date.UTC(y, q + 3, 1)); }
    case "semiannual": { const h = m < 6 ? 0 : 6; return span(Date.UTC(y, h, 1), Date.UTC(y, h + 6, 1)); }
    case "calendar_year": return yearFrom(e.resets_on ?? "01-01");
    case "card_anniversary": return anniversary ? yearFrom(anniversary) : null;
    default: return null;
  }
}

type CardState = NonNullable<State["cards"]>[string];
/** What the user has told Tap about one credit for the current period: used, confirmed unused, or nothing yet. */
export function creditStatus(e: Entitlement, mine: CardState | undefined, today: string): { status: "used" | "unused" | "unknown"; on?: string } {
  const p = period(e, today, mine?.anniversary);
  // No known period (renewal date not set, or a one-off credit): trust an answer for a year, not forever.
  const inPeriod = (d?: string) => !!d && day(d) >= (p ? p.start : day(today) - 365 * DAY);
  if (inPeriod(mine?.used?.[e.id])) return { status: "used", on: mine!.used![e.id] };
  if (inPeriod(mine?.checked?.[e.id])) return { status: "unused", on: mine!.checked![e.id] };
  return { status: "unknown" };
}

/** Throws on a malformed status file (it's hand- or agent-written: the trust boundary). */
export function checkState(s: State): State {
  if (s.held !== undefined && !(Array.isArray(s.held) && s.held.every((x) => typeof x === "string"))) throw new Error("held must be a list of card slugs");
  for (const [slug, c] of Object.entries(s.cards ?? {})) {
    if (c.anniversary && !isMonthDay(c.anniversary)) throw new Error(`cards.${slug}.anniversary must be MM-DD`);
    for (const key of ["used", "checked"] as const)
      for (const [id, d] of Object.entries(c[key] ?? {})) if (!isIsoDate(d)) throw new Error(`cards.${slug}.${key}.${id} must be YYYY-MM-DD`);
  }
  for (const b of s.balances ?? []) {
    if (!b.name || typeof b.value !== "number") throw new Error(`each balance needs a name and a numeric value`);
    if (b.expires && !isIsoDate(b.expires)) throw new Error(`balance "${b.name}" expires must be YYYY-MM-DD`);
  }
  if (s.benefits !== undefined && !Array.isArray(s.benefits)) throw new Error("benefits must be a list");
  if (s.memberships !== undefined && !(Array.isArray(s.memberships) && s.memberships.every((x) => typeof x === "string"))) throw new Error("memberships must be a list of slugs");
  for (const b of s.benefits ?? []) {
    if (!b.id || !b.source?.trim() || !b.name?.trim()) throw new Error("each benefit needs a source and a name");
    if (!BENEFIT_HOWS.includes(b.how)) throw new Error(`benefit "${b.name}" how must be one of: ${BENEFIT_HOWS.join(", ")}`);
    if (b.cadence !== undefined && !BENEFIT_CADENCES.includes(b.cadence)) throw new Error(`benefit "${b.name}" cadence must be one of: ${BENEFIT_CADENCES.join(", ")}`);
    const bad = (b.categories ?? []).find((c) => !CATEGORIES.includes(c));
    if (bad) throw new Error(`benefit "${b.name}" has an unknown category "${bad}"`);
    if (b.account !== undefined && !ACCOUNTS.includes(b.account)) throw new Error(`benefit "${b.name}" account must be one of: ${ACCOUNTS.join(", ")}`);
    const badExcept = (b.except ?? []).find((c) => !CATEGORIES.includes(c));
    if (badExcept) throw new Error(`benefit "${b.name}" has an unknown except category "${badExcept}"`);
    if (!b.categories?.length && !b.merchants?.length && !b.account) throw new Error(`benefit "${b.name}" needs categories, merchants or an account, so Tap knows which purchases it covers`);
    if (b.evidence !== undefined && !(b.evidence.source?.trim() && b.evidence.quote?.trim())) throw new Error(`benefit "${b.name}" evidence needs a source and a quote`);
    if (b.value !== undefined && !(typeof b.value === "number" && b.value >= 0)) throw new Error(`benefit "${b.name}" value must be a number, 0 or more`);
    if (b.unit !== undefined && b.unit !== "USD" && b.unit !== "pct") throw new Error(`benefit "${b.name}" unit must be USD or pct`);
    if (b.resets_on && !isMonthDay(b.resets_on)) throw new Error(`benefit "${b.name}" resets_on must be MM-DD`);
    for (const k of ["expires", "used", "checked"] as const) if (b[k] && !isIsoDate(b[k])) throw new Error(`benefit "${b.name}" ${k} must be YYYY-MM-DD`);
  }
  return s;
}

const money = (v: number, unit: string) => (unit === "USD" ? `$${v}` : `${v.toLocaleString("en-US")} ${unit}`);

export function expiring(state: State, cards: CardFile[], held: string[], today: string, horizonDays = 90): ExpiringAnswer {
  const t = day(today);
  const due: Due[] = [];
  const gaps: string[] = [];

  for (const b of state.balances ?? []) {
    if (!b.expires) continue;
    const days = Math.round((day(b.expires) - t) / DAY);
    if (days > horizonDays) continue;
    const notes = [days < 0 ? "Already expired." : "", b.owner ? `On ${b.owner}'s account.` : "", b.notes ?? ""].filter(Boolean);
    due.push({ expires: b.expires, days_left: days, what: `${b.name} (${b.program})`, value: money(b.value, b.unit), notes });
  }

  for (const slug of held) {
    const card = cards.find((c) => c.slug === slug);
    if (!card) continue;
    const mine = state.cards?.[slug] ?? {};
    const needsAnniversary: string[] = [];
    for (const e of card.entitlements) {
      // Only things with a fixed amount that lapse at a period end; percentage rebates and per-purchase perks can't be "lost".
      if (!["credit", "companion", "free_night"].includes(e.kind) || e.unit === "pct") continue;
      const p = period(e, today, mine.anniversary);
      if (!p) {
        if (e.cadence === "card_anniversary") needsAnniversary.push(e.name);
        continue;
      }
      if (creditStatus(e, mine, today).status === "used") continue;
      const days = Math.round((p.end - t) / DAY);
      if (days > horizonDays) continue;
      const notes: string[] = [];
      if (e.requires.includes("minimum_spend")) notes.push("Only earned after a spend threshold; Tap doesn't track spend, so check the card's app.");
      for (const r of ["enrollment", "activation", "registration", "selection"] as const) if (e.requires.includes(r)) notes.push(`Needs ${r} first.`);
      if (e.requires.includes("book_via_channel")) notes.push(`Book through ${e.trigger.channel ?? "the card's own channel"}.`);
      if (e.limits) notes.push(e.limits);
      due.push({
        expires: iso(p.end),
        days_left: days,
        what: e.name,
        // Values are stored per year; a monthly/quarterly credit loses only this period's slice (Uber's $35 December isn't modeled).
        value: e.value == null ? (e.kind === "companion" ? "1 companion fare" : "value unknown") : money(Math.round((e.value / (PERIODS[e.cadence] ?? 1)) * 100) / 100, e.unit ?? "USD"),
        card: card.card,
        mark: { card: slug, credit: e.id },
        notes,
      });
    }
    if (needsAnniversary.length) gaps.push(`Set the card anniversary (MM-DD) for ${card.card} to track: ${needsAnniversary.join(", ")}.`);
  }

  for (const b of state.benefits ?? []) {
    // A discount or a percent can't be lost; an allowance lapses at its period end, anything with a deadline at that date.
    if (b.how === "discount" || b.how === "reward" || b.unit === "pct") continue;
    const p = tracksUse(b) ? period(asEntitlement(b), today) : null;
    const end = Math.min(p?.end ?? Infinity, b.expires ? day(b.expires) : Infinity);
    if (end === Infinity || benefitStatus(b, today).status === "used") continue;
    const days = Math.round((end - t) / DAY);
    if (days > horizonDays) continue;
    const notes = [`From ${b.source}.`, days < 0 ? "Already expired." : "", b.instructions ?? ""].filter(Boolean);
    due.push({ expires: iso(end), days_left: days, what: b.name, value: b.value === undefined ? "value unknown" : money(b.value, "USD"), benefit: b.id, notes });
  }

  due.sort((a, b) => a.expires.localeCompare(b.expires));
  return { due, gaps };
}
