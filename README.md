# tap-mcp

**The step before an AI agent pays.** Before a shopping agent checks out, it asks Tap: which of my cards, which statement
credit or other benefit applies (health plan, employer, memberships), have I already used it, and what's about to expire?

Card-picker tools already exist (CardSavvy, PointMaxx and others) and they're good at earn rates. Tap uses
[CardSavvy](https://card-savvy.com)'s free MCP server for those and adds what a per-purchase answer leaves out:

- **Credits at the moment you buy.** A $98 lululemon order on the Amex Platinum earns $1.47 in points, but the $75 quarterly
  lululemon credit is worth fifty times that.
- **What you've already used.** A used credit drops out instead of being promised again.
- **Agent payment risk.** When an agent pays with a wallet's one-time card, merchant credits may not trigger. Tap says so.
- **Benefits beyond cards.** HSA and FSA, gym or wellness reimbursements, commuter and phone stipends, Costco or AAA
  discounts. You describe them once; at checkout Tap says which one covers the purchase and how to use it (pay from the account,
  claim it back, or apply the discount).
- **What's expiring.** Credits, benefit allowances and balances that lapse within 14 days come back with every answer.

## Install

Claude Code:

```sh
claude mcp add tap -- npx -y tap-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "tap": { "command": "npx", "args": ["-y", "tap-mcp"] } } }
```

Needs Node 20+.

## Setup happens in conversation

There's no form. Every answer includes `ask_user`: the next question the agent should ask, one at a time. At checkout,
`optimize_purchase` splits them: `ask_user` holds only what changes this purchase (is the credit still unused?), and
`ask_after_purchase` holds setup questions, so checkout isn't held up.

Tap also sends the agent standing instructions when it connects: check with Tap before paying for anything, without asking
first. That's what makes an agent call it unprompted, even when its tools are loaded lazily.

1. "Which cards do you carry?" → `set_my_cards`
2. A renewal date, only for cards whose credits reset on it → `set_my_cards` with `anniversaries`
3. At purchase time: "Have you used your lululemon credit this quarter, and are you enrolled?" → `mark_credit`
4. "Do you get benefits through work, a health plan or memberships?" → `set_benefits` (memberships by slug, others with a
   quote from your benefits guide; an empty list means none)
5. At purchase time: "Have you used this month's gym reimbursement?" → `mark_benefit`
6. Vouchers, companion fares and other balances when they come up → `set_balance`

## Tools

| Tool | What it does |
|---|---|
| `optimize_purchase` | Best card for a purchase: earn + unused credit, conditions, payment-rail risk, matching `benefits`, `expiring_soon`, `ask_user`, `ask_after_purchase`. Category `general` covers most online shopping |
| `whats_expiring` | Balances, unused credits and benefit allowances or deadlines lapsing in a window, soonest first |
| `list_cards` | Cards and memberships Tap knows (with older names, e.g. Alaska Airlines Visa for Atmos Ascent), and which ones you hold |
| `set_my_cards` · `mark_credit` · `set_benefits` · `mark_benefit` · `set_balance` | Save what you tell your agent |

## Privacy

Your cards, benefits, used credits and balances live in one file on your machine: `~/.tap/state.json` (change it with `TAP_STATE`).
Nothing is sent to Tap. To price earn rates, each purchase check sends CardSavvy the card names, merchant, amount and
category, nothing else. If CardSavvy doesn't answer within 8 seconds, Tap uses its own rates.

## Cards covered

Credits data covers 5 cards so far: Amex Platinum, Chase Sapphire Reserve, Delta SkyMiles Gold, Atmos Rewards Ascent and
Discover it Cash Back. Each entry is checked against the issuer's page (`data/entitlements/`, with source links).
## How Tap checks benefits

- **HSA, health FSA, dependent care FSA:** every purchase is checked against IRS rules (`data/tax-accounts.json`, quoting
  Publications 502 and 503 and the CARES Act notice). Gym dues on an HSA come back as "can't pay for this", with the reason;
  a pharmacy run comes back as "depends on the item", with what qualifies.
- **Memberships:** Costco Executive, Sam's Club Plus and Walmart+ are checked data like the cards (`data/memberships/`), each
  term quoted from the provider's page. Terms Tap couldn't confirm are marked.
- **Your employer and plan benefits:** these differ for everyone, so your agent records them. Share your benefits guide or
  plan summary, and it saves each one with a quote from the document; every answer says whether a benefit came from a
  document or only from what you said, and flags a quote that doesn't show the saved amount.

## Develop

```sh
npm install
npm test        # engine, status-file and data checks (Node 22.18+ runs the TypeScript directly)
npm run build   # compiles to dist/
```

## License

Code: [MIT](LICENSE). Card data (`data/`): [CC BY 4.0](data/LICENSE). Use it, adapt it, credit Tap.
