const { test, expect } = require("@playwright/test");
const { openFreshApp, deposit, withdraw, cardValue } = require("./helpers");

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
});

test("deposit increases cash and net capital", async ({ page }) => {
  await deposit(page, 5000);

  await expect(page.locator("#toast")).toContainText("Transaction saved");
  expect(await cardValue(page, "Cash available")).toBe("$5,000.00");
  expect(await cardValue(page, "Net capital")).toBe("$5,000.00");
});

test("withdrawing more than available cash is rejected", async ({ page }) => {
  await deposit(page, 1000);
  await withdraw(page, 1500);

  await expect(page.locator("#toast")).toContainText("only $1,000.00 in cash");
  // modal should still be open (save was blocked) and cash unchanged
  await expect(page.locator("#txOverlay")).toHaveClass(/open/);
  await page.click("#txCancel");
  expect(await cardValue(page, "Cash available")).toBe("$1,000.00");
});

test("withdraw reduces cash but net capital reflects deposits minus withdrawals", async ({ page }) => {
  await deposit(page, 2000);
  await withdraw(page, 500);

  expect(await cardValue(page, "Cash available")).toBe("$1,500.00");
  expect(await cardValue(page, "Net capital")).toBe("$1,500.00");
});
