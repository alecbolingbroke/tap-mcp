// whats_expiring: what the user is about to lose. Two sources: balances they hold (codes, earned credits, certificates) with an
// expiry date, and this period's recurring card credits they haven't used yet. Pure: data in, answer out. All dates are ISO
// YYYY-MM-DD and compared as calendar days (UTC arithmetic on date-only values, so the user's timezone can't shift a day).
import { PERIODS, type CardFile, type Entitlement } from "./entitlements.ts";

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
};

export type Due = { expires: string; days_left: number; what: string; value: string; card?: string; /** card slug + credit id, for mark_credit */ mark?: { card: string; credit: string }; notes: string[] };
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

  due.sort((a, b) => a.expires.localeCompare(b.expires));
  return { due, gaps };
}
