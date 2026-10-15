const { test, expect } = require("@playwright/test");
const { openFreshApp, deposit, cardValue } = require("./helpers");

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
});

test("money owed to others is editable, persists, and leaves the ledger alone", async ({ page }) => {
  await deposit(page, 5000);

  const card = page.locator("#owedCard");
  await expect(card).toContainText("equity after debts $5,000.00");

  const input = page.locator("#owedInput");
  await input.fill("");
  await input.pressSequentially("1200.5");
  await expect(input).toHaveValue("1,200.5");
  await input.press("Enter");

  await expect(page.locator("#toast")).toContainText("Owed to others set to $1,200.50");
  await expect(card).toContainText("equity after debts $3,799.50");

  // net capital and returns are not affected by the debt
  expect(await cardValue(page, "Net capital")).toBe("$5,000.00");

  // persists across reloads
  await page.reload();
  await expect(page.locator("#owedInput")).toHaveValue("1,200.5");
  await expect(page.locator("#owedCard")).toContainText("equity after debts $3,799.50");

  // clearing it removes the debt
  await page.locator("#owedInput").fill("");
  await page.locator("#owedInput").press("Enter");
  await expect(page.locator("#toast")).toContainText("Cleared money owed to others");
  await expect(page.locator("#owedCard")).toContainText("equity after debts $5,000.00");
});

test("an invalid owed amount is rejected", async ({ page }) => {
  await deposit(page, 1000);
  const input = page.locator("#owedInput");
  await input.fill("-20");
  await input.press("Enter");
  await expect(page.locator("#toast")).toContainText("Enter a valid amount");
  await expect(page.locator("#owedCard")).toContainText("equity after debts $1,000.00");
});
