# CryptoLedger

A personal crypto **and** stocks trade ledger + portfolio tracker. Single HTML file, no build step. Works fully offline (data in your browser's localStorage), with **optional cloud sync** (Firebase) so the same ledger follows you across devices.

## Run it

- **Offline / single device:** double-click `index.html` (or open it in any browser). Done.
- **Synced across devices:** deploy it once to Firebase Hosting and open its URL anywhere — see **Cloud sync** below.

## Cloud sync (Firebase) — one-time setup

This makes your ledger sync in real time across every device. You do the Firebase setup once; the config values you paste are **not secrets** (access is protected by sign-in + security rules), so they're safe to commit.

**1. Create a Firebase project**
- Go to https://console.firebase.google.com → **Add project** → name it (e.g. `cryptoledger`) → create.

**2. Enable Google sign-in**
- In the project: **Build → Authentication → Get started → Sign-in method → Google → Enable** (pick a support email) → Save.

**3. Create the database**
- **Build → Firestore Database → Create database → Production mode →** pick a location → Enable.

**4. Register a Web app and copy its config**
- Project Overview → the **`</>`** (Web) icon → give it a nickname → Register.
- Copy the `firebaseConfig` object it shows you.

**5. Paste the config into the app**
- Open `index.html`, find the `// ==== PASTE YOUR FIREBASE CONFIG HERE ====` block near the bottom, and replace the placeholder values with yours.
- Put your project id into `.firebaserc` (replace `PASTE_PROJECT_ID`).

**6. Deploy (installs the Firebase CLI if needed)**
```bash
npm install -g firebase-tools
firebase login
firebase deploy
```
This publishes the site **and** the Firestore security rules (`firestore.rules`, which lets each user read/write only their own data). The command prints your live URL, e.g. `https://your-project.web.app`.

**7. Use it**
- Open that URL on any device → **Settings → Cloud sync → Sign in with Google**. The first device uploads your existing data; other devices then load and stay in sync automatically. The header shows a `☁` status.

Notes:
- If you host somewhere other than Firebase Hosting, add that domain under **Authentication → Settings → Authorized domains**, or Google sign-in will be blocked.
- Not configured / signed out? The app still works locally on that device exactly as before.

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

- **Deposit / Withdraw** — move cash in/out (changes net capital). You can't withdraw more cash than you have.
- **Buy / Sell** — quantity × price (+ optional fee). Sells compute realized P&L on average cost. You can't sell more than you hold.
  - **Pick an existing holding** from a dropdown instead of searching every time (Sell lists what you hold; Buy also lists your watchlist and previously-traded assets), or search for something new.
  - **Quantity / Price / Total auto-fill:** enter any two of the three and the third is computed for you (total = quantity × price).
- **Adjust** — reconcile a balance without it being a trade or your own capital:
  - *Cash* — add or remove cash (dividends, interest, fees, corrections). This changes equity and therefore **counts toward return, not net capital**. (For your own money in/out, use Deposit/Withdraw.)
  - *Holding quantity* — add units (airdrop/bonus, brought in at $0 cost) or remove units (transfer-out/correction, removed at average cost with no realized P&L).

  Adjustments only allow logical changes: you can't remove more cash or more units than you currently have.

### Quick actions on a holding

Every row in **Open positions** (dashboard) and **Holdings** has three buttons:

- **＋ Buy** — add to that position (opens the dialog in Buy mode for that asset).
- **－ Sell** — reduce it (Sell mode for that asset).
- **Close** — exit the whole position (Sell mode, pre-filled with your full quantity).

The **price is left blank** so you enter the price you actually bought/sold at; click **Use live price** if you want the current market price instead. Each opens the normal transaction dialog, so you still see the balances, proceeds, and realized P&L before saving.

Prices are shown with full precision for cheap tokens (e.g. `$0.0000123`), so sub-cent coins don't display as `$0.00`.

### Available balances while adding a transaction

The transaction dialog shows the relevant balances for what you're doing: **available cash** for Deposit/Withdraw/Buy and cash adjustments, and **units you hold** (with their live value) for Buy/Sell and holding adjustments. Over-withdrawing, over-selling, or over-removing is blocked with a clear message.

## Live prices

- **Crypto** — CoinGecko, free, no key. Search picks the right coin.
- **Stocks** — Finnhub. Paste a free key in **Settings** (get one at https://finnhub.io/register). Without a key, stock live prices are skipped (everything else still works, and you can enter prices manually).
- Manual **Refresh** button + optional auto-refresh in Settings. Last-known prices are cached.

## Portfolio mode vs Goal mode

A toggle at the top switches between two separate modes:

- **Portfolio** — everything above (dashboard, holdings, ledger, settings).
- **Goal** — track progress toward one or more target portfolio values. Add as many goals as you like (e.g. "First 10k", "Car fund", "100k milestone"); each is a card with:
  - An elegant **progress ring** showing current equity as a % of that goal.
  - **Remaining to goal** and **gain still needed** (with PKR equivalents).
  - **Winning trades needed** — pick an expected profit % per trade (editable right on the card) and it computes, by compounding, how many such trades grow your current equity to the goal (`n = ⌈ln(goal / equity) / ln(1 + pct/100)⌉`). A "Reached!" banner appears once equity passes the target.
  - **Add / Edit / Delete** goals from the Goal screen.

  Goals sync across your devices (via cloud sync). The mode you're in is saved per device. Goal mode is fully separate from Portfolio mode.

## Equity over time (dashboard chart)

Below Open Positions, the dashboard shows an **equity curve**. It's built from real numbers, never faked: earlier points are reconstructed from your ledger (cash + cost basis at each transaction date), and live equity **snapshots are recorded** each time prices refresh, so the curve fills in and reflects true market value as you keep using the app. It shows the current value, the change over the visible range, and the range's high/low. **Hover** (or touch-drag) anywhere on the chart to read the equity value and date at that point, and the **X-axis shows dated ticks** across the range. Equity history is kept per device (not synced), so each device builds its own live curve.

## Break-even vs net capital

The Holdings table shows a **Break-even (net cap)** column: the price each holding must reach for your **total equity to equal your net capital**, with cash and every other position held constant.

`breakevenPrice = (net capital − rest of account) / quantity`, where *rest of account* = cash + market value of your other holdings.

Example: net capital $3,000, you hold 25 Intel and nothing else with $0 cash → break-even is `3,000 / 25 = $120`. The cell also shows the % move needed from the live price (e.g. `+20.0%`). If your cash + other holdings already cover net capital, it reads **✓ covered**. This is distinct from the cost-basis break-even implied by Unrealized P&L.

## Watchlist

A **Watchlist** tab for stocks/coins you want to follow without owning. Search (crypto or stock) to add them; each shows a **live price**, a **＋ Buy** button that opens the transaction dialog pre-filled with that asset, and a remove button. Watchlist prices refresh together with your holdings, and the list syncs across your devices.

## Secondary currency (PKR)

Every figure on the dashboard shows a second line in your chosen currency, converted at the live USD rate. Default is **PKR (Pakistani Rupee)** — so net capital, equity, holdings, and realized/unrealized P&L all appear in rupees under the USD amount, and the header shows the current `USD/PKR` rate.

Change it in **Settings → Secondary currency** (PKR, INR, AED, GBP, EUR, CAD, SAR, JPY). The exchange rate comes from open.er-api.com (free, no key) and refreshes with the price refresh.

**Manual rate override** — in **Settings → Exchange rate**, tick *Override rate manually* to pin your own USD rate (e.g. the rate you actually get converting via USDT) instead of the live market rate. The header chip then reads `USD/PKR … · manual`. Untick it to go back to the live rate anytime. (Switching the secondary currency clears a manual rate, since it was set for the old currency.)

## Backup

Ledger tab → **Export JSON** / **Import JSON**. Keep a backup, since clearing browser data wipes localStorage.
