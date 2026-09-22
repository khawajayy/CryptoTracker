const { test, expect } = require("@playwright/test");
const { openFreshApp } = require("./helpers");

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
});

test.describe("Favorite Stocks News Feature", () => {
  test("shows empty state when no favorite stocks are in watchlist", async ({ page }) => {
    // Navigate to News tab
    await page.click('.tab[data-view="news"]');
    await expect(page.locator('.tab[data-view="news"]')).toHaveClass(/active/);

    // Verify empty state messaging
    await expect(page.locator("#view")).toContainText("No favorite stocks in your watchlist");
    await expect(page.locator("#newsGoToWatchlist")).toBeVisible();

    // Clicking 'Go to Watchlist' switches to the watchlist tab
    await page.click("#newsGoToWatchlist");
    await expect(page.locator('.tab[data-view="watchlist"]')).toHaveClass(/active/);
  });

  test("renders news articles and filter pills for favorite stocks", async ({ page }) => {
    // Seed localStorage with favorite stocks
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
      s.favorites = [
        { id: "stock:AAPL", type: "stock", symbol: "AAPL", name: "Apple Inc", coingeckoId: null, img: null },
        { id: "stock:NVDA", type: "stock", symbol: "NVDA", name: "Nvidia Corp", coingeckoId: null, img: null }
      ];
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    });
    await page.reload();

    // Navigate to News tab
    await page.click('.tab[data-view="news"]');
    await expect(page.locator('.tab[data-view="news"]')).toHaveClass(/active/);

    // Verify filter pills exist
    await expect(page.locator('.news-pill[data-newspill="ALL"]')).toBeVisible();
    await expect(page.locator('.news-pill[data-newspill="AAPL"]')).toBeVisible();
    await expect(page.locator('.news-pill[data-newspill="NVDA"]')).toBeVisible();

    // Articles should be rendered
    const cards = page.locator(".news-card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Filter by single stock (AAPL)
    await page.click('.news-pill[data-newspill="AAPL"]');
    await expect(page.locator('.news-pill[data-newspill="AAPL"]')).toHaveClass(/active/);
    await expect(page.locator('.news-pill[data-newspill="ALL"]')).not.toHaveClass(/active/);

    // All displayed cards should belong to AAPL
    const aaplCards = page.locator(".news-card");
    const aaplCount = await aaplCards.count();
    expect(aaplCount).toBeGreaterThan(0);
    for (let i = 0; i < aaplCount; i++) {
      await expect(aaplCards.nth(i).locator(".news-ticker-tag")).toHaveText("AAPL");
    }
  });

  test("allows instant searching and filtering of headlines", async ({ page }) => {
    // Seed with favorite stock
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
      s.favorites = [
        { id: "stock:MSFT", type: "stock", symbol: "MSFT", name: "Microsoft Corp", coingeckoId: null, img: null }
      ];
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    });
    await page.reload();

    await page.click('.tab[data-view="news"]');
    await expect(page.locator(".news-card").first()).toBeVisible();

    // Search for a keyword guaranteed not to exist
    await page.fill("#newsSearchInput", "xyznonexistentquery123");
    await expect(page.locator("#newsGrid")).toContainText("No news found");

    // Clear search and cards return
    await page.fill("#newsSearchInput", "");
    await expect(page.locator(".news-card").first()).toBeVisible();
  });

  test("navigates from Watchlist row directly into filtered News tab", async ({ page }) => {
    // Seed with favorite stock
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
      s.favorites = [
        { id: "stock:TSLA", type: "stock", symbol: "TSLA", name: "Tesla Inc", coingeckoId: null, img: null }
      ];
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    });
    await page.reload();

    // Go to Watchlist
    await page.click('.tab[data-view="watchlist"]');
    const newsBtn = page.locator('button[data-favnews="TSLA"]');
    await expect(newsBtn).toBeVisible();

    // Click news button on the TSLA row
    await newsBtn.click();

    // Verify active view is news and TSLA pill is selected
    await expect(page.locator('.tab[data-view="news"]')).toHaveClass(/active/);
    await expect(page.locator('.news-pill[data-newspill="TSLA"]')).toHaveClass(/active/);
    await expect(page.locator(".news-ticker-tag").first()).toHaveText("TSLA");
  });

  test("fetches live company news when Finnhub API key is present", async ({ page }) => {
    // Mock Finnhub company-news endpoint specifically
    await page.route("**/company-news**", route => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 99991,
            headline: "AMD Unveils Next-Gen AI Accelerators in Global Keynote",
            summary: "Advanced Micro Devices announced high-performance computing chipsets for enterprise data centers.",
            source: "Financial Times",
            url: "https://example.com/amd-news",
            datetime: Math.floor(Date.now() / 1000) - 1800,
            image: "https://example.com/amd.jpg"
          }
        ])
      });
    });

    // Seed state with Finnhub key and AMD favorite
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
      s.settings = s.settings || {};
      s.settings.finnhubKey = "mock_api_key";
      s.favorites = [
        { id: "stock:AMD", type: "stock", symbol: "AMD", name: "Advanced Micro Devices", coingeckoId: null, img: null }
      ];
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    });
    await page.reload();

    await page.click('.tab[data-view="news"]');

    // Verify the mocked headline and source are displayed
    await expect(page.locator(".news-card-title")).toContainText("AMD Unveils Next-Gen AI Accelerators");
    await expect(page.locator(".news-source")).toHaveText("Financial Times");
    await expect(page.locator(".news-ticker-tag")).toHaveText("AMD");
  });
});
