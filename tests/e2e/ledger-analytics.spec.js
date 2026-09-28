const { test, expect } = require("@playwright/test");
const { openFreshApp, deposit, tradeStock } = require("./helpers");

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
});

test("combines successive partial sells of SNDK into collective P/L and displays accurate analytics", async ({ page }) => {
  // 1. Initial capital
  await deposit(page, 2000);

  // 2. Buy 100 SNDK @ $10 ($1000)
  await tradeStock(page, "BUY", { symbol: "SNDK", qty: 100, price: 10 });

  // 3. Sell 50 SNDK @ $12 ($600 -> +$100 realized)
  await tradeStock(page, "SELL", { symbol: "SNDK", qty: 50, price: 12 });

  // 4. Sell 50 SNDK @ $8 ($400 -> -$100 realized)
  await tradeStock(page, "SELL", { symbol: "SNDK", qty: 50, price: 8 });

  // Navigate to Ledger tab
  await page.click('.tab[data-view="ledger"]');

  // Verify Analytics Panel is present
  const analyticsPanel = page.locator(".analytics-panel");
  await expect(analyticsPanel).toBeVisible();
  await expect(analyticsPanel).toContainText("Trade Analytics");

  // Since +$100 and -$100 cancel out, collective P/L on this combined trade is $0.00 (Breakeven)
  // Total closed trades should be 1 (NOT 2 separate trades!)
  await expect(analyticsPanel).toContainText("1 closed trade");
  await expect(analyticsPanel).toContainText("Net Realized P&L");
  await expect(analyticsPanel).toContainText("$0.00");
  await expect(analyticsPanel).toContainText("0.0%"); // 0 wins, 0 losses, 1 breakeven
  await expect(analyticsPanel).toContainText("0 trades"); // 0 winning trades

  // Verify Combined Table Row in the Transaction Ledger
  const combinedRow = page.locator(".trade-group-row.is-combined");
  await expect(combinedRow).toBeVisible();
  await expect(combinedRow).toContainText("SELL");
  await expect(combinedRow).toContainText("2 parts");
  await expect(combinedRow).toContainText("100 SNDK");
  await expect(combinedRow).toContainText("+$1,000.00"); // combined cash proceeds
  await expect(combinedRow).toContainText("$0.00"); // collective P/L

  // Verify Expanding Partial Fills
  const expandBtn = combinedRow.locator('button[data-toggle-group]');
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  // Child subrows should now be visible
  const subrows = page.locator(".trade-subrow");
  await expect(subrows).toHaveCount(2);
  await expect(subrows.first()).toContainText("fill 1/2");
  await expect(subrows.first()).toContainText("50 SNDK @ $12.00");
  await expect(subrows.first()).toContainText("▲$100.00");

  await expect(subrows.nth(1)).toContainText("fill 2/2");
  await expect(subrows.nth(1)).toContainText("50 SNDK @ $8.00");
  await expect(subrows.nth(1)).toContainText("▼$100.00");

  // Toggle combine mode off (to show raw transactions)
  await page.click("#toggleCombineBtn");
  await expect(page.locator(".trade-group-row.is-combined")).toHaveCount(0);
  // Both individual SELL rows should now be visible in raw mode
  await expect(page.locator('tbody tr:has-text("SELL")')).toHaveCount(2);

  // Toggle combine mode back on
  await page.click("#toggleCombineBtn");
  await expect(page.locator(".trade-group-row.is-combined")).toBeVisible();
});

test("evaluates collective win on partial sells and calculates win rate, winning amount, and profit factor", async ({ page }) => {
  await deposit(page, 5000);

  // Trade 1: SNDK bought 100 @ $10 ($1000). Sold in parts: 50 @ $14 (+$200), 50 @ $8 (-$100) -> Net collective P/L = +$100 WIN!
  await tradeStock(page, "BUY", { symbol: "SNDK", qty: 100, price: 10 });
  await tradeStock(page, "SELL", { symbol: "SNDK", qty: 50, price: 14 });
  await tradeStock(page, "SELL", { symbol: "SNDK", qty: 50, price: 8 });

  // Trade 2: INTC bought 10 @ $100 ($1000). Sold 10 @ $70 ($700) -> Net P/L = -$300 LOSS!
  await tradeStock(page, "BUY", { symbol: "INTC", qty: 10, price: 100 });
  await tradeStock(page, "SELL", { symbol: "INTC", qty: 10, price: 70 });

  await page.click('.tab[data-view="ledger"]');
  const analyticsPanel = page.locator(".analytics-panel");
  await expect(analyticsPanel).toBeVisible();

  // Total closed trades: 2 (1 SNDK combined trade + 1 INTC trade)
  await expect(analyticsPanel).toContainText("2 closed trades");

  // Win Rate: 1 win out of 2 trades = 50.0%
  await expect(analyticsPanel).toContainText("50.0%");
  await expect(analyticsPanel).toContainText("1W · 1L");

  // Winning Trades: 1 trade, +$100.00 won
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Winning Trades" })).toContainText("1 trade");
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Winning Trades" })).toContainText("+$100.00 total won");

  // Losing Trades: 1 trade, -$300.00 lost
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Losing Trades" })).toContainText("1 trade");
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Losing Trades" })).toContainText("-$300.00 total lost");

  // Net Realized: -$200.00
  await expect(analyticsPanel).toContainText("▼$200.00");

  // Profit Factor: 100 / 300 = 0.33
  await expect(analyticsPanel).toContainText("0.33");

  // Best trade: +$100.00 (SNDK)
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Best & Worst Trades" })).toContainText("+$100.00");
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Best & Worst Trades" })).toContainText("SNDK");

  // Worst trade: -$300.00 (INTC)
  await expect(analyticsPanel.locator(".card").filter({ hasText: "Best & Worst Trades" })).toContainText("Worst: -$300.00 (INTC)");
});

test("does not combine sells if an intervening BUY occurred (non-successive)", async ({ page }) => {
  await deposit(page, 3000);

  // Buy 100 SNDK @ $10
  await tradeStock(page, "BUY", { symbol: "SNDK", qty: 100, price: 10 });
  // Sell 50 SNDK @ $12 -> First trade closed 50 shares
  await tradeStock(page, "SELL", { symbol: "SNDK", qty: 50, price: 12 });
  // Intervening BUY of SNDK
  await tradeStock(page, "BUY", { symbol: "SNDK", qty: 50, price: 10 });
  // Sell 100 SNDK @ $8 -> Second trade
  await tradeStock(page, "SELL", { symbol: "SNDK", qty: 100, price: 8 });

  await page.click('.tab[data-view="ledger"]');

  // Because a BUY intervened, these sells are NOT successive sells of the same position.
  // There should be 2 separate trades, not combined into 1.
  const analyticsPanel = page.locator(".analytics-panel");
  await expect(analyticsPanel).toContainText("2 closed trades");
  await expect(page.locator(".trade-group-row.is-combined")).toHaveCount(0);
});
