// The entitlement database schema (data/entitlements/*.json): shared by the checker script and the dev-only /data browser.
export const KINDS = ["credit", "multiplier", "companion", "free_night", "status", "insurance", "protection", "perk"] as const;
export const UNITS = ["USD", "pct", "points_per_dollar", "miles_per_dollar", "count"] as const;
// every_n_years needs `every_years`; window_after_trigger (e.g. 12 months from activation) needs `window_months`.
export const CADENCES = ["monthly", "quarterly", "semiannual", "calendar_year", "card_anniversary", "one_time", "per_purchase", "ongoing", "every_n_years", "window_after_trigger"] as const;
/** How many times a year a sub-yearly cadence repeats; credit values are stored per year. */
export const PERIODS: Partial<Record<(typeof CADENCES)[number], number>> = { monthly: 12, quarterly: 4, semiannual: 2 };
// Purchase categories for earn rates and credits (what optimize_purchase matches on). "everything" = the card's base rate;
// "rotating" = look up the card's `rotating` calendar for the quarter.
export const CATEGORIES = ["dining", "food_delivery", "grocery", "gas", "ev_charging", "airfare", "airline_fees", "hotel", "vacation_rental", "vacation_packages", "travel", "rideshare", "local_transit", "tolls", "streaming", "digital_news", "cable", "utilities", "entertainment", "fitness", "membership", "apparel", "wearables", "trusted_traveler", "stadium_concessions", "inflight", "lounge", "cargo", "everything", "rotating"] as const;
export type Category = (typeof CATEGORIES)[number];
export const REQUIRES = ["activation", "enrollment", "registration", "minimum_spend", "pay_with_card", "book_via_channel", "selection"] as const;

export type Entitlement = {
  id: string;
  kind: (typeof KINDS)[number];
  name: string;
  value: number | null;
  unit: (typeof UNITS)[number] | null;
  cadence: (typeof CADENCES)[number];
  every_years?: number;
  window_months?: number;
  /** "MM-DD" when the year doesn't start Jan 1 (e.g. Sky Club visits reset 02-01). */
  resets_on?: string;
  trigger: { merchants?: string[]; categories?: Category[]; channel?: string | null };
  requires: (typeof REQUIRES)[number][];
  limits: string | null;
  source_url: string;
  source_excerpt?: string;
  checked_at: string;
  confidence: "issuer" | "needs_verify";
};

export type CardFile = {
  card: string;
  slug: string;
  issuer: string;
  network: string;
  annual_fee: number;
  product_url: string;
  checked_at: string;
  notes?: string;
  entitlements: Entitlement[];
  rotating?: { quarter: string; categories: Category[]; rate: number; cap_usd: number; activation_deadline: string | null; source_url: string; confidence: "issuer" | "needs_verify" }[];
};

/** Credits that come back at least once a year; multi-year and one-off credits would overstate a yearly figure. */
export const isYearlyCredit = (e: Entitlement) =>
  e.kind === "credit" && e.unit === "USD" && !["one_time", "every_n_years", "window_after_trigger"].includes(e.cadence);

export const yearlyCredits = (c: CardFile) => c.entitlements.filter(isYearlyCredit).reduce((s, e) => s + (e.value ?? 0), 0);
