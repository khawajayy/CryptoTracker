const { test, expect } = require("@playwright/test");
const { openFreshApp, deposit, tradeStock, cardValue } = require("./helpers");

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
});

// Mirrors the worked example in the README:
// Deposit $3,000 -> buy Intel $3,000 -> sell Intel $2,500 (realized -$500)
// -> buy Sandisk $2,500. Net capital stays $3,000 throughout.
test("realized loss on a sale is preserved through a follow-up buy (Intel -> Sandisk)", async ({ page }) => {
  await deposit(page, 3000);
  expect(await cardValue(page, "Net capital")).toBe("$3,000.00");

  await tradeStock(page, "BUY", { symbol: "INTC", qty: 20, price: 150 }); // 20 * 150 = 3000
  expect(await cardValue(page, "Cash available")).toBe("$0.00");

  await tradeStock(page, "SELL", { symbol: "INTC", qty: 20, price: 125 }); // 20 * 125 = 2500, realized -500
  expect(await cardValue(page, "Realized P&L")).toBe("▼$500.00");
  expect(await cardValue(page, "Cash available")).toBe("$2,500.00");
  expect(await cardValue(page, "Net capital")).toBe("$3,000.00");

  await tradeStock(page, "BUY", { symbol: "SNDK", qty: 20, price: 125 }); // 20 * 125 = 2500
  expect(await cardValue(page, "Cash available")).toBe("$0.00");
  expect(await cardValue(page, "Net capital")).toBe("$3,000.00");
  expect(await cardValue(page, "Realized P&L")).toBe("▼$500.00");

  // No live price is available for Sandisk in this test, so holdings value
  // falls back to cost basis ($2,500) and total return equals realized P&L.
  expect(await cardValue(page, "Holdings value")).toBe("$2,500.00");
});

test("selling more than you hold is rejected", async ({ page }) => {
  await deposit(page, 1000);
  await tradeStock(page, "BUY", { symbol: "INTC", qty: 10, price: 100 });

  await tradeStock(page, "SELL", { symbol: "INTC", qty: 20, price: 100 });

  await expect(page.locator("#toast")).toContainText("you only hold 10");
  await page.click("#txCancel");
  expect(await cardValue(page, "Cash available")).toBe("$0.00");
});

test("a fee on a buy is capitalized into cost basis and reduces cash", async ({ page }) => {
  await deposit(page, 1000);
  await tradeStock(page, "BUY", { symbol: "INTC", qty: 10, price: 90, fee: 10 }); // 900 + 10 fee

  expect(await cardValue(page, "Cash available")).toBe("$90.00");
  expect(await cardValue(page, "Fees paid")).toBe("$10.00");
});
