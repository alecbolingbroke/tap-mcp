---
name: tap
description: Pick which of the user's credit cards or benefits to pay with. Use whenever you buy, order, book, reserve, subscribe to or check out anything for the user (Amazon, any store, travel, food, a browser checkout or an API order), as soon as the merchant and total are known and before you show an order summary or ask the user to confirm payment. Also for "which card should I use", "what's expiring" and "/tap".
---

# Tap: check before you pay

Tap is an MCP server (`tap`). Its tools may be loaded lazily: if `optimize_purchase` isn't callable yet, load the `tap` tools first.

1. **When the merchant and total are known, call `optimize_purchase`.** Do this before you show the order summary or the payment method. Don't ask whether to check; just check.
   - `amount`: the order total including tax and shipping, as the checkout shows it.
   - `category`: the closest match, or `general` for most online shopping (household items on Amazon).
   - `rail: "staged_virtual_card"` if you pay with a wallet's one-time card (e.g. Link).
2. **If it returns `best: null` with "Which credit cards do you carry?"**, ask the user.
   You may suggest the card names a checkout page shows (e.g. Amazon's payment list), but confirm with the user before saving them with `set_my_cards`.
   `list_cards` has older names under `also_called`. Then call `optimize_purchase` again.
3. **Use the best card.** Say which card and why in one line. If the checkout shows a different card, switch it before asking the user to confirm the order.
   Pass on the warnings and tips that matter, in plain words. A non-card benefit in `benefits` (HSA, FSA, a membership reward) comes first when it applies.
4. **Ask `ask_user` questions before paying**, one at a time. They change this purchase.
   Ask `ask_after_purchase` questions **after** the order is placed. Save answers with the `set_*` and `mark_*` tools.
5. **Never save card numbers or account numbers.** Tap stores only which cards and benefits the user has.

For "what's expiring", call `whats_expiring`.
