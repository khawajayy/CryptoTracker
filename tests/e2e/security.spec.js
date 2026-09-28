// Security regression tests: hostile data from APIs, imports or the cloud must
// render as text, never run, and the production CSP must not break the app.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { openFreshApp, mockNetwork, deposit, tradeStock } = require("./helpers");

const XSS = `"><img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;

// Merge a patch into the stored state and reload the app.
async function seed(page, patch) {
  await page.evaluate((patch) => {
    const s = JSON.parse(localStorage.getItem("cryptoledger.v1") || "{}");
    localStorage.setItem("cryptoledger.v1", JSON.stringify(Object.assign(s, patch)));
  }, patch);
  await page.reload();
}

test.describe("Security", () => {
  test.beforeEach(async ({ page }) => {
    await openFreshApp(page);
  });

  test("hostile asset names, notes and ids render as inert text everywhere", async ({ page }) => {
    await page.evaluate((xss) => {
      const d = new Date(Date.now() - 86400000).toISOString();
      const s = {
        transactions: [
          { id: "t1", type: "DEPOSIT", amount: 1000, date: d, note: xss },
          { id: `t2${xss}`, type: "BUY", assetId: "crypto:EVIL", qty: 1, price: 100, fee: 0, date: d, note: xss },
        ],
        assets: { "crypto:EVIL": { id: "crypto:EVIL", type: "crypto", symbol: xss.slice(0, 30), name: xss, coingeckoId: "evil", img: "javascript:window.__xss=3" } },
        favorites: [{ id: "stock:EV'IL", type: "stock", symbol: "EV'IL", name: xss, coingeckoId: null, img: null }],
        goals: [{ id: `g${xss}`, name: xss, target: 5000, profitPct: 10 }],
        ui: { view: "dashboard", mode: "portfolio" },
      };
      localStorage.setItem("cryptoledger.v1", JSON.stringify(s));
    }, XSS);
    await page.reload();

    for (const view of ["dashboard", "holdings", "watchlist", "news", "ledger"]) {
      await page.click(`.tab[data-view="${view}"]`);
      await expect(page.locator(".tab.active")).toHaveAttribute("data-view", view);
    }
    await page.click('#modeSeg button[data-mode="goal"]');
    await expect(page.locator("#view")).toContainText("onerror");   // shown as text
    await page.click('#modeSeg button[data-mode="portfolio"]');
    await page.click('.tab[data-view="dashboard"]');

    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator("#view script")).toHaveCount(0);
    await expect(page.locator('img[src^="javascript"]')).toHaveCount(0);
  });

  test("prototype-polluting asset ids are dropped on load", async ({ page }) => {
    const d = new Date().toISOString();
    await seed(page, {
      transactions: [
        { id: "t1", type: "DEPOSIT", amount: 100, date: d },
        { id: "t2", type: "BUY", assetId: "__proto__", qty: 5, price: 1, fee: 0, date: d },
      ],
    });
    expect(await page.evaluate(() => ({}).qty)).toBeUndefined();
    await page.click('.tab[data-view="ledger"]');
    await expect(page.locator("#view tbody tr")).toHaveCount(1);
  });

  test("news with javascript: links or images is not rendered as clickable/loadable", async ({ page }) => {
    await page.route("**/company-news**", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([
        { id: 1, headline: "Bad link story", url: "javascript:window.__xss=4", datetime: Math.floor(Date.now() / 1000) },
        { id: 2, headline: "Good story", url: "https://example.com/ok", image: "javascript:window.__xss=5", source: "Wire", datetime: Math.floor(Date.now() / 1000) },
      ]),
    }));
    await seed(page, {
      settings: { finnhubKey: "k" },
      favorites: [{ id: "stock:AMD", type: "stock", symbol: "AMD", name: "AMD", coingeckoId: null, img: null }],
    });
    await page.click('.tab[data-view="news"]');
    await expect(page.locator(".news-card-title")).toHaveText(["Good story"]);
    await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
    await expect(page.locator(".news-card img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test("placeholder news is labelled and never impersonates real outlets", async ({ page }) => {
    await seed(page, {
      favorites: [{ id: "stock:AAPL", type: "stock", symbol: "AAPL", name: "Apple", coingeckoId: null, img: null }],
    });
    await page.click('.tab[data-view="news"]');
    await expect(page.locator(".news-source")).toHaveText(["CryptoLedger"]);
    await expect(page.locator("#newsGrid")).not.toContainText(/Reuters|Bloomberg|CNBC|MarketWatch/);
  });

  test("import validates the file and skips invalid rows", async ({ page }) => {
    const file = {
      name: "backup.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({
        transactions: [
          { id: "a", type: "DEPOSIT", amount: 250, date: new Date().toISOString() },
          { id: "b", type: "DEPOSIT", amount: "lots", date: new Date().toISOString() },
          { id: "c", type: "BUY", assetId: "__proto__", qty: 1, price: 1, date: new Date().toISOString() },
        ],
      })),
    };
    page.on("dialog", (d) => d.accept());
    await page.click('.tab[data-view="ledger"]');
    const chooser = page.waitForEvent("filechooser");
    await page.click("#importBtn");
    await (await chooser).setFiles(file);
    await expect(page.locator("#toast")).toContainText("skipped 2 invalid");
    await expect(page.locator("#view tbody tr")).toHaveCount(1);
  });

  test("the production Content-Security-Policy allows the app to work with no violations", async ({ page }) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../firebase.json"), "utf8"));
    const all = cfg.hosting.headers.find((h) => h.source === "**").headers;
    // upgrade-insecure-requests would rewrite http://localhost to https in the test server; it's a no-op on Firebase (https only).
    const csp = all.find((h) => h.key === "Content-Security-Policy").value.replace(/;\s*upgrade-insecure-requests/, "");

    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.route((url) => url.pathname === "/" || url.pathname.endsWith(".html"), async (route) => {
      const resp = await route.fetch();
      await route.fulfill({ response: resp, headers: { ...resp.headers(), "content-security-policy": csp } });
    });
    await mockNetwork(page);
    await page.goto("/");

    await deposit(page, 1000);
    await tradeStock(page, "BUY", { symbol: "INTC", qty: 10, price: 20 });
    for (const view of ["holdings", "watchlist", "news", "ledger", "settings", "dashboard"]) {
      await page.click(`.tab[data-view="${view}"]`);
    }
    await page.click('#modeSeg button[data-mode="goal"]');
    await page.click("#goalAdd");
    await expect(page.locator("#gfSave")).toBeVisible();

    expect(await page.evaluate(() => window.__csp)).toEqual([]);
  });
});
