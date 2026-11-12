# tap-mcp

**The step before an AI agent pays.** Before a shopping agent checks out, it asks Tap: which of my cards, which statement
credit applies, have I already used it, and what's about to expire?

Card-picker tools already exist (CardSavvy, PointMaxx and others) and they're good at earn rates. Tap uses
[CardSavvy](https://card-savvy.com)'s free MCP server for those and adds what a per-purchase answer leaves out:

- **Credits at the moment you buy.** A $98 lululemon order on the Amex Platinum earns $1.47 in points, but the $75 quarterly
  lululemon credit is worth fifty times that.
- **What you've already used.** A used credit drops out instead of being promised again.
- **Agent payment risk.** When an agent pays with a wallet's one-time card, merchant credits may not trigger. Tap says so.
- **What's expiring.** Credits and balances that lapse within 14 days come back with every answer.

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

There's no form. Every answer includes `ask_user`: the next question the agent should ask, one at a time.

1. "Which cards do you carry?" → `set_my_cards`
2. A renewal date, only for cards whose credits reset on it → `set_my_cards` with `anniversaries`
3. At purchase time: "Have you used your lululemon credit this quarter, and are you enrolled?" → `mark_credit`
4. Vouchers, companion fares and other balances when they come up → `set_balance`

## Tools

| Tool | What it does |
|---|---|
| `optimize_purchase` | Best card for a purchase: earn + unused credit, conditions, payment-rail risk, `expiring_soon`, `ask_user` |
| `whats_expiring` | Balances and unused credits lapsing in a window, soonest first |
| `list_cards` | Cards Tap knows, and which ones you hold |
| `set_my_cards` · `mark_credit` · `set_balance` | Save what you tell your agent |

## Privacy

Your cards, used credits and balances live in one file on your machine: `~/.tap/state.json` (change it with `TAP_STATE`).
Nothing is sent to Tap. To price earn rates, each purchase check sends CardSavvy the card names, merchant, amount and
category, nothing else. If CardSavvy doesn't answer within 8 seconds, Tap uses its own rates.

## Cards covered

Credits data covers 5 cards so far: Amex Platinum, Chase Sapphire Reserve, Delta SkyMiles Gold, Atmos Rewards Ascent and
Discover it Cash Back. Each entry is checked against the issuer's page (`data/entitlements/`, with source links).

## Develop

```sh
npm install
npm test        # engine, status-file and data checks (Node 22.18+ runs the TypeScript directly)
npm run build   # compiles to dist/
```

## License

Code: [MIT](LICENSE). Card data (`data/`): [CC BY 4.0](data/LICENSE). Use it, adapt it, credit Tap.
