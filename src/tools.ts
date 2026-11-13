// Tap's MCP server: the step before a shopping agent pays. Which card, what credit applies, what's already used, what's about
// to expire. One user's status lives in one state file; the agent fills it in conversation (set_my_cards, mark_credit,
// set_balance), and every answer says what to ask next. server.ts runs it over stdio, http.ts hosts it for many users.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cardSavvyEarn } from "./cardsavvy.ts";
import { ACCOUNTS, CATEGORIES, type CardFile, type Category, type MembershipFile, type TaxRules } from "./entitlements.ts";
import { BENEFIT_CADENCES, BENEFIT_HOWS, expiring, isIsoDate, withMemberships, type State } from "./expiring.ts";
import { optimizePurchase, type Purchase } from "./optimize.ts";
import { askUser, loadState, markBenefit, markCredit, saveState, setBalance, setBenefits, setCards, setMemberships, type BenefitInput } from "./state.ts";

const data = new URL("../data/", import.meta.url).pathname;
const readDir = <T>(sub: string): T[] => readdirSync(data + sub).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(data + sub + f, "utf8")));
const cards = readDir<CardFile>("entitlements/");
const memberships = readDir<MembershipFile>("memberships/");
const taxRules: TaxRules = JSON.parse(readFileSync(data + "tax-accounts.json", "utf8"));
const slugs = cards.map((c) => c.slug);
const purchaseCategories = CATEGORIES.filter((c) => c !== "everything" && c !== "rotating");
const localToday = () => new Date().toLocaleDateString("en-CA"); // en-CA = YYYY-MM-DD, local day

const tools = [
  {
    name: "delete_my_data",
    description: "Deletes everything Tap has saved for the user (cards, credits used, benefits, balances). Only when the user asks for it, and after they confirm.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean", description: "Must be true: the user confirmed." } }, required: ["confirm"] },
  },
  {
    name: "optimize_purchase",
    description:
      "The step before you pay: call BEFORE paying for anything. Given the merchant, category and amount, ranks the user's cards by rewards earned " +
      "(rates from CardSavvy's catalog) plus any statement credit that applies and hasn't been used this period, returns the conditions to check first " +
      "(enrollment, activation, booking channel), the risks of the payment method, any non-card benefit that covers it (HSA/FSA, reimbursements, " +
      "memberships: in `benefits`, with how to use each), and credits, allowances and balances expiring within 14 days. " +
      "Recommend the best card, relay the warnings, and ask the user the questions in ask_user (one at a time), saving answers with the set_/mark_ tools.",
    inputSchema: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant or brand being paid, e.g. 'Delta Stays', 'Uber', 'lululemon'." },
        category: { type: "string", enum: purchaseCategories, description: "What is being bought. Use general when nothing more specific fits (most online shopping, e.g. household items on Amazon)." },
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
      "What the user is about to lose: balances (airline codes, earned credits, certificates) nearing expiry, this period's card credits not yet used, " +
      "and benefit allowances or deadlines (a monthly gym reimbursement, an FSA use-by date), " +
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
    description: "Lists the cards and memberships Tap knows (slug, name, annual fee) and which ones the user holds. Use it to match what the user says to slugs.",
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
    name: "set_benefits",
    description:
      "Save the user's benefits beyond credit cards: health plan (HSA, FSA, gym or wellness reimbursement), employer (commuter, phone, " +
      "learning stipends), memberships (Costco, AAA, Prime). Adds or replaces by id (default: source + name); `remove` drops ids. " +
      "Call it with an empty list when the user has none. Give categories or merchants so Tap knows which purchases each covers. " +
      "Never store account or member numbers.",
    inputSchema: {
      type: "object",
      properties: {
        benefits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Only to replace a saved benefit; otherwise made from source + name." },
              source: { type: "string", description: "Who gives it, e.g. 'Health plan', 'Employer', 'Costco'." },
              name: { type: "string", description: "e.g. 'Gym reimbursement', 'HSA', 'Commuter benefit'." },
              how: { type: "string", enum: BENEFIT_HOWS, description: "pay_with = a separate account pays (HSA/FSA/commuter card); reimburse = pay, then claim back; discount = cheaper at checkout; allowance = a set amount per period; reward = earned automatically." },
              account: { type: "string", enum: ACCOUNTS, description: "For an HSA, health FSA or dependent care FSA: Tap then checks each purchase against the IRS rules, so categories are optional." },
              categories: { type: "array", items: { type: "string", enum: purchaseCategories } },
              except: { type: "array", items: { type: "string", enum: purchaseCategories }, description: "Categories excluded even at a listed merchant." },
              merchants: { type: "array", items: { type: "string" } },
              value: { type: "number", minimum: 0, description: "Per cadence period ($50 + monthly = $50 a month), or a percent with unit pct." },
              unit: { type: "string", enum: ["USD", "pct"] },
              cadence: { type: "string", enum: BENEFIT_CADENCES },
              resets_on: { type: "string", description: "MM-DD the benefit year starts, if not Jan 1." },
              expires: { type: "string", description: "ISO date it must be used by (an FSA deadline)." },
              instructions: { type: "string", description: "How to use it, e.g. 'submit the receipt in the benefits app'." },
              evidence: {
                type: "object",
                description: "When the user shared a plan summary, benefits guide or portal page: its name and a short exact quote showing the amount and terms.",
                properties: { source: { type: "string" }, quote: { type: "string" }, checked_at: { type: "string", description: "ISO date of the document." } },
                required: ["source", "quote"],
              },
            },
            required: ["source", "name", "how"],
          },
        },
        remove: { type: "array", items: { type: "string" }, description: "Benefit ids to delete." },
        memberships: { type: "array", items: { type: "string", enum: memberships.map((m) => m.slug) }, description: "Every membership the user holds that list_cards knows (replaces the list); Tap supplies their checked benefits." },
      },
      required: ["benefits"],
    },
  },
  {
    name: "mark_benefit",
    description: "Record whether the user has used a benefit this period: used = true, or false if they confirmed it's still unused. Ids come from set_benefits, optimize_purchase and whats_expiring.",
    inputSchema: {
      type: "object",
      properties: { benefit: { type: "string" }, used: { type: "boolean" }, date: { type: "string", description: "ISO date; defaults to today." } },
      required: ["benefit", "used"],
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
function update(statePath: string, apply: (s: State) => State, said: string) {
  const next = apply(loadState(statePath));
  saveState(statePath, next);
  return text({ saved: said, held: next.held ?? [], memberships: next.memberships ?? [], benefits: (next.benefits ?? []).map((b) => b.id), ask_user: askUser(next, cards, localToday()) });
}

async function call(statePath: string, name: string, a: Record<string, unknown>) {
  if (name === "delete_my_data") {
    if (a.confirm !== true) return text("Ask the user to confirm, then call again with confirm: true.", true);
    rmSync(statePath, { force: true });
    return text({ deleted: true, ask_user: askUser({}, cards, localToday()) });
  }
  if (name === "list_cards") {
    const state = loadState(statePath);
    return text({
      cards: cards.map((c) => ({ slug: c.slug, card: c.card, ...(c.aka && { also_called: c.aka }), annual_fee: c.annual_fee, held: (state.held ?? []).includes(c.slug) })),
      memberships: memberships.map((m) => ({ slug: m.slug, membership: m.membership, annual_fee: m.annual_fee, held: (state.memberships ?? []).includes(m.slug) })),
    });
  }
  if (name === "set_my_cards") {
    if (!Array.isArray(a.cards) || !a.cards.every((s) => typeof s === "string")) return text("cards must be a list of slugs.", true);
    const anniversaries = (a.anniversaries ?? {}) as Record<string, string>;
    return update(statePath, (s) => setCards(s, cards, a.cards as string[], anniversaries), `cards: ${(a.cards as string[]).join(", ") || "none"}`);
  }
  if (name === "mark_credit") {
    if (!str(a.card) || !str(a.credit) || typeof a.used !== "boolean") return text("card, credit and used are required.", true);
    const date = str(a.date) ?? localToday();
    return update(statePath, (s) => markCredit(s, cards, a.card as string, a.credit as string, a.used as boolean, date), `${a.credit} on ${a.card}: ${a.used ? "used" : "unused"} as of ${date}`);
  }
  if (name === "set_benefits") {
    if (!Array.isArray(a.benefits) || [a.remove, a.memberships].some((x) => x !== undefined && !Array.isArray(x))) return text("benefits, remove and memberships must be lists.", true);
    if (!a.benefits.every((b) => b && typeof b === "object")) return text("each benefit must be an object.", true);
    const add = a.benefits as BenefitInput[];
    const remove = (a.remove ?? []) as string[];
    const held = a.memberships as string[] | undefined;
    const said = [...add.map((b) => b.name), ...remove.map((r) => `removed ${r}`), ...(held ? [`memberships: ${held.join(", ") || "none"}`] : [])];
    return update(statePath, (s) => {
      const next = setBenefits(s, add, remove);
      return held ? setMemberships(next, memberships.map((m) => m.slug), held) : next;
    }, said.length ? `benefits: ${said.join(", ")}` : "no benefits");
  }
  if (name === "mark_benefit") {
    if (!str(a.benefit) || typeof a.used !== "boolean") return text("benefit and used are required.", true);
    const date = str(a.date) ?? localToday();
    return update(statePath, (s) => markBenefit(s, a.benefit as string, a.used as boolean, date), `${a.benefit}: ${a.used ? "used" : "unused"} as of ${date}`);
  }
  if (name === "set_balance") {
    const b = { name: str(a.name)!, program: str(a.program)!, value: a.value as number, unit: a.unit as "USD", expires: str(a.expires), owner: str(a.owner), notes: str(a.notes) };
    return update(statePath, (s) => setBalance(s, b), `${b.name} (${b.program})`);
  }

  // Reads see the user's own benefits plus those of their memberships, from Tap's checked data.
  const state = withMemberships(loadState(statePath), memberships);
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
  if (!held.length && !state.benefits?.length) return text({ best: null, ask_user: askUser(state, cards, localToday()) });

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
  const answer = optimizePurchase(purchase, cards, held, { state, earn: earn ?? undefined, taxRules });
  if (!earn) answer.assumptions.unshift("CardSavvy wasn't used (no answer, or the purchase is in another quarter), so earn rates are Tap's own.");
  // Only what changes this purchase is asked before paying; setup questions wait until the order is placed.
  const setup = askUser(state, cards, today);
  const now = askUser(state, cards, today, answer).filter((q) => !setup.includes(q));
  return text({ ...answer, expiring_soon: expiring(state, cards, held, today, 14).due, ask_user: now, ask_after_purchase: setup });
}

// Shown to the agent at every session start, even when the tools themselves are loaded lazily: this is what makes it call Tap unprompted.
const instructions =
  "Tap knows which credit cards and benefits the user has, and which one to pay with. Whenever you are about to pay for something for the user " +
  "(a browser checkout, a booking, an API order, any merchant), call optimize_purchase as soon as the merchant and total are known, before you show the user an order summary or ask them to confirm payment. " +
  "Don't ask whether to check; check, then tell the user which card to use and why in one line, and switch the card at checkout if it isn't already selected. " +
  "Ask the ask_user questions before paying (they change this purchase); ask the ask_after_purchase questions once the order is done. " +
  "If Tap has no cards saved, ask the user which cards they carry; if a checkout page lists their cards, you may suggest those names, but confirm with the user before saving.";
export const VERSION = "0.4.0";

/** An MCP server bound to one user's state file. `onDelete` runs after delete_my_data (hosted Tap signs the user out there). */
export function makeServer(statePath: string, onDelete?: () => void) {
  const server = new Server({ name: "tap", version: VERSION }, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const out = await call(statePath, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      if (req.params.name === "delete_my_data" && !out.isError) onDelete?.();
      return out;
    } catch (err) {
      // Bad input to a write, or a hand-broken status file: tell the agent what's wrong instead of dropping the call.
      return text((err as Error).message, true);
    }
  });
  return server;
}
