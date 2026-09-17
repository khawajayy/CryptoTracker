// Shared helpers for the CryptoLedger E2E tests.
//
// The app talks to three live services (CoinGecko, Finnhub, open.er-api.com).
// Tests mock all of them so runs are deterministic and don't depend on the
// internet, API keys, or rate limits. Our scenarios use stock transactions
// entered with a manual price, which the app never sends to a network call
// for (search falls back to the typed symbol, and no Finnhub key means price
// quotes are skipped) - so the mocks below mainly guard against the
// automatic FX-rate refresh that fires on every save.

/** @param {import('@playwright/test').Page} page */
async function mockNetwork(page) {
  await page.route("**://open.er-api.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: "success", rates: { PKR: 278.5 } }),
    })
  );
  await page.route("**://api.coingecko.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ coins: [] }),
    })
  );
  await page.route("**://finnhub.io/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ c: 0 }),
    })
  );
}

/** Open the app on a clean slate: no localStorage, network mocked. */
async function openFreshApp(page) {
  await mockNetwork(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

/** @param {import('@playwright/test').Page} page */
async function openTxModal(page, type) {
  await page.click("#addBtn");
  await page.click(`#txTypeSeg button[data-type="${type}"]`);
}

async function deposit(page, amount) {
  await openTxModal(page, "DEPOSIT");
  await page.fill("#cashAmount", String(amount));
  await page.click("#txSave");
}

async function withdraw(page, amount) {
  await openTxModal(page, "WITHDRAW");
  await page.fill("#cashAmount", String(amount));
  await page.click("#txSave");
}

/**
 * Buy or sell a stock, typed in and priced manually (no live-price network call).
 * @param {"BUY"|"SELL"} type
 */
async function tradeStock(page, type, { symbol, qty, price, fee }) {
  await openTxModal(page, type);
  await page.click('#assetTypeSeg button[data-atype="stock"]');
  await page.fill("#assetSearch", symbol);
  const result = page.locator(`.sr-item:has-text("${symbol.toUpperCase()}")`).first();
  await result.waitFor({ state: "visible" });
  await result.click();
  await page.fill("#qty", String(qty));
  await page.fill("#price", String(price));
  if (fee != null) await page.fill("#fee", String(fee));
  await page.click("#txSave");
}

/**
 * Reads a dashboard card's value by its visible label text.
 * Matches against the card's `.label` element only (not the whole card's
 * text), since sub-lines like "-16.67% on $3,000.00 net capital" would
 * otherwise false-match a "Net capital" lookup on the wrong card.
 */
async function cardValue(page, labelText) {
  const card = page
    .locator(".card")
    .filter({ has: page.locator(".label", { hasText: labelText }) })
    .first();
  return (await card.locator(".value").innerText()).trim();
}

module.exports = {
  mockNetwork,
  openFreshApp,
  openTxModal,
  deposit,
  withdraw,
  tradeStock,
  cardValue,
};
