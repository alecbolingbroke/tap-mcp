#!/usr/bin/env node
// Tap as an MCP server (stdio): the step before a shopping agent pays. Which card, what credit applies, what's already
// used, what's about to expire. The user's status lives in TAP_STATE (default ~/.tap/state.json) on their own machine;
// the agent fills it in conversation (set_my_cards, mark_credit, set_balance), and every answer says what to ask next.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cardSavvyEarn } from "./cardsavvy.ts";
import { CATEGORIES, type CardFile, type Category } from "./entitlements.ts";
import { expiring, isIsoDate, type State } from "./expiring.ts";
import { optimizePurchase, type Purchase } from "./optimize.ts";
import { askUser, loadState, markCredit, saveState, setBalance, setCards } from "./state.ts";

const dir = new URL("../data/entitlements/", import.meta.url).pathname;
const cards: CardFile[] = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(dir + f, "utf8")));
const slugs = cards.map((c) => c.slug);
const statePath = process.env.TAP_STATE ?? `${homedir()}/.tap/state.json`;
const localToday = () => new Date().toLocaleDateString("en-CA"); // en-CA = YYYY-MM-DD, local day

const tools = [
  {
    name: "optimize_purchase",
    description:
      "The step before you pay: call BEFORE paying for anything. Given the merchant, category and amount, ranks the user's cards by rewards earned " +
      "(rates from CardSavvy's catalog) plus any statement credit that applies and hasn't been used this period, returns the conditions to check first " +
      "(enrollment, activation, booking channel), the risks of the payment method, and credits and balances expiring within 14 days. " +
      "Recommend the best card, relay the warnings, and ask the user the questions in ask_user (one at a time), saving answers with the set_/mark_ tools.",
    inputSchema: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant or brand being paid, e.g. 'Delta Stays', 'Uber', 'lululemon'." },
        category: { type: "string", enum: CATEGORIES.filter((c) => c !== "everything" && c !== "rotating"), description: "What is being bought." },
        amount: { type: "number", exclusiveMinimum: 0, description: "Purchase total in USD." },
        date: { type: "string", description: "ISO date of the purchase; defaults to today." },
        booked_via: { type: "string", enum: ["direct", "issuer_portal"], description: "issuer_portal = booked through the card issuer's travel site." },
        rail: { type: "string", enum: ["card", "staged_virtual_card"], description: "staged_virtual_card = paying with a wallet's one-time card (e.g. Link) instead of the card itself." },
      },
      required: ["merchant", "category", "amount"],
    },
  },
  {
    name: "whats_expiring",
    description:
      "What the user is about to lose: balances (airline codes, earned credits, certificates) nearing expiry, and this period's card credits not yet used, " +
      "soonest first, with what each needs (enrollment, booking channel, spend). Call it when planning trips or purchases, or when asked what's expiring.",
    inputSchema: {
      type: "object",
      properties: {
        within_days: { type: "number", minimum: 1, maximum: 730, description: "Look-ahead window in days. Default 90." },
        today: { type: "string", description: "ISO date to evaluate from; defaults to today." },
      },
    },
  },
  {
    name: "list_cards",
    description: "Lists the cards Tap knows (slug, name, annual fee) and which ones the user holds. Use it to match what the user says to slugs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_my_cards",
    description:
      "Save which cards the user holds (replaces the list), and optionally each card's renewal date. Call it when the user tells you their cards. " +
      "Only cards from list_cards are supported.",
    inputSchema: {
      type: "object",
      properties: {
        cards: { type: "array", items: { type: "string", enum: slugs }, description: "Every card slug the user holds." },
        anniversaries: { type: "object", additionalProperties: { type: "string" }, description: "Card slug → renewal date as MM-DD, when the user knows it." },
      },
      required: ["cards"],
    },
  },
  {
    name: "mark_credit",
    description:
      "Record what the user said about one card credit this period: used = true if they've used it, false if they confirmed it's still unused " +
      "(Tap then stops asking until the period resets). Credit ids come from optimize_purchase and ask_user.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", enum: slugs },
        credit: { type: "string", description: "The credit's id." },
        used: { type: "boolean" },
        date: { type: "string", description: "ISO date; defaults to today." },
      },
      required: ["card", "credit", "used"],
    },
  },
  {
    name: "set_balance",
    description:
      "Save a balance the user owns that can expire: an airline voucher or code, an earned credit, a certificate, points. Same name + program replaces; " +
      "value 0 removes it. Never store account or member numbers.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "e.g. 'Companion fare', '$100 travel voucher'." },
        program: { type: "string", description: "e.g. 'Alaska', 'Delta', 'Marriott'." },
        value: { type: "number", minimum: 0 },
        unit: { type: "string", enum: ["USD", "points", "count"] },
        expires: { type: "string", description: "ISO date it expires, if any." },
        owner: { type: "string", description: "Whose account it's on, if not the user's (e.g. a partner)." },
        notes: { type: "string" },
      },
      required: ["name", "program", "value", "unit"],
    },
  },
];

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], isError });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** Writes go through here: load, apply, validate, save atomically, then confirm with what to ask next. */
function update(apply: (s: State) => State, said: string) {
  const next = apply(loadState(statePath));
  saveState(statePath, next);
  return text({ saved: said, held: next.held ?? [], ask_user: askUser(next, cards, localToday()) });
}

async function call(name: string, a: Record<string, unknown>) {
  if (name === "list_cards") {
    const held = loadState(statePath).held ?? [];
    return text(cards.map((c) => ({ slug: c.slug, card: c.card, annual_fee: c.annual_fee, held: held.includes(c.slug) })));
  }
  if (name === "set_my_cards") {
    if (!Array.isArray(a.cards) || !a.cards.every((s) => typeof s === "string")) return text("cards must be a list of slugs.", true);
    const anniversaries = (a.anniversaries ?? {}) as Record<string, string>;
    return update((s) => setCards(s, cards, a.cards as string[], anniversaries), `cards: ${(a.cards as string[]).join(", ") || "none"}`);
  }
  if (name === "mark_credit") {
    if (!str(a.card) || !str(a.credit) || typeof a.used !== "boolean") return text("card, credit and used are required.", true);
    const date = str(a.date) ?? localToday();
    return update((s) => markCredit(s, cards, a.card as string, a.credit as string, a.used as boolean, date), `${a.credit} on ${a.card}: ${a.used ? "used" : "unused"} as of ${date}`);
  }
  if (name === "set_balance") {
    const b = { name: str(a.name)!, program: str(a.program)!, value: a.value as number, unit: a.unit as "USD", expires: str(a.expires), owner: str(a.owner), notes: str(a.notes) };
    return update((s) => setBalance(s, b), `${b.name} (${b.program})`);
  }

  const state = loadState(statePath);
  const held = state.held ?? [];
  if (name === "whats_expiring") {
    if (a.today !== undefined && !isIsoDate(a.today)) return text("today must be a real date, YYYY-MM-DD.", true);
    if (a.within_days !== undefined && (typeof a.within_days !== "number" || !(a.within_days >= 1 && a.within_days <= 730))) return text("within_days must be 1-730.", true);
    const today = isIsoDate(a.today) ? a.today : localToday();
    const answer = expiring(state, cards, held, today, typeof a.within_days === "number" ? a.within_days : 90);
    return text({ ...answer, ask_user: askUser(state, cards, today) });
  }
  if (name !== "optimize_purchase") return text(`Unknown tool ${name}`, true);

  // Trust boundary: the agent's arguments.
  if (!str(a.merchant)) return text("merchant is required", true);
  if (!CATEGORIES.includes(a.category as Category)) return text(`category must be one of: ${CATEGORIES.join(", ")}`, true);
  if (typeof a.amount !== "number" || !(a.amount > 0)) return text("amount must be a positive number (USD)", true);
  if (a.date !== undefined && !isIsoDate(a.date)) return text("date must be a real date, YYYY-MM-DD.", true);
  if (!held.length) return text({ best: null, ask_user: askUser(state, cards, localToday()) });

  const purchase: Purchase = {
    merchant: a.merchant as string,
    category: a.category as Category,
    amount: a.amount,
    date: isIsoDate(a.date) ? a.date : undefined,
    booked_via: a.booked_via === "issuer_portal" ? "issuer_portal" : "direct",
    rail: a.rail === "staged_virtual_card" ? "staged_virtual_card" : "card",
  };
  const today = purchase.date ?? localToday();
  const earn = await cardSavvyEarn(purchase, held);
  const answer = optimizePurchase(purchase, cards, held, { state, earn: earn ?? undefined });
  if (!earn) answer.assumptions.unshift("CardSavvy wasn't used (no answer, or the purchase is in another quarter), so earn rates are Tap's own.");
  return text({ ...answer, expiring_soon: expiring(state, cards, held, today, 14).due, ask_user: askUser(state, cards, today, answer) });
}

const server = new Server({ name: "tap", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
  } catch (err) {
    // Bad input to a write, or a hand-broken status file: tell the agent what's wrong instead of dropping the call.
    return text((err as Error).message, true);
  }
});

await server.connect(new StdioServerTransport());
