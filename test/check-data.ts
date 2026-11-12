// Validates data/entitlements/*.json against the schema in src/lib/entitlements.ts and prints a per-card summary.
// Usage: node test/check-data.ts (part of npm test; exits 1 on any schema error)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CADENCES, CATEGORIES, KINDS, REQUIRES, UNITS, yearlyCredits, type CardFile } from "../src/entitlements.ts";

const DIR = new URL("../data/entitlements/", import.meta.url).pathname;
const MAX_AGE_DAYS = 60;
const has = (list: readonly string[], v: unknown) => list.includes(v as string);

export function check(card: CardFile, today = new Date()) {
  const errs: string[] = [];
  const need = (ok: unknown, msg: string) => ok || errs.push(msg);
  for (const k of ["card", "slug", "issuer", "network", "product_url", "checked_at"] as const) need(typeof card[k] === "string" && card[k], `missing ${k}`);
  need(typeof card.annual_fee === "number", "annual_fee must be a number");
  need(Array.isArray(card.entitlements) && card.entitlements.length, "no entitlements");
  const ids = new Set<string>();
  for (const e of card.entitlements ?? []) {
    const at = `${card.slug}/${e.id}`;
    need(!ids.has(e.id), `${at}: duplicate id`);
    ids.add(e.id);
    need(has(KINDS, e.kind), `${at}: kind "${e.kind}"`);
    need(e.value === null || typeof e.value === "number", `${at}: value must be number or null`);
    need(e.value === null || has(UNITS, e.unit), `${at}: unit "${e.unit}"`);
    need(has(CADENCES, e.cadence), `${at}: cadence "${e.cadence}"`);
    need(e.cadence !== "every_n_years" || typeof e.every_years === "number", `${at}: every_n_years needs every_years`);
    need(e.cadence !== "window_after_trigger" || typeof e.window_months === "number", `${at}: window_after_trigger needs window_months`);
    need(e.resets_on === undefined || /^\d\d-\d\d$/.test(e.resets_on), `${at}: resets_on must be MM-DD`);
    need(e.trigger && typeof e.trigger === "object", `${at}: trigger missing`);
    const earns = e.kind === "multiplier" || e.kind === "credit";
    need(!earns || (e.trigger?.categories ?? []).every((x) => has(CATEGORIES, x)), `${at}: categories ${JSON.stringify(e.trigger?.categories)}`);
    need(Array.isArray(e.requires) && e.requires.every((r) => has(REQUIRES, r)), `${at}: requires ${JSON.stringify(e.requires)}`);
    need(/^https:\/\//.test(e.source_url ?? ""), `${at}: source_url`);
    need(["issuer", "needs_verify"].includes(e.confidence), `${at}: confidence "${e.confidence}"`);
    const age = (today.getTime() - new Date(e.checked_at).getTime()) / 864e5;
    need(age >= 0 && age <= MAX_AGE_DAYS, `${at}: checked_at "${e.checked_at}" not within ${MAX_AGE_DAYS} days`);
  }
  for (const r of card.rotating ?? []) need(r.categories.every((x) => has(CATEGORIES, x)), `${card.slug}/rotating ${r.quarter}: categories`);
  return errs;
}

// Self-check: a minimal valid card passes, a bad cadence fails.
const day = new Date("2026-10-16");
const ok: CardFile = { card: "T", slug: "t", issuer: "I", network: "Visa", product_url: "https://x", checked_at: "2026-10-16", annual_fee: 0,
  entitlements: [{ id: "a", kind: "credit", name: "A", value: 1, unit: "USD", cadence: "monthly", trigger: {}, requires: [], limits: null, source_url: "https://x", confidence: "issuer", checked_at: "2026-10-16" }] };
assert.equal(check(ok, day).length, 0, "self-check: valid card rejected");
assert.equal(check({ ...ok, entitlements: [{ ...ok.entitlements[0], cadence: "weekly" as never }] }, day).length, 1, "self-check: bad cadence accepted");

let failed = 0;
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const card: CardFile = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  const errs = check(card);
  const verify = card.entitlements.filter((e) => e.confidence === "needs_verify").length;
  console.log(`${errs.length ? "✗" : "✓"} ${card.slug}: $${card.annual_fee} fee · ${card.entitlements.length} entitlements · $${yearlyCredits(card)}/yr credits · ${verify} to verify`);
  errs.forEach((e) => console.log("    " + e));
  failed += errs.length;
}
process.exit(failed ? 1 : 0);
