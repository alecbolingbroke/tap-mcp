// The user's status file: which cards they hold, what they've used, and balances they own. It lives on their machine
// (~/.tap/state.json by default) and only the agent writes it, through the tools below. Pure updates + a load/save pair.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CardFile } from "./entitlements.ts";
import { checkState, creditStatus, expiring, isIsoDate, isMonthDay, type State } from "./expiring.ts";
import type { Answer } from "./optimize.ts";

export const loadState = (path: string): State => (existsSync(path) ? checkState(JSON.parse(readFileSync(path, "utf8"))) : {});

/** Write-then-rename, so a crash mid-write never leaves a half-written file. */
export function saveState(path: string, state: State) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(checkState(state), null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** set_my_cards: replaces the held list; anniversaries ("MM-DD") merge into what's saved. */
export function setCards(state: State, cards: CardFile[], held: string[], anniversaries: Record<string, string> = {}): State {
  const unknown = [...held, ...Object.keys(anniversaries)].filter((s) => !cards.some((c) => c.slug === s));
  if (unknown.length) throw new Error(`Unknown card slugs: ${[...new Set(unknown)].join(", ")}. Call list_cards.`);
  const bad = Object.entries(anniversaries).find(([, d]) => !isMonthDay(d));
  if (bad) throw new Error(`Anniversary for ${bad[0]} must be MM-DD.`);
  const next: State = { ...state, held: [...new Set(held)], cards: { ...state.cards } };
  for (const [slug, d] of Object.entries(anniversaries)) next.cards![slug] = { ...next.cards![slug], anniversary: d };
  return next;
}

/** mark_credit: the user used a credit (used=true) or confirmed it's still unused this period (used=false). */
export function markCredit(state: State, cards: CardFile[], slug: string, creditId: string, used: boolean, date: string): State {
  const card = cards.find((c) => c.slug === slug);
  if (!card) throw new Error(`Unknown card ${slug}. Call list_cards.`);
  if (!card.entitlements.some((e) => e.id === creditId)) throw new Error(`${card.card} has no credit "${creditId}". Use the id from optimize_purchase or whats_expiring.`);
  if (!isIsoDate(date)) throw new Error("date must be YYYY-MM-DD.");
  const mine = state.cards?.[slug] ?? {};
  const [keep, drop] = used ? (["used", "checked"] as const) : (["checked", "used"] as const);
  const rest = { ...mine[drop] };
  delete rest[creditId];
  return { ...state, cards: { ...state.cards, [slug]: { ...mine, [keep]: { ...mine[keep], [creditId]: date }, [drop]: rest } } };
}

type Balance = NonNullable<State["balances"]>[number];
/** set_balance: adds or replaces a balance (same name + program); value 0 removes it. */
export function setBalance(state: State, b: Balance): State {
  if (!b.name?.trim() || !b.program?.trim()) throw new Error("A balance needs a name and a program.");
  if (typeof b.value !== "number" || b.value < 0) throw new Error("value must be a number, 0 or more.");
  if (!["USD", "points", "count"].includes(b.unit)) throw new Error("unit must be USD, points or count.");
  if (b.expires !== undefined && !isIsoDate(b.expires)) throw new Error("expires must be YYYY-MM-DD.");
  const others = (state.balances ?? []).filter((x) => !(x.name === b.name && x.program === b.program));
  return { ...state, balances: b.value === 0 ? others : [...others, b] };
}

/**
 * The few things the agent should ask next, so onboarding happens in conversation: cards first, then a renewal date
 * when a credit depends on it, then (at purchase time) whether the credits this purchase could use are still unused.
 */
export function askUser(state: State, cards: CardFile[], today: string, answer?: Answer): string[] {
  const held = state.held ?? [];
  if (!held.length) return ["Which credit cards do you carry? Match them with list_cards and save them with set_my_cards."];
  const asks = expiring(state, cards, held, today, 0).gaps.map((g) => `${g} (Ask the user, then save it with set_my_cards.)`);
  for (const c of answer?.best ? [answer.best] : []) {
    const entitlements = cards.find((x) => x.slug === c.slug)?.entitlements ?? [];
    for (const hit of c.credits) {
      const e = entitlements.find((x) => x.id === hit.id);
      if (e && creditStatus(e, state.cards?.[c.slug], today).status === "unknown")
        asks.push(`Has the user already used the "${hit.name}" on ${c.card} this period${e.requires.includes("enrollment") ? ", and are they enrolled" : ""}? Save the answer with mark_credit (card "${c.slug}", credit "${hit.id}").`);
    }
  }
  return asks;
}
