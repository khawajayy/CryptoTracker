const { test, expect } = require("@playwright/test");
const LE = require("../../js/ledger-engine.js");

const D = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 0, 1);

function stateWith(transactions, extra = {}) {
  return Object.assign({ transactions, assets: {}, prices: {}, priceHistory: {} }, extra);
}

test.describe("LedgerEngine - accounting", () => {
  test("Intel -> Sandisk chain keeps realized loss and measures against original capital", () => {
    const s = stateWith([
      { id: "1", type: "DEPOSIT", amount: 3000, date: iso(T0) },
      { id: "2", type: "BUY", assetId: "stock:INTC", qty: 100, price: 30, fee: 0, date: iso(T0 + D) },
      { id: "3", type: "SELL", assetId: "stock:INTC", qty: 100, price: 25, fee: 0, date: iso(T0 + 2 * D) },
      { id: "4", type: "BUY", assetId: "stock:SNDK", qty: 50, price: 50, fee: 0, date: iso(T0 + 3 * D) },
    ], { prices: { "stock:SNDK": { price: 60 } } });
    const p = LE.summarize(s);
    expect(p.netCapital).toBe(3000);
    expect(p.realized).toBe(-500);
    expect(p.cash).toBe(0);
    expect(p.equity).toBe(3000);
    expect(p.totalReturn).toBe(0);
    expect(p.holdings[0].unrealized).toBe(500);
  });

  test("fees are capitalized into basis and reduce sale proceeds", () => {
    const s = stateWith([
      { id: "1", type: "DEPOSIT", amount: 1000, date: iso(T0) },
      { id: "2", type: "BUY", assetId: "a", qty: 10, price: 50, fee: 5, date: iso(T0 + 1) },
      { id: "3", type: "SELL", assetId: "a", qty: 5, price: 60, fee: 2, date: iso(T0 + 2) },
    ]);
    const p = LE.summarize(s);
    expect(p.cash).toBeCloseTo(1000 - 505 + 298, 9);
    expect(p.realized).toBeCloseTo(298 - 252.5, 9);
    expect(p.feesPaid).toBe(7);
    expect(p.positions.a.costBasis).toBeCloseTo(252.5, 9);
  });

  test("orders same-timestamp transactions by _seq", () => {
    const d = iso(T0);
    const s = stateWith([
      { id: "b", type: "BUY", assetId: "a", qty: 1, price: 100, date: d, _seq: 1 },
      { id: "a", type: "DEPOSIT", amount: 100, date: d, _seq: 0 },
      { id: "c", type: "SELL", assetId: "a", qty: 1, price: 150, date: d, _seq: 2 },
    ]);
    expect(LE.realizedBySell(s.transactions).c).toBe(50);
  });

  test("asset adjustments add at zero cost and remove at average cost", () => {
    const s = stateWith([
      { id: "1", type: "DEPOSIT", amount: 100, date: iso(T0) },
      { id: "2", type: "BUY", assetId: "a", qty: 10, price: 10, date: iso(T0 + 1) },
      { id: "3", type: "ADJUST", target: "asset", assetId: "a", qtyDelta: 10, date: iso(T0 + 2) },
      { id: "4", type: "ADJUST", target: "asset", assetId: "a", qtyDelta: -5, date: iso(T0 + 3) },
    ]);
    const pos = LE.summarize(s).positions.a;
    expect(pos.qty).toBe(15);
    expect(pos.costBasis).toBeCloseTo(75, 9);
  });

  test("excludeId replays the ledger without the transaction being edited", () => {
    const s = stateWith([
      { id: "1", type: "DEPOSIT", amount: 100, date: iso(T0) },
      { id: "2", type: "WITHDRAW", amount: 40, date: iso(T0 + 1) },
    ]);
    expect(LE.summarize(s).cash).toBe(60);
    expect(LE.summarize(s, "2").cash).toBe(100);
  });
});

test.describe("LedgerEngine - valuation", () => {
  test("interpolate uses binary search with linear interpolation and clamps at the ends", () => {
    const pts = [{ t: 0, p: 10 }, { t: 10, p: 20 }, { t: 20, p: 40 }];
    expect(LE.interpolate(pts, -5)).toBe(10);
    expect(LE.interpolate(pts, 5)).toBe(15);
    expect(LE.interpolate(pts, 15)).toBe(30);
    expect(LE.interpolate(pts, 99)).toBe(40);
  });

  test("valueSeries matches independent point-in-time replays", () => {
    const txns = [
      { id: "1", type: "DEPOSIT", amount: 1000, date: iso(T0) },
      { id: "2", type: "BUY", assetId: "a", qty: 10, price: 50, date: iso(T0 + D) },
      { id: "3", type: "DEPOSIT", amount: 500, date: iso(T0 + 3 * D) },
      { id: "4", type: "SELL", assetId: "a", qty: 5, price: 80, date: iso(T0 + 5 * D) },
    ];
    const ctx = { transactions: txns, prices: {}, now: T0 + 10 * D,
      priceHistory: { a: { points: [{ t: T0, p: 50 }, { t: T0 + 10 * D, p: 100 }] } } };
    const times = [T0 + 9 * D, T0 + 2 * D, T0 + 4 * D, T0 + 6 * D];
    const series = LE.valueSeries(ctx, times, "all");
    expect(series.map((x) => x.t)).toEqual([...times].sort((a, b) => a - b));
    for (const pt of series) {
      const book = LE.replay(txns.filter((t) => new Date(t.date).getTime() <= pt.t));
      const held = book.pos.a ? book.pos.a.qty : 0;
      expect(pt.value).toBeCloseTo(book.cash + held * LE.interpolate(ctx.priceHistory.a.points, pt.t), 6);
      expect(pt.netCapital).toBe(book.deposits - book.withdrawals);
    }
  });

  test("equitySeries is empty for an empty ledger and pins the last point to live equity", () => {
    const R = { startTs: -Infinity, endTs: T0 + 5 * D, isAll: true };
    expect(LE.equitySeries({ transactions: [], prices: {}, priceHistory: {}, now: T0 }, R, "all", 0, [])).toEqual([]);
    const ctx = { transactions: [{ id: "1", type: "DEPOSIT", amount: 100, date: iso(T0) }], prices: {}, priceHistory: {}, now: T0 + 5 * D };
    const s = LE.equitySeries(ctx, R, "all", 123.456, []);
    expect(s.length).toBeGreaterThan(2);
    expect(s[s.length - 1].v).toBe(123.46);
    expect(s[s.length - 1].profit).toBe(23.46);
  });

  test("rangeStats counts only in-window activity but uses full-history cost basis", () => {
    const txns = [
      { id: "1", type: "DEPOSIT", amount: 1000, date: iso(T0) },
      { id: "2", type: "BUY", assetId: "a", qty: 10, price: 50, fee: 1, date: iso(T0 + D) },
      { id: "3", type: "SELL", assetId: "a", qty: 10, price: 60, fee: 2, date: iso(T0 + 10 * D) },
    ];
    const ctx = { transactions: txns, prices: {}, priceHistory: {}, now: T0 + 20 * D };
    const r = LE.rangeStats(ctx, { startTs: T0 + 5 * D, endTs: T0 + 20 * D });
    expect(r.depositsP).toBe(0);
    expect(r.sellsP).toBe(1);
    expect(r.feesP).toBe(2);
    expect(r.realizedP).toBeCloseTo(598 - 501, 9);
  });
});

test.describe("LedgerEngine - validation", () => {
  test("safeUrl only allows absolute http(s) URLs", () => {
    expect(LE.safeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(LE.safeUrl("javascript:alert(1)")).toBe("");
    expect(LE.safeUrl("JaVaScRiPt:alert(1)")).toBe("");
    expect(LE.safeUrl("data:text/html,<script>")).toBe("");
    expect(LE.safeUrl("/relative")).toBe("");
    expect(LE.safeUrl(null)).toBe("");
  });

  test("sanitizeTransactions drops malformed rows and prototype-polluting ids", () => {
    const { transactions, dropped } = LE.sanitizeTransactions([
      { id: "ok", type: "DEPOSIT", amount: 10, date: iso(T0) },
      { id: "neg", type: "DEPOSIT", amount: -10, date: iso(T0) },
      { id: "str", type: "DEPOSIT", amount: "10", date: iso(T0) },
      { id: "inf", type: "BUY", assetId: "a", qty: Infinity, price: 1, date: iso(T0) },
      { id: "proto", type: "BUY", assetId: "__proto__", qty: 1, price: 1, date: iso(T0) },
      { id: "date", type: "DEPOSIT", amount: 10, date: "not a date" },
      { id: "type", type: "STEAL", amount: 10, date: iso(T0) },
      null,
      { id: "ok", type: "WITHDRAW", amount: 5, date: iso(T0), note: "x".repeat(900), evil: "<script>" },
    ]);
    expect(dropped).toBe(7);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].id).toBe("ok");
    expect(transactions[1].id).not.toBe("ok");            // duplicate id re-keyed
    expect(transactions[1].note).toHaveLength(500);
    expect(transactions[1]).not.toHaveProperty("evil");
  });

  test("replaying hostile asset ids never pollutes Object.prototype", () => {
    LE.replay([{ id: "x", type: "BUY", assetId: "__proto__", qty: 1, price: 1, date: iso(T0) }]);
    expect(({}).qty).toBeUndefined();
    expect(LE.sanitizeAssets(JSON.parse('{"__proto__":{"id":"__proto__","type":"crypto","symbol":"X"}}'))).toEqual({});
  });

  test("sanitizeAsset strips unsafe image URLs and bad CoinGecko ids", () => {
    const a = LE.sanitizeAsset({ id: "crypto:X", type: "crypto", symbol: "X", name: "n", coingeckoId: "../../x?y", img: "javascript:alert(1)" });
    expect(a.img).toBeNull();
    expect(a.coingeckoId).toBeNull();
    expect(LE.sanitizeAsset({ id: "crypto:X", type: "nft", symbol: "X" })).toBeNull();
  });

  test("sanitizeSettings keeps only known values", () => {
    const d = { finnhubKey: "", autoRefreshSec: 0, secondaryCurrency: "PKR", manualRate: null };
    const s = LE.sanitizeSettings({ finnhubKey: " abc\n123 ", autoRefreshSec: 1, secondaryCurrency: "<b>", manualRate: -3, extra: 1 }, d);
    expect(s).toEqual({ finnhubKey: "abc123", autoRefreshSec: 0, secondaryCurrency: "PKR", manualRate: null });
  });

  test("sanitizeUi falls back to defaults for unknown values", () => {
    const u = LE.sanitizeUi({ view: "<img>", mode: "goal", theme: "dark", range: { preset: "custom", start: "2026-01-01", end: "x" }, chartAsset: "__proto__" });
    expect(u.view).toBe("dashboard");
    expect(u.mode).toBe("goal");
    expect(u.range).toEqual({ preset: "custom", start: "2026-01-01", end: null });
    expect(u.chartAsset).toBe("all");
  });
});
