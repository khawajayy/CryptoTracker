# CryptoLedger

A personal crypto **and** stocks trade ledger + portfolio tracker. Single HTML file, no build step, no server, no account. Your data lives only in your browser (localStorage).

## Run it

Just **double-click `index.html`** (or open it in any browser). That's it.

## The idea

You start with an **initial capital**, then keep trading. The app always shows two layers of truth:

1. **Per-position** — each holding's live value vs. what you actually paid for it (average-cost basis, unrealized P&L).
2. **Whole account** — measured against your **original capital**, so realized losses/gains, further buys, and withdrawals all roll up correctly.

### How the numbers are defined

| Figure | Meaning |
|---|---|
| **Net Capital** | `deposits − withdrawals` — your original-capital anchor |
| **Cash** | uninvested buying power |
| **Holdings Value** | market value of open positions (live prices) |
| **Equity** | `cash + holdings value` — what the account is worth right now |
| **Realized P&L** | locked-in profit/loss from sells |
| **Unrealized P&L** | paper profit/loss on open positions |
| **Total Return** | `equity − net capital` — your P&L vs the original capital you put in |

**Worked example (your Intel → Sandisk case):**
Deposit $3,000 → buy Intel $3,000 → sell Intel $2,500 (realized −$500) → buy Sandisk $2,500.
- Net capital stays **$3,000** (the anchor).
- Realized P&L is **−$500**.
- Sandisk shows against its own **$2,500** cost basis with a live price.
- If Sandisk rises to $3,000, unrealized is +$500 and **Total Return = $0** — the gain exactly recovered the Intel loss. If Sandisk stays flat, Total Return is −$500, i.e. still down vs your original capital. Exactly the behavior you wanted.

## Transactions

- **Deposit / Withdraw** — move cash in/out (changes net capital).
- **Buy / Sell** — quantity × price (+ optional fee). Sells compute realized P&L on average cost. You can't sell more than you hold.

## Live prices

- **Crypto** — CoinGecko, free, no key. Search picks the right coin.
- **Stocks** — Finnhub. Paste a free key in **Settings** (get one at https://finnhub.io/register). Without a key, stock live prices are skipped (everything else still works, and you can enter prices manually).
- Manual **Refresh** button + optional auto-refresh in Settings. Last-known prices are cached.

## Backup

Ledger tab → **Export JSON** / **Import JSON**. Keep a backup, since clearing browser data wipes localStorage.
