/**
 * ledger-engine.js
 * Pure accounting + validation for CryptoLedger. No DOM access, so it runs in
 * the browser (window.LedgerEngine) and in Node (CommonJS) for unit tests.
 *
 * Accounting: cash-balance model with average-cost basis.
 *   Net Capital  = deposits - withdrawals
 *   Equity       = cash + market value of holdings
 *   Total Return = Equity - Net Capital
 */
(function (root, factory) {
  if (typeof exports === "object" && typeof module !== "undefined") module.exports = factory();
  else root.LedgerEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EPS = 1e-9;
  const TX_TYPES = ["DEPOSIT", "WITHDRAW", "BUY", "SELL", "ADJUST"];
  const ASSET_TYPES = ["crypto", "stock"];
  const MAX_NOTE = 500;
  const MAX_NAME = 120;
  const MAX_TXNS = 50000;
  const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  /* ---------- small validators ---------- */
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const posNum = (v) => isNum(v) && v > 0;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  // Ids are used as object keys and (escaped) HTML attribute values: bounded
  // length, no control characters, and never a prototype-polluting name.
  // eslint-disable-next-line no-control-regex
  const SAFE_ID = /^[^\x00-\x1f\x7f]{1,120}$/;
  const isSafeId = (v) => typeof v === "string" && SAFE_ID.test(v) && !RESERVED_KEYS.has(v);
  const COINGECKO_ID = /^[A-Za-z0-9._-]{1,100}$/;
  const dict = () => Object.create(null);

  function makeId() {
    const c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "").slice(0, 16);
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
  }

  /** Returns the URL if it is absolute http(s), otherwise "". Blocks javascript:, data:, etc. */
  function safeUrl(u) {
    if (typeof u !== "string" || u.length > 2048) return "";
    try {
      const p = new URL(u);
      return p.protocol === "https:" || p.protocol === "http:" ? p.href : "";
    } catch (e) {
      return "";
    }
  }

  function toIsoDate(v) {
    if (typeof v !== "string" && !isNum(v)) return null;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  /* ---------- sanitizers (for localStorage, imported files, cloud docs) ---------- */
  function sanitizeAsset(a) {
    if (!a || typeof a !== "object" || !isSafeId(a.id)) return null;
    const type = ASSET_TYPES.includes(a.type) ? a.type : null;
    if (!type) return null;
    const symbol = str(a.symbol, 32).trim();
    if (!symbol) return null;
    return {
      id: a.id,
      type,
      symbol,
      name: str(a.name, MAX_NAME),
      coingeckoId: typeof a.coingeckoId === "string" && COINGECKO_ID.test(a.coingeckoId) ? a.coingeckoId : null,
      img: safeUrl(a.img) || null,
    };
  }

  function sanitizeTransaction(t, index) {
    if (!t || typeof t !== "object" || !TX_TYPES.includes(t.type)) return null;
    const date = toIsoDate(t.date);
    if (!date) return null;
    const out = {
      id: isSafeId(t.id) ? t.id : makeId(),
      type: t.type,
      date,
      note: str(t.note, MAX_NOTE),
      _seq: isNum(t._seq) ? t._seq : index,
    };
    if (t.type === "DEPOSIT" || t.type === "WITHDRAW") {
      if (!posNum(t.amount)) return null;
      out.amount = t.amount;
    } else if (t.type === "BUY" || t.type === "SELL") {
      if (!isSafeId(t.assetId) || !posNum(t.qty) || !posNum(t.price)) return null;
      out.assetId = t.assetId;
      out.qty = t.qty;
      out.price = t.price;
      out.fee = isNum(t.fee) && t.fee > 0 ? t.fee : 0;
    } else {
      if (t.target === "cash") {
        if (!isNum(t.delta) || t.delta === 0) return null;
        out.target = "cash";
        out.delta = t.delta;
      } else {
        if (!isSafeId(t.assetId) || !isNum(t.qtyDelta) || t.qtyDelta === 0) return null;
        out.target = "asset";
        out.assetId = t.assetId;
        out.qtyDelta = t.qtyDelta;
      }
    }
    return out;
  }

  function sanitizeTransactions(list) {
    const src = Array.isArray(list) ? list.slice(0, MAX_TXNS) : [];
    const out = [];
    const seen = new Set();
    let dropped = Array.isArray(list) ? Math.max(0, list.length - MAX_TXNS) : 0;
    src.forEach((t, i) => {
      const c = sanitizeTransaction(t, i);
      if (!c) { dropped++; return; }
      while (seen.has(c.id)) c.id = makeId();
      seen.add(c.id);
      out.push(c);
    });
    return { transactions: out, dropped };
  }

  function sanitizeAssets(obj) {
    const out = dict();
    if (!obj || typeof obj !== "object") return out;
    for (const k of Object.keys(obj)) {
      const a = sanitizeAsset(obj[k]);
      if (a && a.id === k) out[k] = a;
    }
    return out;
  }

  function sanitizeFavorites(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.map(sanitizeAsset).filter((a) => a && !seen.has(a.id) && seen.add(a.id));
  }

  function sanitizeSettings(s, defaults) {
    const o = Object.assign({}, defaults);
    if (!s || typeof s !== "object") return o;
    if (typeof s.finnhubKey === "string") o.finnhubKey = s.finnhubKey.trim().replace(/[^\x21-\x7E]/g, "").slice(0, 128);
    if ([0, 30, 60, 300].includes(s.autoRefreshSec)) o.autoRefreshSec = s.autoRefreshSec;
    if (typeof s.secondaryCurrency === "string" && /^[A-Z]{3}$/.test(s.secondaryCurrency)) o.secondaryCurrency = s.secondaryCurrency;
    o.manualRate = posNum(s.manualRate) ? s.manualRate : null;
    return o;
  }

  function sanitizeGoals(list, legacyGoal) {
    let goals = Array.isArray(list) ? list : [];
    // migrate the old single-goal shape ({target,profitPct}) into the list
    if (!goals.length && legacyGoal && posNum(legacyGoal.target)) {
      goals = [{ id: legacyGoal.id, name: "Goal", target: legacyGoal.target, profitPct: legacyGoal.profitPct || 10 }];
    }
    return goals.filter((g) => g && typeof g === "object").slice(0, 200).map((g) => {
      const isStepUp = g.type === "stepup";
      const steps = Array.isArray(g.steps) && g.steps.length
        ? g.steps.slice(0, 50).map((st) => ({ target: Number(st && st.target) || 0, profitPct: Number(st && st.profitPct) || 0 }))
        : (isStepUp ? [{ target: Number(g.target) || 10000, profitPct: Number(g.profitPct) || 10 }] : []);
      const start = Number(g.startAmount);
      return {
        id: isSafeId(g.id) ? g.id : makeId(),
        name: str(g.name, MAX_NAME) || (isStepUp ? "Step-Up Goal" : "Goal"),
        type: isStepUp ? "stepup" : "fixed",
        target: Number(g.target) || 0,
        profitPct: Number(g.profitPct) || 10,
        startAmount: g.startAmount != null && Number.isFinite(start) ? start : null,
        steps,
      };
    });
  }

  function sanitizePrices(obj) {
    const out = dict();
    if (!obj || typeof obj !== "object") return out;
    for (const k of Object.keys(obj)) {
      const p = obj[k];
      if (isSafeId(k) && p && posNum(p.price)) out[k] = { price: p.price, updatedAt: toIsoDate(p.updatedAt) || new Date().toISOString() };
    }
    return out;
  }

  function sanitizePriceHistory(obj) {
    const out = dict();
    if (!obj || typeof obj !== "object") return out;
    for (const k of Object.keys(obj)) {
      const h = obj[k];
      if (!isSafeId(k) || !h || !Array.isArray(h.points)) continue;
      const points = h.points.filter((pt) => pt && isNum(pt.t) && isNum(pt.p)).sort((a, b) => a.t - b.t);
      out[k] = { points, days: isNum(h.days) ? h.days : 0, updatedAt: isNum(h.updatedAt) ? h.updatedAt : 0 };
    }
    return out;
  }

  function sanitizeEquityHistory(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((s) => s && isNum(s.t) && isNum(s.v)).slice(-1000);
  }

  const VIEWS = ["dashboard", "holdings", "watchlist", "news", "ledger", "settings"];
  const RANGES = ["all", "ytd", "24h", "7d", "30d", "90d", "1y", "custom"];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  function sanitizeUi(u) {
    const o = { view: "dashboard", mode: "portfolio", theme: "light", range: { preset: "all", start: null, end: null }, chartMode: "equity", chartAsset: "all", chart: { netcap: true } };
    if (!u || typeof u !== "object") return o;
    if (VIEWS.includes(u.view)) o.view = u.view;
    if (u.mode === "goal") o.mode = "goal";
    if (u.theme === "dark") o.theme = "dark";
    if (["equity", "profit", "return"].includes(u.chartMode)) o.chartMode = u.chartMode;
    if (u.chartAsset === "all" || isSafeId(u.chartAsset)) o.chartAsset = u.chartAsset;
    if (u.chart && u.chart.netcap === false) o.chart.netcap = false;
    const r = u.range;
    if (r && typeof r === "object") {
      if (RANGES.includes(r.preset)) o.range.preset = r.preset;
      if (typeof r.start === "string" && DAY.test(r.start)) o.range.start = r.start;
      if (typeof r.end === "string" && DAY.test(r.end)) o.range.end = r.end;
    }
    return o;
  }

  /* ---------- ledger replay (the one place the accounting rules live) ---------- */
  const txTime = (t) => new Date(t.date).getTime();

  function sortChrono(txns) {
    return txns
      .map((t) => ({ t, ms: txTime(t) }))
      .sort((a, b) => (a.ms - b.ms) || ((a.t._seq || 0) - (b.t._seq || 0)))
      .map((x) => x.t);
  }

  function newBook() {
    return { cash: 0, deposits: 0, withdrawals: 0, realized: 0, feesPaid: 0, pos: dict() };
  }

  function position(book, assetId) {
    return book.pos[assetId] || (book.pos[assetId] = { qty: 0, costBasis: 0 });
  }

  function flatten(p) {
    if (p.qty < EPS) { p.qty = 0; p.costBasis = 0; }
  }

  /**
   * Applies one transaction to a book in place. Returns the realized P&L the
   * transaction produced (non-zero only for SELL).
   */
  function applyTxn(book, t) {
    switch (t.type) {
      case "DEPOSIT":
        book.cash += t.amount; book.deposits += t.amount;
        return 0;
      case "WITHDRAW":
        book.cash -= t.amount; book.withdrawals += t.amount;
        return 0;
      case "BUY": {
        const gross = t.qty * t.price, fee = t.fee || 0;
        book.cash -= gross + fee; book.feesPaid += fee;
        const p = position(book, t.assetId);
        p.qty += t.qty; p.costBasis += gross + fee;   // fee capitalized into basis
        p.lastPrice = t.price; p.lastTime = txTime(t);
        return 0;
      }
      case "SELL": {
        const gross = t.qty * t.price, fee = t.fee || 0;
        book.cash += gross - fee; book.feesPaid += fee;
        const p = position(book, t.assetId);
        const avg = p.qty > 0 ? p.costBasis / p.qty : 0;
        const basisSold = avg * t.qty;
        const realized = (gross - fee) - basisSold;
        book.realized += realized;
        p.qty -= t.qty; p.costBasis -= basisSold;
        flatten(p);
        return realized;
      }
      case "ADJUST":
        if (t.target === "cash") { book.cash += t.delta; return 0; }
        {
          const p = position(book, t.assetId);
          if (t.qtyDelta >= 0) {
            p.qty += t.qtyDelta;                      // bonus/airdrop units at $0 cost
          } else {                                    // removed at average cost, no realized P&L
            const rq = Math.min(-t.qtyDelta, p.qty);
            const avg = p.qty > 0 ? p.costBasis / p.qty : 0;
            p.qty -= rq; p.costBasis -= avg * rq;
          }
          flatten(p);
        }
        return 0;
      default:
        return 0;
    }
  }

  /** Replays txns chronologically. onTxn(t, realized, book) is called after each one. */
  function replay(txns, onTxn) {
    const book = newBook();
    for (const t of sortChrono(txns)) {
      const r = applyTxn(book, t);
      if (onTxn) onTxn(t, r, book);
    }
    return book;
  }

  /* ---------- current portfolio summary ---------- */
  function summarize(state, excludeId) {
    const txns = excludeId ? state.transactions.filter((t) => t.id !== excludeId) : state.transactions;
    const book = replay(txns);
    let holdingsValue = 0, holdingsCost = 0, unrealized = 0;
    const holdings = [];
    for (const assetId of Object.keys(book.pos)) {
      const p = book.pos[assetId];
      if (p.qty <= EPS) continue;
      const asset = state.assets[assetId] || { id: assetId, symbol: assetId, type: "?" };
      const pr = state.prices[assetId];
      const live = pr ? pr.price : null;
      const mkt = live != null ? live * p.qty : null;
      const uPnl = mkt != null ? mkt - p.costBasis : null;
      holdingsValue += mkt != null ? mkt : p.costBasis;   // fall back to cost if no price
      holdingsCost += p.costBasis;
      if (uPnl != null) unrealized += uPnl;
      holdings.push({ assetId, asset, qty: p.qty, avgCost: p.costBasis / p.qty, costBasis: p.costBasis, live, marketValue: mkt, unrealized: uPnl, updatedAt: pr ? pr.updatedAt : null });
    }
    holdings.sort((a, b) => (b.marketValue || b.costBasis) - (a.marketValue || a.costBasis));

    const netCapital = book.deposits - book.withdrawals;
    const equity = book.cash + holdingsValue;
    const totalReturn = equity - netCapital;
    const totalReturnPct = netCapital > 0 ? (totalReturn / netCapital) * 100 : 0;

    // Break-even price: the price this asset must reach for equity to equal net
    // capital, with cash and every other position held constant.
    for (const h of holdings) {
      const contrib = h.marketValue != null ? h.marketValue : h.costBasis;
      h.breakevenPrice = h.qty > 0 ? (netCapital - (equity - contrib)) / h.qty : null;
    }

    return {
      cash: book.cash, deposits: book.deposits, withdrawals: book.withdrawals, netCapital,
      realized: book.realized, feesPaid: book.feesPaid, holdings, holdingsValue, holdingsCost,
      unrealized, equity, totalReturn, totalReturnPct, positions: book.pos,
    };
  }

  /** Realized P&L keyed by SELL transaction id (full-history replay). */
  function realizedBySell(txns) {
    const m = dict();
    replay(txns, (t, r) => { if (t.type === "SELL") m[t.id] = r; });
    return m;
  }

  /* ---------- historical valuation ---------- */
  // Binary search over sorted {t,p} points with linear interpolation.
  function interpolate(points, t) {
    const n = points.length;
    if (t <= points[0].t) return points[0].p;
    if (t >= points[n - 1].t) return points[n - 1].p;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi];
    const span = b.t - a.t;
    return span > 0 ? a.p + ((t - a.t) / span) * (b.p - a.p) : a.p;
  }

  // Estimated price of an asset at time t: market history when we have it,
  // otherwise a straight line from the last trade price to today's live price.
  function priceAt(ctx, assetId, t, fallbackPrice, fallbackTime) {
    const h = ctx.priceHistory[assetId];
    if (h && h.points && h.points.length) return interpolate(h.points, t);
    const pr = ctx.prices[assetId];
    const cur = pr ? pr.price : null;
    if (cur != null) {
      const now = ctx.now;
      const st = fallbackTime || t;
      const base = fallbackPrice != null ? fallbackPrice : cur;
      if (t >= now || st >= now) return cur;
      if (t <= st) return base;
      return base + ((t - st) / (now - st)) * (cur - base);
    }
    return fallbackPrice || 0;
  }

  function valueBook(ctx, book, t, filter) {
    let holdingsValue = 0, filteredCost = 0;
    for (const assetId of Object.keys(book.pos)) {
      const p = book.pos[assetId];
      if (p.qty <= EPS) continue;
      if (filter !== "all" && assetId !== filter) continue;
      holdingsValue += p.qty * priceAt(ctx, assetId, t, p.lastPrice, p.lastTime);
      filteredCost += p.costBasis;
    }
    const perAsset = filter !== "all";
    const netCapital = perAsset ? filteredCost : book.deposits - book.withdrawals;
    const value = perAsset ? holdingsValue : book.cash + holdingsValue;
    const profit = value - netCapital;
    return { value, netCapital, profit, returnPct: netCapital > 0 ? (profit / netCapital) * 100 : 0, cash: perAsset ? 0 : book.cash, holdingsValue };
  }

  /**
   * Values the ledger at each timestamp in `times` (any order) with ONE
   * chronological pass over the transactions. Returns results in ascending time.
   */
  function valueSeries(ctx, times, filter) {
    const sorted = sortChrono(ctx.transactions);
    const ts = [...times].sort((a, b) => a - b);
    const book = newBook();
    const out = [];
    let i = 0;
    for (const t of ts) {
      while (i < sorted.length && txTime(sorted[i]) <= t) applyTxn(book, sorted[i++]);
      out.push(Object.assign({ t }, valueBook(ctx, book, t, filter || "all")));
    }
    return out;
  }

  /** Value at a single time; before the first transaction everything is 0. */
  function valueAt(ctx, t, filter) {
    const txns = ctx.transactions;
    if (!txns.length) return { v: 0, netCap: 0, profit: 0, retPct: 0, kind: "book" };
    let first = Infinity;
    for (const x of txns) first = Math.min(first, txTime(x));
    if (t < first) return { v: 0, netCap: 0, profit: 0, retPct: 0, kind: "book" };
    const p = valueSeries(ctx, [t], filter)[0];
    return { v: p.value, netCap: p.netCapital, profit: p.profit, retPct: p.returnPct, kind: "live" };
  }

  /**
   * Chart series across [range.startTs, range.endTs]: transaction times,
   * equity snapshots, market-history points and 40 evenly spaced samples.
   */
  function equitySeries(ctx, range, filter, currentEquity, equityHistory) {
    const txns = ctx.transactions;
    if (!txns.length) return [];
    filter = filter || "all";
    let inception = Infinity;
    for (const x of txns) inception = Math.min(inception, txTime(x));
    let startTs = range.startTs;
    let endTs = Math.min(ctx.now, range.endTs);
    if (range.isAll || startTs === -Infinity || startTs < inception) startTs = inception;
    if (endTs <= startTs) endTs = startTs + 3600000;

    const set = new Set([startTs, endTs]);
    const within = (t) => t >= startTs && t <= endTs;
    for (const x of txns) { const t = txTime(x); if (within(t)) set.add(t); }
    if (filter === "all") for (const s of equityHistory || []) if (within(s.t)) set.add(s.t);
    const ids = filter === "all" ? Object.keys(ctx.priceHistory) : [filter];
    for (const id of ids) {
      const h = ctx.priceHistory[id];
      if (h && h.points) for (const pt of h.points) if (within(pt.t)) set.add(pt.t);
    }
    const SAMPLES = 40, step = (endTs - startTs) / SAMPLES;
    for (let k = 1; k < SAMPLES; k++) set.add(Math.round(startTs + k * step));

    const r2 = (n) => +n.toFixed(2);
    const pts = valueSeries(ctx, set, filter).map((p) => ({ t: p.t, v: r2(p.value), nc: r2(p.netCapital), profit: r2(p.profit), retPct: r2(p.returnPct) }));

    if (currentEquity != null && filter === "all" && pts.length) {
      const last = pts[pts.length - 1];
      last.v = r2(currentEquity);
      last.profit = r2(last.v - last.nc);
      last.retPct = last.nc > 0 ? r2((last.profit / last.nc) * 100) : 0;
    }
    return pts;
  }

  /** Period figures for a date range (deposits, realized, fees, return). */
  function rangeStats(ctx, R) {
    let depositsP = 0, withdrawalsP = 0, realizedP = 0, feesP = 0, buysP = 0, sellsP = 0;
    replay(ctx.transactions, (t, realized) => {
      const ms = txTime(t);
      if (ms < R.startTs || ms > R.endTs) return;
      if (t.type === "DEPOSIT") depositsP += t.amount;
      else if (t.type === "WITHDRAW") withdrawalsP += t.amount;
      else if (t.type === "BUY") { feesP += t.fee || 0; buysP++; }
      else if (t.type === "SELL") { realizedP += realized; feesP += t.fee || 0; sellsP++; }
    });
    const s = valueAt(ctx, R.startTs);
    const e = valueAt(ctx, R.endTs);
    const netInvestedP = depositsP - withdrawalsP;
    const periodReturn = e.v - s.v - netInvestedP;
    const base = s.v + Math.max(0, depositsP);
    return {
      depositsP, withdrawalsP, netInvestedP, realizedP, feesP, buysP, sellsP,
      equityStart: s.v, equityEnd: e.v, periodReturn,
      periodReturnPct: base > EPS ? (periodReturn / base) * 100 : 0,
      approx: s.kind === "book" && s.v > 0,
    };
  }

  return {
    EPS, TX_TYPES,
    makeId, safeUrl, isSafeId,
    sanitizeAsset, sanitizeTransaction, sanitizeTransactions, sanitizeAssets, sanitizeFavorites,
    sanitizeSettings, sanitizeGoals, sanitizePrices, sanitizePriceHistory, sanitizeEquityHistory, sanitizeUi,
    sortChrono, applyTxn, replay, summarize, realizedBySell,
    interpolate, priceAt, valueSeries, valueAt, equitySeries, rangeStats,
  };
});
