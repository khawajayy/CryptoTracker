const { test, expect } = require("@playwright/test");
const { openFreshApp } = require("./helpers");

test.describe("Homepage Equity Performance Chart", () => {
  test.beforeEach(async ({ page }) => {
    await openFreshApp(page);
  });

  async function seedPortfolioWith50PctGain(page) {
    const now = Date.now();
    const D = 86400000;
    const buyDate = new Date(now - 7 * D).toISOString();

    await page.evaluate(({ buyDate }) => {
      const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
      s.transactions = [
        { id: "tx-1", type: "DEPOSIT", amount: 1000, date: buyDate },
        { id: "tx-2", type: "BUY", assetId: "crypto:BTC", qty: 0.02, price: 50000, fee: 0, date: buyDate }
      ];
      s.assets = s.assets || {};
      s.assets["crypto:BTC"] = {
        id: "crypto:BTC",
        type: "crypto",
        symbol: "BTC",
        name: "Bitcoin",
        coingeckoId: "bitcoin",
        img: null
      };
      s.prices = s.prices || {};
      s.prices["crypto:BTC"] = {
        price: 75000,
        updatedAt: new Date().toISOString()
      };
      s.ui = s.ui || {};
      s.ui.view = "dashboard";
      s.ui.mode = "portfolio";
      s.ui.chartMode = "equity";
      s.ui.chartAsset = "all";
      s.ui.range = { preset: "all", start: null, end: null };
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    }, { buyDate });
    await page.reload();
  }

  test("accurately reflects a 50% portfolio gain and does not render a flat line", async ({ page }) => {
    await seedPortfolioWith50PctGain(page);

    // Verify chart container and header
    const chartPanel = page.locator("#equityChartPanel");
    await expect(chartPanel).toBeVisible();
    await expect(chartPanel.locator("h2")).toContainText("Performance");

    // In default Equity mode, headline reflects $1,500.00 and +$500.00 (+50.00%)
    await expect(chartPanel.locator(".bignum")).toHaveText("$1,500.00");
    await expect(chartPanel).toContainText("+$500.00 (+50.00%)");

    // Check stats strip reflects Period Low and Period High accurately
    const statsStrip = chartPanel.locator(".chart-stats-strip");
    await expect(statsStrip).toBeVisible();
    await expect(statsStrip).toContainText("Period Low: $1,000.00");
    await expect(statsStrip).toContainText("Period High: $1,500.00");
    await expect(statsStrip).toContainText("$500.00");

    // Inspect the SVG curve path to ensure it is NOT flat
    const mainPath = chartPanel.locator("#eqChart svg path[stroke='var(--green)']");
    await expect(mainPath).toBeVisible();
    const d = await mainPath.getAttribute("d");
    expect(d).toBeTruthy();

    // Extract Y-coordinates from path "M x,y C cx1,cy1 cx2,cy2 x2,y2 ..."
    const coords = d.match(/[\d.]+,([\d.]+)/g).map(s => parseFloat(s.split(",")[1]));
    const firstY = coords[0];
    const lastY = coords[coords.length - 1];

    // SVG coordinates: lower Y means higher value.
    // The curve must rise significantly (at least 60px vertical delta out of 200px drawable height)
    const verticalRise = firstY - lastY;
    expect(verticalRise).toBeGreaterThan(60);
  });

  test("supports switching metric modes: Equity ($), Profit ($), and Return (%)", async ({ page }) => {
    await seedPortfolioWith50PctGain(page);

    const chartPanel = page.locator("#equityChartPanel");

    // 1. Switch to Profit ($) mode
    await page.click('[data-cmode="profit"]');
    await expect(page.locator('[data-cmode="profit"]')).toHaveClass(/active/);
    await expect(chartPanel.locator(".bignum")).toHaveText("+$500.00");
    await expect(chartPanel).toContainText("+50.00% return");
    await expect(chartPanel).toContainText("Net Profit");
    await expect(chartPanel).toContainText("Zero baseline");

    // 2. Switch to Return (%) mode
    await page.click('[data-cmode="return"]');
    await expect(page.locator('[data-cmode="return"]')).toHaveClass(/active/);
    await expect(chartPanel.locator(".bignum")).toHaveText("+50.00%");
    await expect(chartPanel).toContainText("+$500.00 P/L");
    await expect(chartPanel).toContainText("Return %");
    await expect(chartPanel).toContainText("Zero baseline");

    // 3. Switch back to Equity ($) mode
    await page.click('[data-cmode="equity"]');
    await expect(page.locator('[data-cmode="equity"]')).toHaveClass(/active/);
    await expect(chartPanel.locator(".bignum")).toHaveText("$1,500.00");
  });

  test("supports timeframe switching across 24H, 7D, 30D, 90D, 1Y, and ALL", async ({ page }) => {
    await seedPortfolioWith50PctGain(page);

    const tfBar = page.locator("#chartTfBar");

    // Test clicking 24H
    await tfBar.locator('[data-chart-range="24h"]').click();
    await expect(tfBar.locator('[data-chart-range="24h"]')).toHaveClass(/active/);
    await expect(page.locator("#equityChartPanel")).toBeVisible();

    // Test clicking 7D
    await tfBar.locator('[data-chart-range="7d"]').click();
    await expect(tfBar.locator('[data-chart-range="7d"]')).toHaveClass(/active/);
    await expect(page.locator("#equityChartPanel")).toBeVisible();

    // Test clicking 30D
    await tfBar.locator('[data-chart-range="30d"]').click();
    await expect(tfBar.locator('[data-chart-range="30d"]')).toHaveClass(/active/);
    await expect(page.locator("#equityChartPanel")).toBeVisible();

    // Test clicking ALL
    await tfBar.locator('[data-chart-range="all"]').click();
    await expect(tfBar.locator('[data-chart-range="all"]')).toHaveClass(/active/);
    await expect(page.locator("#equityChartPanel")).toBeVisible();
  });

  test("supports filtering performance by individual holding", async ({ page }) => {
    const now = Date.now();
    const D = 86400000;
    const buyDate = new Date(now - 10 * D).toISOString();

    await page.evaluate(({ buyDate }) => {
      const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
      s.transactions = [
        { id: "tx-1", type: "DEPOSIT", amount: 5000, date: buyDate },
        { id: "tx-2", type: "BUY", assetId: "crypto:BTC", qty: 0.04, price: 50000, fee: 0, date: buyDate }, // $2000 cost
        { id: "tx-3", type: "BUY", assetId: "crypto:ETH", qty: 1.0, price: 2000, fee: 0, date: buyDate }   // $2000 cost
      ];
      s.assets = s.assets || {};
      s.assets["crypto:BTC"] = { id: "crypto:BTC", type: "crypto", symbol: "BTC", name: "Bitcoin", coingeckoId: "bitcoin" };
      s.assets["crypto:ETH"] = { id: "crypto:ETH", type: "crypto", symbol: "ETH", name: "Ethereum", coingeckoId: "ethereum" };
      s.prices = s.prices || {};
      s.prices["crypto:BTC"] = { price: 80000, updatedAt: new Date().toISOString() }; // $3200 value (+60%)
      s.prices["crypto:ETH"] = { price: 2000, updatedAt: new Date().toISOString() };  // $2000 value (0%)
      s.ui = s.ui || {};
      s.ui.view = "dashboard";
      s.ui.mode = "portfolio";
      s.ui.chartMode = "equity";
      s.ui.chartAsset = "all";
      s.ui.range = { preset: "all", start: null, end: null };
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    }, { buyDate });
    await page.reload();

    const assetSelect = page.locator("#chartAssetSelect");
    await expect(assetSelect).toBeVisible();

    // Filter to BTC only
    await assetSelect.selectOption("crypto:BTC");
    const chartPanel = page.locator("#equityChartPanel");
    await expect(chartPanel.locator(".bignum")).toHaveText("$3,200.00");
    await expect(chartPanel).toContainText("+$1,200.00 (+60.00%)");

    // Filter to ETH only
    await assetSelect.selectOption("crypto:ETH");
    await expect(chartPanel.locator(".bignum")).toHaveText("$2,000.00");
    await expect(chartPanel).toContainText("+$0.00 (+0.00%)");

    // Filter back to Entire Portfolio
    await assetSelect.selectOption("all");
    // Cash = $1000, BTC = $3200, ETH = $2000 => total equity = $6200
    await expect(chartPanel.locator(".bignum")).toHaveText("$6,200.00");
  });

  test("interactive hover crosshair, dot and tooltip work on the chart", async ({ page }) => {
    await seedPortfolioWith50PctGain(page);

    const chart = page.locator("#eqChart");
    await expect(chart).toBeVisible();

    const cross = page.locator("#eqCross");
    const dot = page.locator("#eqDot");
    const tip = page.locator("#eqTip");

    // Hover over center of chart
    const box = await chart.boundingBox();
    expect(box).toBeTruthy();
    await chart.dispatchEvent("mousemove", { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });

    await expect(cross).toBeVisible();
    await expect(dot).toBeVisible();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("equity");

    // Moving mouse out hides crosshair and tooltip
    await chart.dispatchEvent("mouseleave");
    await expect(cross).toBeHidden();
    await expect(dot).toBeHidden();
    await expect(tip).toBeHidden();
  });
});
