// Earn rates from CardSavvy's public MCP server (no token needed for best_card_for_purchase). Its catalog is far bigger than
// Tap's, so Tap uses it for "what does this card earn here" and keeps what that tool leaves out: credits, what's already
// used, and payment-rail risk. Sends CardSavvy the card names, merchant, amount and category of the purchase, nothing else.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Category } from "./entitlements.ts";
import type { Earn, Purchase } from "./optimize.ts";

const SERVER = "https://mcp.card-savvy.com/mcp";

// shortcut: hand-mapped catalog names for the 5-card pilot; move to a `cardsavvy_name` field in the card files when the pilot grows.
export const CARDSAVVY_NAMES: Record<string, string> = {
  "discover-it-cash-back": "Discover it Cash Back",
  "delta-skymiles-gold-amex": "Delta SkyMiles Gold",
  "atmos-rewards-ascent-visa-signature": "Atmos Rewards Ascent Visa Signature",
  "amex-platinum": "American Express Platinum Card",
  "chase-sapphire-reserve": "Chase Sapphire Reserve",
};
// Only the clear matches; anything else goes as "General" and CardSavvy codes it from the merchant name.
const CATEGORY: Partial<Record<Category, string>> = {
  dining: "Dining", grocery: "Grocery", gas: "Gas", airfare: "Flights", hotel: "Hotels", rideshare: "Rideshare", streaming: "Streaming", utilities: "Home Utilities",
};

const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

/** Trust boundary: CardSavvy's reply. Keeps only well-formed rows for cards that were asked about. */
export function parseEarn(reply: unknown, held: string[]): Record<string, Earn> {
  const ranked = (reply as { result?: { ranked?: unknown } } | null)?.result?.ranked;
  const out: Record<string, Earn> = {};
  if (!Array.isArray(ranked)) return out;
  for (const r of ranked as Record<string, unknown>[]) {
    const slug = held.find((s) => CARDSAVVY_NAMES[s] === r?.card_name);
    if (!slug || typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0) continue;
    out[slug] = {
      usd: Math.round(r.value * 100) / 100,
      note: `${typeof r.formula === "string" ? r.formula : "rate"} (CardSavvy, ${typeof r.confidence === "string" ? r.confidence : "unknown"} confidence)`,
      // "Scored as Flights because…" is where CardSavvy's merchant coding can disagree with the agent's category: surface it.
      warnings: [...strings(r.warnings), ...strings(r.assumptions).filter((a) => a.startsWith("Scored as") && !a.endsWith("not as General."))],
    };
  }
  return out;
}

const quarterOf = (iso: string) => `${iso.slice(0, 4)}-${Math.floor((Number(iso.slice(5, 7)) - 1) / 3)}`;

/** CardSavvy's earn per held card, or null when it can't answer (offline, slow, no mapped cards, or a purchase in another quarter). */
export async function cardSavvyEarn(p: Purchase, held: string[], timeoutMs = 8000): Promise<Record<string, Earn> | null> {
  const names = held.map((s) => CARDSAVVY_NAMES[s]).filter(Boolean);
  // CardSavvy scores rotating categories for the current quarter only; a dated purchase in another quarter stays on Tap's calendar.
  if (!names.length || (p.date && quarterOf(p.date) !== quarterOf(new Date().toLocaleDateString("en-CA")))) return null;
  const client = new Client({ name: "tap", version: "0.1.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = (async () => {
      await client.connect(new StreamableHTTPClientTransport(new URL(SERVER)));
      const res = await client.callTool({
        name: "best_card_for_purchase",
        arguments: { card_names: names, amount: p.amount, category: CATEGORY[p.category] ?? "General", merchant: p.merchant },
      });
      const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text;
      return text ? parseEarn(JSON.parse(text), held) : null;
    })().catch(() => null); // the timer may win; the abandoned call must not become an unhandled rejection
    const out = await Promise.race([call, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))]);
    return out && Object.keys(out).length ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
