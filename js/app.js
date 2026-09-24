"use strict";
/* =========================================================================
   CryptoLedger — a personal crypto + stocks trade ledger.
   No build step. Data lives in localStorage and optionally syncs to Firebase.
   The accounting rules live in js/ledger-engine.js; this file is the UI.
     Net Capital = deposits - withdrawals          (your original-capital anchor)
     Equity      = cash + market value of holdings  (holdings priced live)
     Total Return= Equity - Net Capital             (P&L vs original capital)
   ========================================================================= */

const LE = LedgerEngine;
const LS_KEY = "cryptoledger.v1";
const EPS = LE.EPS;
const FETCH_TIMEOUT_MS = 12000;
const FX_TTL_MS = 30 * 60 * 1000;

// Escape text before putting it into innerHTML (asset names/symbols come from
// external APIs; notes are user-entered). Prevents HTML/script injection.
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
// An http(s) URL escaped for an attribute, or "" for anything else (javascript:, data:, ...).
const escUrl = (u) => esc(LE.safeUrl(u));

// Comma-aware amount fields (type=text, class="amt"): read with stripNum, format live with formatAmt.
// Returns NaN for anything that isn't a finite number, so `x > 0` checks reject Infinity too.
const stripNum = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };
function fmtAmtStr(v){   // number/string -> "10,000.5" (thousands separators, decimals kept)
  if(v==null || v==="") return "";
  let s=String(v); const neg=/^-/.test(s); s=s.replace(/[^\d.]/g,"");
  const dot=s.indexOf("."); let int=dot>=0?s.slice(0,dot):s; const dec=dot>=0?s.slice(dot+1).replace(/\./g,""):null;
  int=int.replace(/^0+(?=\d)/,""); const intFmt=int.replace(/\B(?=(\d{3})+(?!\d))/g,",");
  return (neg?"-":"")+(intFmt||(dec!=null?"0":""))+(dec!=null?"."+dec:"");
}
function formatAmt(el){   // reformat an .amt input in place, preserving the caret
  const start=el.selectionStart!=null?el.selectionStart:el.value.length;
  const digitsBefore=el.value.slice(0,start).replace(/[^\d]/g,"").length;
  const out=fmtAmtStr(el.value);
  el.value=out;
  let pos=0, seen=0; while(pos<out.length && seen<digitsBefore){ if(/\d/.test(out[pos])) seen++; pos++; }
  try{ el.setSelectionRange(pos,pos); }catch(e){ /* not a text input */ }
}
function setAmt(el, val){ if(el) el.value = (val===""||val==null)?"":fmtAmtStr(val); }
const fmtUSD = (n) => (n<0?"-$":"$") + Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
// Per-unit price formatter: keeps precision for small (sub-cent) prices so cheap
// tokens don't collapse to "$0.00". Used for prices/avg cost, not for USD totals.
function fmtPrice(n){
  const a=Math.abs(n); if(a===0) return "$0.00";
  const sgn=n<0?"-$":"$";
  if(a>=1)    return sgn+a.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  if(a>=0.01) return sgn+a.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4});
  // sub-cent: show 4 significant figures, no scientific notation, trim trailing zeros
  let s=a.toPrecision(4);
  if(s.indexOf("e")>=0){ s=a.toFixed(20); }
  s=s.replace(/(\.\d*?)0+$/,"$1").replace(/\.$/,"");
  return sgn+s;
}
const fmtNum = (n,d=6) => Number(n).toLocaleString(undefined,{maximumFractionDigits:d});
const fmtPct = (n) => (n>=0?"+":"") + n.toFixed(2) + "%";
const uid = LE.makeId;
const cls = (n) => n>0?"pos":(n<0?"neg":"neu");
const sign = (n) => (n>=0?"+":"") ;
const arrow = (n) => n>0 ? '<span class="delta">▲</span>' : (n<0 ? '<span class="delta">▼</span>' : '');
const symOf = (a) => ((a && a.symbol) || "").toUpperCase();

// fetch() with a timeout and an HTTP status check; resolves to parsed JSON.
async function fetchJSON(url){
  const ctl = typeof AbortController!=="undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(()=>ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try{
    const r = await fetch(url, { signal: ctl ? ctl.signal : undefined, credentials: "omit", referrerPolicy: "no-referrer" });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { if(timer) clearTimeout(timer); }
}

/* ---------- state ---------- */
let _lastSyncSig = null;  // signature of last-seen synced data (set after load, below)
let state = load();
let goalEditing = null;   // null | "new" | goalId — controls the goal add/edit form
let goalEditState = null; // transient state while configuring a goal in add/edit form
let lastEquityChart = null;   // scale params for the equity-chart hover

function defaultState(){
  return {
    transactions: [],                 // {id,type,date,note, ... }
    assets: Object.create(null),      // assetId -> {id,type,symbol,name,coingeckoId,img}
    prices: Object.create(null),      // assetId -> {price,updatedAt}
    settings: { finnhubKey:"", autoRefreshSec:0, secondaryCurrency:"PKR", manualRate:null },
    fx: { base:"USD", rates:{}, updatedAt:null },   // USD -> other-currency rates
    goals: [],                                       // [{id,name,type,target,profitPct,startAmount,steps}]
    favorites: [],                                   // watchlist: [{id,type,symbol,name,coingeckoId,img}]
    equityHistory: [],                               // device-local equity snapshots [{t,v}]
    priceHistory: Object.create(null),               // device-local market history: assetId -> {points:[{t,p}], days, updatedAt}
    dataUpdatedAt: 0,                                 // ms of last synced-data change (for newest-wins)
    ui: LE.sanitizeUi(null)
  };
}
// Validates and repairs a state-shaped object from any untrusted source
// (localStorage, an imported backup file, or the cloud). Bad records are dropped.
function normalizeState(s, keepUi){
  if(!s || typeof s!=="object") s = {};
  const d = defaultState();
  const tx = LE.sanitizeTransactions(s.transactions);
  const fx = (s.fx && typeof s.fx==="object" && s.fx.rates && typeof s.fx.rates==="object")
    ? { base:"USD", rates:s.fx.rates, updatedAt: typeof s.fx.updatedAt==="string" ? s.fx.updatedAt : null } : d.fx;
  const merged = {
    transactions: tx.transactions,
    assets: LE.sanitizeAssets(s.assets),
    prices: LE.sanitizePrices(s.prices),
    settings: LE.sanitizeSettings(s.settings, d.settings),
    fx,
    goals: LE.sanitizeGoals(s.goals, s.goal),
    favorites: LE.sanitizeFavorites(s.favorites),
    equityHistory: LE.sanitizeEquityHistory(s.equityHistory),
    priceHistory: LE.sanitizePriceHistory(s.priceHistory),
    dataUpdatedAt: Number.isFinite(s.dataUpdatedAt) ? s.dataUpdatedAt : 0,
    ui: keepUi || LE.sanitizeUi(s.ui)
  };
  // Trades must reference a known asset; recover the minimal record from its id if missing.
  for(const t of merged.transactions){
    if(t.assetId && !merged.assets[t.assetId]){
      const [type, ...rest] = t.assetId.split(":");
      const a = LE.sanitizeAsset({ id:t.assetId, type, symbol:rest.join(":") || t.assetId, name:"" });
      if(a) merged.assets[t.assetId] = a;
    }
  }
  if(tx.dropped) console.warn(`CryptoLedger: dropped ${tx.dropped} invalid transaction(s) while loading data`);
  Object.defineProperty(merged, "_dropped", { value: tx.dropped, enumerable: false });
  return merged;
}
function load(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  }catch(e){ return defaultState(); }
}
function persistLocal(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch(e){ console.warn("CryptoLedger: could not write localStorage", e); }
}
// Signature of ONLY the synced data (excludes fx/prices/ui/equityHistory), so
// opening the app or refreshing prices does not falsely mark this device "newest".
function syncSignature(){
  return JSON.stringify({ t:state.transactions, a:state.assets, s:state.settings, g:state.goals, f:state.favorites });
}
function save(){
  const sig = syncSignature();
  let changed = false;
  if(_lastSyncSig===null){ _lastSyncSig = sig; }                 // baseline
  else if(sig !== _lastSyncSig){ changed = true; state.dataUpdatedAt = Date.now(); _lastSyncSig = sig; }
  persistLocal();
  // only push to the cloud when the synced data actually changed
  if(changed && window.Cloud && window.Cloud.onLocalSave) window.Cloud.onLocalSave();
}
// UI-only changes (tab, theme, chart options): local cache, never a cloud push.
function saveUi(){ persistLocal(); }

/* ---------- cloud sync bridge (used by js/cloud.js) ---------- */
// Default stub so Settings buttons never error before the module loads / when offline.
window.Cloud = window.Cloud || { configured:false, signedIn:false, email:null, status:"",
  signIn:function(){ toast("Cloud sync isn't configured yet", true); }, signOut:function(){}, onLocalSave:null };
// The subset of state that is synced (device-local things like ui & prices stay local).
// JSON round-trip gives Firestore plain objects with no undefined values.
function getCloudPayload(){
  return JSON.parse(JSON.stringify({ transactions:state.transactions, assets:state.assets, settings:state.settings, goals:state.goals, favorites:state.favorites, updatedAt:(state.dataUpdatedAt||Date.now()) }));
}
// Apply a state object arriving from the cloud, preserving this device's view/mode & live prices.
function applyCloudState(remote){
  if(!remote || typeof remote!=="object") return;
  state = normalizeState({
    transactions: remote.transactions,
    assets: remote.assets,
    settings: Object.assign({}, state.settings, remote.settings||{}),
    goals: Array.isArray(remote.goals) ? remote.goals : state.goals,
    goal: remote.goal,   // let normalizeState migrate a legacy single goal if present
    favorites: Array.isArray(remote.favorites) ? remote.favorites : state.favorites,
    equityHistory: state.equityHistory,   // device-local; never overwritten by cloud
    priceHistory: state.priceHistory,
    dataUpdatedAt: Number.isFinite(remote.updatedAt) ? remote.updatedAt : Date.now(),
    fx: state.fx,
    prices: state.prices
  }, state.ui);
  _lastSyncSig = syncSignature();   // loaded cloud data is the new baseline (no echo back)
  persistLocal();   // cache only — do NOT echo back to cloud
  render(); updateFxChip();
}
function bumpDataUpdatedAt(){ state.dataUpdatedAt=Date.now(); _lastSyncSig=syncSignature(); persistLocal(); }
// The only globals js/cloud.js relies on.
window.CloudBridge = Object.freeze({
  getPayload: getCloudPayload,
  getLocalTxnCount: () => state.transactions.length,
  getLocalUpdatedAt: () => state.dataUpdatedAt || 0,
  applyRemote: applyCloudState,
  bumpUpdatedAt: bumpDataUpdatedAt,
  setStatus: (text) => setCloudStatus(text)
});
// Header chip + the Settings cloud panel, refreshed whenever cloud state changes.
function setCloudStatus(text){
  const c = window.Cloud||{}; if(text!=null) c.status=text;
  const el=document.getElementById("cloudStatus");
  if(el){
    el.textContent = c.signedIn ? ("☁ "+(c.status||"synced")) : (c.configured ? "☁ sign in to sync" : "");
    el.style.display = el.textContent ? "" : "none";
  }
  renderCloudBox();
}
function renderCloudBox(){
  const box=document.getElementById("cloudBox"); if(!box) return;
  const c=window.Cloud||{};
  if(!c.configured){
    box.innerHTML=`<div class="warn">Cloud sync isn't set up yet. Add your Firebase config to <code>js/cloud.js</code> and deploy — see the README's "Cloud sync" section. Until then, data stays on this device only.</div>`;
    return;
  }
  if(c.signedIn){
    box.innerHTML=`<div class="flex" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>Signed in as <b>${esc(c.email||"account")}</b><div class="hint" style="margin-top:2px">Status: ${esc(c.status||"synced")} · changes sync automatically across your devices.</div></div>
      <button class="btn sm" id="cloudSignOut">Sign out</button></div>
      <div class="flex" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn sm" id="cloudPush">⭱ Upload this device → cloud</button>
        <button class="btn sm" id="cloudPull">⭳ Load cloud → this device</button>
      </div>
      <div class="hint" style="margin-top:6px">Use these if two devices got out of sync: pick the device with the correct data and Upload, then Load on the other.</div>`;
    const b=box.querySelector("#cloudSignOut"); if(b) b.onclick=()=>window.Cloud.signOut();
    const pu=box.querySelector("#cloudPush"); if(pu) pu.onclick=()=>{ if(confirm("Upload THIS device's data to the cloud, overwriting the cloud copy?")) window.Cloud.forcePush && window.Cloud.forcePush(); };
    const pl=box.querySelector("#cloudPull"); if(pl) pl.onclick=()=>{ if(confirm("Load the cloud copy onto THIS device, replacing what's here?")) window.Cloud.forcePull && window.Cloud.forcePull(); };
  } else {
    box.innerHTML=`<button class="btn primary" id="cloudSignIn">Sign in with Google</button>
      <div class="hint" style="margin-top:8px">Sign in to sync your ledger across all your devices in real time.${c.status?` (${esc(c.status)})`:""}</div>`;
    const b=box.querySelector("#cloudSignIn"); if(b) b.onclick=()=>window.Cloud.signIn();
  }
}

/* ---------- secondary currency (e.g. PKR) ---------- */
function secCode(){ return (state.settings && state.settings.secondaryCurrency) || "PKR"; }
function rateIsManual(){ const m = state.settings && state.settings.manualRate; return typeof m==="number" && m>0; }
function fetchedRate(){ const c = secCode(); return state.fx && state.fx.rates && state.fx.rates[c]!=null ? state.fx.rates[c] : null; }
function secRate(){ return rateIsManual() ? state.settings.manualRate : fetchedRate(); }
// Format a USD amount in the secondary currency (returns "" if no rate yet).
function fmtSec(usd){
  const r = secRate(); if(r==null) return "";
  const code = secCode(), v = usd*r;
  try{ return (v<0?"-":"") + new Intl.NumberFormat(undefined,{style:"currency",currency:code,maximumFractionDigits:0}).format(Math.abs(v)); }
  catch(e){ return (v<0?"-":"") + code + " " + Math.abs(v).toLocaleString(undefined,{maximumFractionDigits:0}); }
}
// A "≈ ₨…" sub-line for a dashboard figure; colored to match a P&L value when asked.
function secLine(usd, colored){
  const r = secRate(); if(r==null) return "";
  return `<div class="sub ${colored?cls(usd):'muted'}" style="opacity:.85">≈ ${fmtSec(usd)}</div>`;
}
// Refreshes the USD -> secondary-currency rate at most every 30 min unless forced.
async function fetchFx(force){
  const last = state.fx && state.fx.updatedAt ? new Date(state.fx.updatedAt).getTime() : 0;
  if(!force && fetchedRate()!=null && Date.now()-last < FX_TTL_MS) return true;
  try{
    const j = await fetchJSON("https://open.er-api.com/v6/latest/USD");
    if(j && j.rates && typeof j.rates==="object" && Number.isFinite(j.rates[secCode()])){
      state.fx = { base:"USD", rates:j.rates, updatedAt:new Date().toISOString() };
      persistLocal(); updateFxChip(); return true;
    }
  }catch(e){ /* offline or rate-limited: keep the cached rate */ }
  return false;
}
function updateFxChip(){
  const el = document.getElementById("fxStatus"); if(!el) return;
  const r = secRate();
  el.textContent = r!=null ? `USD/${secCode()} ${r.toLocaleString(undefined,{maximumFractionDigits:2})}${rateIsManual()?" · manual":""}` : `${secCode()}: no rate`;
}

/* ---------- accounting (see js/ledger-engine.js) ---------- */
// Pass excludeId to ignore one transaction (used while editing it, so balance
// checks reflect the ledger *without* the entry being changed).
function computePortfolio(excludeId){ return LE.summarize(state, excludeId); }
// Context the engine needs for time-based valuation.
function valuationCtx(){
  return { transactions: state.transactions, prices: state.prices, priceHistory: state.priceHistory, now: Date.now() };
}
// list of assets currently held (qty > 0), for the adjust / sell dropdowns
function heldAssets(excludeId){
  const pos = computePortfolio(excludeId).positions;
  return Object.keys(pos).filter(id=>pos[id].qty>EPS).map(id=>state.assets[id]).filter(Boolean);
}

/* ---------- theme ---------- */
function applyTheme(){
  const dark = (state.ui.theme==="dark");
  document.documentElement.setAttribute("data-theme", dark?"dark":"light");
  const b=document.getElementById("themeBtn"); if(b) b.textContent = dark ? "☀" : "☾";
}

/* ---------- rendering ---------- */
const viewEl = document.getElementById("view");
function render(){
  const mode = state.ui.mode || "portfolio";
  if(mode==="goal" && goalEditing) syncGoalEditForm();   // keep unsaved goal-form input across re-renders
  document.querySelectorAll("#modeSeg button").forEach(b=>b.classList.toggle("active", b.dataset.mode===mode));
  document.getElementById("tabs").style.display = mode==="goal" ? "none" : "";
  if(mode==="goal"){ renderGoal(); return; }
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active", t.dataset.view===state.ui.view));
  const v = state.ui.view;
  if(v==="dashboard") renderDashboard();
  else if(v==="holdings") renderHoldings();
  else if(v==="watchlist") renderWatchlist();
  else if(v==="news") renderNews();
  else if(v==="ledger") renderLedger();
  else if(v==="settings") renderSettings();
}

// number of compounding X%-profit trades to grow `from` up to `to`
const tradesToGoal = GoalCalc.tradesToGoal;

// progress-ring SVG at a given size
function ringSVG(progress, reached, size, stroke){
  const R = size/2 - stroke/2 - 2, C = 2*Math.PI*R, off = C*(1-progress/100), c = size/2;
  const color = reached ? "var(--green)" : "url(#gGrad)";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><linearGradient id="gGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3fb950"/><stop offset="100%" stop-color="#2ea043"/></linearGradient></defs>
    <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="var(--chip)" stroke-width="${stroke}"/>
    <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
}

function stepUpGoalCardHTML(g, equity){
  const steps = Array.isArray(g.steps) && g.steps.length ? g.steps : [{ target: g.target || 15000, profitPct: g.profitPct || 10 }];
  const startAmount = g.startAmount > 0 ? g.startAmount : (equity > 0 ? equity : 10000);
  const calc = GoalCalc.calculateStepUpGoal({ startAmount, steps });

  const overallTarget = calc.goalAmount || g.target || steps[steps.length - 1].target;
  const remaining = overallTarget - equity;
  const progress = Math.max(0, Math.min(100, (equity / overallTarget) * 100));
  const reached = equity >= overallTarget - EPS;
  const gainNeededPct = equity > 0 ? (overallTarget / equity - 1) * 100 : null;

  return `<div class="card">
    <div class="flex" style="justify-content:space-between;gap:8px;align-items:flex-start">
      <div>
        <b style="font-size:16px">${esc(g.name || "Step-Up Goal")}</b>
        <div style="margin-top:4px"><span class="tag stepup">Step-Up · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}</span></div>
      </div>
      <span style="white-space:nowrap">
        <button class="iconbtn" data-goaledit="${esc(g.id)}" title="Edit">✎</button>
        <button class="iconbtn" data-goaldel="${esc(g.id)}" title="Delete">🗑</button>
      </span>
    </div>

    <div class="ringcard" style="padding:14px 0 4px">
      <div class="ring sm">${ringSVG(progress, reached, 160, 13)}
        <div class="center">
          <div class="pctbig ${reached ? 'pos' : ''}">${progress.toFixed(0)}%</div>
          <div class="pctsub">of ${fmtUSD(overallTarget)}</div>
        </div>
      </div>
    </div>

    ${reached ? `<div class="reached">🎉 Reached!</div>` : ``}

    <div class="goalstat"><span class="k">Current equity</span><span class="v">${fmtUSD(equity)}</span></div>
    <div class="goalstat"><span class="k">${reached ? 'Surplus over goal' : 'Remaining'}</span>
      <span class="v ${reached ? 'pos' : ''}">${fmtUSD(Math.abs(remaining))}${fmtSec(Math.abs(remaining)) ? `<small>${fmtSec(Math.abs(remaining))}</small>` : ''}</span>
    </div>
    ${!reached && gainNeededPct != null ? `<div class="goalstat"><span class="k">Gain still needed</span><span class="v">${gainNeededPct.toFixed(1)}%</span></div>` : ``}

    <div class="goalstat"><span class="k">Starting balance</span><span class="v">${fmtUSD(calc.initialStartingBalance)}</span></div>
    <div class="goalstat"><span class="k">Total winning trades required</span><span class="v bignum" style="font-size:20px">${calc.totalTrades}</span></div>
    <div class="goalstat"><span class="k">Final ending balance</span>
      <span class="v pos">${fmtUSD(calc.finalBalance)}${fmtSec(calc.finalBalance) ? `<small>${fmtSec(calc.finalBalance)}</small>` : ''}</span>
    </div>
    <div class="goalstat"><span class="k">Total expected profit</span><span class="v pos">+${fmtUSD(calc.totalProfit)}</span></div>
    ${calc.overshootAmount > 0 ? `<div class="goalstat"><span class="k">Surplus after final trade</span><span class="v pos">+${fmtUSD(calc.overshootAmount)}</span></div>` : ``}

    <!-- Step Progression Roadmap -->
    <div class="step-flow">
      <div style="font-weight:700;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Step Progression Roadmap</div>
      ${calc.steps.map((st, idx) => `
        ${idx > 0 ? `<div class="step-arrow">↓</div>` : ''}
        <div class="step-node">
          <div class="st-head">
            <span><b>Step ${st.stepNumber}</b></span>
            <span class="tag">${st.profitPct}% / trade</span>
          </div>
          <div class="st-prog">${fmtUSD(st.startingBalance)} → <b>${fmtUSD(st.endingBalance)}</b></div>
          <div class="st-sub">${st.tradesCount} ${st.tradesCount === 1 ? 'trade' : 'trades'} · Target: ${fmtUSD(st.targetAmount)} · Profit: +${fmtUSD(st.profitGenerated)}</div>
        </div>
      `).join('')}
      <div class="step-arrow">↓</div>
      <div class="step-node" style="border-color:var(--accent);background:var(--panel)">
        <div class="st-head">
          <span style="color:var(--accent);font-weight:700">🎯 Goal Complete</span>
          <span class="pos font-bold">${fmtUSD(calc.finalBalance)}</span>
        </div>
        <div class="st-sub">${calc.totalTrades} total trades · Total profit: +${fmtUSD(calc.totalProfit)}</div>
      </div>
    </div>

    <!-- Trade Progression Table -->
    <div style="margin-top:14px">
      <button class="btn sm" data-toggletable="${esc(g.id)}" data-count="${calc.totalTrades}" style="width:100%;justify-content:center">
        📊 View Trade-by-Trade Breakdown (${calc.totalTrades} trades)
      </button>
      <div id="tt-${esc(g.id)}" style="display:none;margin-top:10px;max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius)">
        <table>
          <thead>
            <tr>
              <th>Trade</th>
              <th>Step</th>
              <th>Profit %</th>
              <th>Start Balance</th>
              <th>Profit</th>
              <th>End Balance</th>
            </tr>
          </thead>
          <tbody>
            ${calc.trades.map(t => {
              if (t.trade === 0) {
                return `<tr data-tradenum="0">
                  <td><b>#0</b></td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td><b>${fmtUSD(t.endingBalance)}</b></td>
                </tr>`;
              }
              const isStepStart = t.isStepStart && t.step > 1;
              const stepObj = calc.steps.find(s => s.stepNumber === t.step);
              return `
                ${isStepStart ? `<tr class="step-divider"><td colspan="6">▶ Step ${t.step} begins (Starts at ${fmtUSD(t.startingBalance)} · Target ${fmtUSD(stepObj ? stepObj.targetAmount : 0)})</td></tr>` : ''}
                <tr data-tradenum="${t.trade}" ${t.isStepStart ? 'style="background:var(--hover)"' : ''}>
                  <td><b>#${t.trade}</b></td>
                  <td><span class="tag">Step ${t.step}</span></td>
                  <td>${t.profitPct}%</td>
                  <td>${fmtUSD(t.startingBalance)}</td>
                  <td class="pos">+${fmtUSD(t.profit)}</td>
                  <td><b>${fmtUSD(t.endingBalance)}</b></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function goalCardHTML(g, equity){
  if(g.type === "stepup"){
    return stepUpGoalCardHTML(g, equity);
  }
  const target=g.target, pct=g.profitPct||10;
  const remaining=target-equity;
  const progress=Math.max(0, Math.min(100, equity/target*100));
  const reached=equity>=target-EPS;
  const gainNeededPct=equity>0 ? (target/equity-1)*100 : null;
  const nTrades=tradesToGoal(equity, target, pct);
  const endAmount = nTrades!=null ? equity*Math.pow(1+pct/100, nTrades) : null;   // where you actually land
  return `<div class="card">
    <div class="flex" style="justify-content:space-between;gap:8px">
      <b style="font-size:16px">${esc(g.name||"Goal")}</b>
      <span style="white-space:nowrap">
        <button class="iconbtn" data-goaledit="${esc(g.id)}" title="Edit">✎</button>
        <button class="iconbtn" data-goaldel="${esc(g.id)}" title="Delete">🗑</button>
      </span>
    </div>
    <div class="ringcard" style="padding:14px 0 4px">
      <div class="ring sm">${ringSVG(progress, reached, 160, 13)}
        <div class="center"><div class="pctbig ${reached?'pos':''}">${progress.toFixed(0)}%</div>
        <div class="pctsub">of ${fmtUSD(target)}</div></div></div>
    </div>
    ${reached ? `<div class="reached">🎉 Reached!</div>` : ``}
    <div class="goalstat"><span class="k">Current equity</span><span class="v">${fmtUSD(equity)}</span></div>
    <div class="goalstat"><span class="k">${reached?'Surplus over goal':'Remaining'}</span>
      <span class="v ${reached?'pos':''}">${fmtUSD(Math.abs(remaining))}${fmtSec(Math.abs(remaining))?`<small>${fmtSec(Math.abs(remaining))}</small>`:''}</span></div>
    ${!reached && gainNeededPct!=null ? `<div class="goalstat"><span class="k">Gain still needed</span><span class="v">${gainNeededPct.toFixed(1)}%</span></div>` : ``}
    ${!reached ? `<div style="text-align:center;margin-top:12px">
        <span class="bignum">${nTrades!=null?`≈ ${nTrades}`:'—'}</span>
        <span class="muted"> ${nTrades===1?'trade':'trades'} at </span>
        <input type="number" data-goalpct="${esc(g.id)}" value="${pct}" step="any" min="0"
          style="width:62px;background:var(--input-bg);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:var(--radius);text-align:right">
        <span class="muted"> % each</span>
        <div class="muted" style="font-size:12px;margin-top:6px">compounding ${pct}% each, reinvested, to reach ${fmtUSD(target)}</div>
      </div>
      <div class="goalstat" style="margin-top:10px"><span class="k">You'd end at (after ${nTrades} ${nTrades===1?'trade':'trades'})</span>
        <span class="v pos">${endAmount!=null?fmtUSD(endAmount):'—'}${endAmount!=null&&fmtSec(endAmount)?`<small>${fmtSec(endAmount)}</small>`:''}</span></div>` : ``}
  </div>`;
}

function syncGoalEditForm(){
  if(!goalEditState) return;
  const nameEl = document.getElementById("gfName");
  if(nameEl) goalEditState.name = nameEl.value;
  const targetEl = document.getElementById("gfTarget");
  if(targetEl) goalEditState.target = stripNum(targetEl.value);
  const pctEl = document.getElementById("gfPct");
  if(pctEl) goalEditState.profitPct = parseFloat(pctEl.value) || 10;
  const startEl = document.getElementById("gfStartAmount");
  if(startEl) goalEditState.startAmount = stripNum(startEl.value);

  const stepRows = document.querySelectorAll(".step-card");
  stepRows.forEach(row => {
    const idx = parseInt(row.dataset.stepidx, 10);
    if(goalEditState.steps && goalEditState.steps[idx]){
      const tInp = row.querySelector(".step-target");
      const pInp = row.querySelector(".step-pct");
      if(tInp) goalEditState.steps[idx].target = stripNum(tInp.value);
      if(pInp) goalEditState.steps[idx].profitPct = parseFloat(pInp.value) || 10;
    }
  });
}

function renderGoal(){
  const p = computePortfolio();
  const equity = p.equity;
  const goals = state.goals || [];

  let html = `<div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
    <div style="font-family:var(--serif);font-size:21px;font-weight:700">🎯 Goals</div>
    <button class="btn primary" id="goalAdd">＋ Add goal</button></div>`;

  if(goalEditing){
    if(!goalEditState || goalEditState.id !== goalEditing){
      const defStart = equity > 0 ? equity : 10000;
      if(goalEditing === "new"){
        goalEditState = {
          id: "new",
          type: "fixed",
          name: "",
          target: "",
          profitPct: 10,
          startAmount: defStart,
          steps: [
            { target: Math.round(defStart * 1.5), profitPct: 20 },
            { target: Math.round(defStart * 10), profitPct: 10 }
          ]
        };
      } else {
        const existing = goals.find(x => x.id === goalEditing);
        const isStepUp = existing && existing.type === "stepup";
        const startAmt = existing && existing.startAmount > 0 ? existing.startAmount : defStart;
        goalEditState = {
          id: goalEditing,
          type: isStepUp ? "stepup" : "fixed",
          name: existing ? (existing.name || "") : "",
          target: existing ? (existing.target || "") : "",
          profitPct: existing ? (existing.profitPct || 10) : 10,
          startAmount: startAmt,
          steps: existing && Array.isArray(existing.steps) && existing.steps.length
            ? JSON.parse(JSON.stringify(existing.steps))
            : [
                { target: existing && existing.target ? existing.target : Math.round(defStart * 1.5), profitPct: 20 },
                { target: (existing && existing.target ? existing.target : Math.round(defStart * 1.5)) * 2, profitPct: 10 }
              ]
        };
      }
    }

    const isStepUp = goalEditState.type === "stepup";
    html += `<div class="panel" style="max-width:540px;margin:0 auto 18px">
      <h2>${goalEditing === "new" ? "New goal" : "Edit goal"}</h2>
      <div style="padding:18px">
        <div class="field">
          <label>Goal Mode</label>
          <div class="seg" id="gfTypeSeg">
            <button type="button" data-gtype="fixed" class="${!isStepUp ? 'active' : ''}">Fixed Profit Goal</button>
            <button type="button" data-gtype="stepup" class="${isStepUp ? 'active' : ''}">Step-Up Goal</button>
          </div>
        </div>

        <div class="field">
          <label>Name</label>
          <input id="gfName" value="${esc(goalEditState.name)}" placeholder="e.g. Milestone 1, Portfolio Growth">
        </div>

        ${!isStepUp ? `
          <div class="field">
            <label>Target value (USD)</label>
            <input id="gfTarget" type="text" inputmode="decimal" class="amt" value="${goalEditState.target ? fmtAmtStr(goalEditState.target) : ""}" placeholder="e.g. 10,000" autocomplete="off">
          </div>
          <div class="field">
            <label>Expected profit per winning trade (%)</label>
            <input id="gfPct" type="number" step="any" min="0.01" value="${goalEditState.profitPct || 10}">
          </div>
        ` : `
          <div class="field">
            <label>Starting balance (USD)</label>
            <div class="flex" style="gap:8px">
              <input id="gfStartAmount" type="text" inputmode="decimal" class="amt" value="${goalEditState.startAmount ? fmtAmtStr(goalEditState.startAmount) : ""}" placeholder="e.g. 10,000" autocomplete="off" style="flex:1">
              <button type="button" class="btn sm" id="gfUseEquity" title="Set starting balance to current equity">Use equity (${fmtUSD(equity)})</button>
            </div>
          </div>

          <div class="hint" style="margin-bottom:14px;padding:8px 12px;background:var(--panel2);border-radius:var(--radius);border:1px solid var(--border)">
            💡 <b>Step-Up Goal:</b> Each step begins from the previous step's <i>actual ending balance</i>. Profit % compounds per trade until that step's target is reached or exceeded. Targets must increase sequentially.
          </div>

          <div style="font-weight:700;font-size:13px;margin-bottom:8px">Configured Steps (${goalEditState.steps.length})</div>
          <div id="gfStepList">
            ${goalEditState.steps.map((st, idx) => `
              <div class="step-card" data-stepidx="${idx}">
                <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:6px">
                  <b>Step ${idx + 1} ${idx === goalEditState.steps.length - 1 ? '<span class="tag" style="margin-left:6px">Overall Goal</span>' : ''}</b>
                  ${goalEditState.steps.length > 1 ? `<button type="button" class="iconbtn" data-delstep="${idx}" title="Remove Step ${idx + 1}" style="color:var(--red)">✕ Remove</button>` : ''}
                </div>
                <div class="row2">
                  <div class="field" style="margin-bottom:0">
                    <label>Target amount (USD)</label>
                    <input type="text" inputmode="decimal" class="amt step-target" data-stepidx="${idx}" value="${st.target ? fmtAmtStr(st.target) : ""}" placeholder="e.g. 15,000" autocomplete="off">
                  </div>
                  <div class="field" style="margin-bottom:0">
                    <label>Profit per trade (%)</label>
                    <input type="number" step="any" min="0.01" class="step-pct" data-stepidx="${idx}" value="${st.profitPct || 10}" placeholder="e.g. 20">
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

          <button type="button" class="btn sm" id="gfAddStep" style="margin-bottom:14px">＋ Add Step</button>
        `}

        <div class="flex" style="gap:10px;margin-top:14px">
          <button class="btn primary" id="gfSave">Save goal</button>
          <button class="btn" id="gfCancel">Cancel</button>
        </div>
      </div>
    </div>`;
  }

  if(!goals.length && !goalEditing){
    html += `<div class="panel">${emptyBlock("🎯","No goals yet","Add a target portfolio value to track progress toward it. Your current equity is "+fmtUSD(equity)+".")}</div>`;
  } else if(goals.length){
    html += `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(290px,1fr))">`
          + [...goals].sort((a,b)=>(a.target||0)-(b.target||0)).map(g=>goalCardHTML(g, equity)).join("") + `</div>`;
  }

  viewEl.innerHTML = html;

  document.getElementById("goalAdd").onclick=()=>{
    goalEditing="new";
    goalEditState=null;
    renderGoal();
  };

  const cancel=document.getElementById("gfCancel");
  if(cancel){
    cancel.onclick=()=>{
      goalEditing=null;
      goalEditState=null;
      renderGoal();
    };
  }

  const typeSeg = document.getElementById("gfTypeSeg");
  if(typeSeg){
    typeSeg.onclick = (e) => {
      const b = e.target.closest("button");
      if(!b) return;
      syncGoalEditForm();
      goalEditState.type = b.dataset.gtype;
      renderGoal();
    };
  }

  const useEqBtn = document.getElementById("gfUseEquity");
  if(useEqBtn){
    useEqBtn.onclick = () => {
      const startInp = document.getElementById("gfStartAmount");
      if(startInp){
        startInp.value = fmtAmtStr(equity > 0 ? equity : 10000);
        formatAmt(startInp);
      }
    };
  }

  const addStepBtn = document.getElementById("gfAddStep");
  if(addStepBtn){
    addStepBtn.onclick = () => {
      syncGoalEditForm();
      const lastStep = goalEditState.steps[goalEditState.steps.length - 1];
      const lastTarget = lastStep ? Number(lastStep.target) || 10000 : 10000;
      const lastPct = lastStep ? Number(lastStep.profitPct) || 10 : 10;
      const nextTarget = Math.round(lastTarget * 1.5);
      const nextPct = lastPct > 5 ? Math.max(1, lastPct - 5) : lastPct;
      goalEditState.steps.push({ target: nextTarget, profitPct: nextPct });
      renderGoal();
    };
  }

  viewEl.querySelectorAll("[data-delstep]").forEach(btn => {
    btn.onclick = () => {
      syncGoalEditForm();
      const idx = parseInt(btn.dataset.delstep, 10);
      if(goalEditState.steps.length > 1){
        goalEditState.steps.splice(idx, 1);
        renderGoal();
      }
    };
  });

  viewEl.querySelectorAll(".amt").forEach(inp => {
    inp.addEventListener("input", () => formatAmt(inp));
  });

  const gfSave=document.getElementById("gfSave");
  if(gfSave){
    gfSave.onclick=()=>{
      syncGoalEditForm();
      const name = (goalEditState.name || "").trim();
      const isStepUp = goalEditState.type === "stepup";

      if(!isStepUp){
        const target = Number(goalEditState.target);
        const pct = Number(goalEditState.profitPct);
        if(!(target > 0)){ toast("Enter a positive target amount", true); return; }
        if(!(pct > 0)){ toast("Enter a positive profit percentage", true); return; }

        if(goalEditing === "new"){
          state.goals.push({ id: uid(), name: name || "Goal", type: "fixed", target, profitPct: pct });
        } else {
          const g = state.goals.find(x => x.id === goalEditing);
          if(g){ g.name = name || "Goal"; g.type = "fixed"; g.target = target; g.profitPct = pct; }
        }
      } else {
        const startAmount = Number(goalEditState.startAmount);
        const steps = (goalEditState.steps || []).map(s => ({
          target: Number(s.target),
          profitPct: Number(s.profitPct)
        }));

        const validation = GoalCalc.validateStepUpGoal({ startAmount, steps });
        if(!validation.valid){
          toast(validation.error, true);
          return;
        }

        const finalTarget = steps[steps.length - 1].target;
        const firstPct = steps[0].profitPct;

        if(goalEditing === "new"){
          state.goals.push({
            id: uid(),
            name: name || "Step-Up Goal",
            type: "stepup",
            startAmount,
            target: finalTarget,
            profitPct: firstPct,
            steps
          });
        } else {
          const g = state.goals.find(x => x.id === goalEditing);
          if(g){
            g.name = name || "Step-Up Goal";
            g.type = "stepup";
            g.startAmount = startAmount;
            g.target = finalTarget;
            g.profitPct = firstPct;
            g.steps = steps;
          }
        }
      }

      goalEditing = null;
      goalEditState = null;
      save();
      render();
      toast("Goal saved");
    };
  }

  viewEl.querySelectorAll("[data-goaledit]").forEach(b=>b.onclick=()=>{
    goalEditing = b.dataset.goaledit;
    goalEditState = null;
    renderGoal();
  });

  viewEl.querySelectorAll("[data-goaldel]").forEach(b=>b.onclick=()=>{
    const g = state.goals.find(x => x.id === b.dataset.goaldel);
    if(confirm(`Delete goal "${g ? g.name : ''}"?`)){
      state.goals = state.goals.filter(x => x.id !== b.dataset.goaldel);
      save();
      render();
      toast("Goal deleted");
    }
  });

  viewEl.querySelectorAll("[data-goalpct]").forEach(inp=>inp.addEventListener("input",()=>{
    const v = parseFloat(inp.value);
    if(v > 0){
      const g = state.goals.find(x => x.id === inp.dataset.goalpct);
      if(g){
        g.profitPct = v;
        save();
        renderGoal();
        const again = viewEl.querySelector(`[data-goalpct="${CSS.escape(g.id)}"]`);
        if(again){
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      }
    }
  }));

  viewEl.querySelectorAll("[data-toggletable]").forEach(b => {
    b.onclick = () => {
      const id = b.dataset.toggletable;
      const tableEl = document.getElementById(`tt-${id}`);
      if(tableEl){
        const isHidden = tableEl.style.display === "none";
        tableEl.style.display = isHidden ? "block" : "none";
        b.textContent = isHidden ? "✕ Hide Trade Progression" : `📊 View Trade-by-Trade Breakdown (${b.dataset.count} trades)`;
      }
    };
  });
}

function renderDashboard(){
  const p = computePortfolio();
  const un = p.unrealized;
  const R = computeRange();
  const isAll = R.isAll;
  // headline return: period return when a range is set, else all-time total return
  const headVal = isAll ? p.totalReturn : R.periodReturn;
  const headLabel = isAll ? "Total return vs original capital" : `Return · ${R.label}`;
  const headSub = isAll
    ? `${fmtPct(p.totalReturnPct)} on ${fmtUSD(p.netCapital)} net capital`
    : `${fmtPct(R.periodReturnPct)} · ${fmtUSD(R.equityStart)} → ${fmtUSD(R.equityEnd)}${R.approx?' <span class="tag" style="border-color:var(--amber);color:var(--amber)">approx</span>':''}`;
  const rz = isAll ? p.realized : R.realizedP;
  const invLabel = isAll ? "Net capital" : `Net invested · ${R.label}`;
  const invVal = isAll ? p.netCapital : R.netInvestedP;
  const invSub = isAll ? `${fmtUSD(p.deposits)} in · ${fmtUSD(p.withdrawals)} out` : `${fmtUSD(R.depositsP)} in · ${fmtUSD(R.withdrawalsP)} out`;
  const feeVal = isAll ? p.feesPaid : R.feesP;
  const tag = isAll ? "" : `<span class="tag" style="font-size:9.5px">${R.label}</span>`;

  viewEl.innerHTML = `
    ${rangeBarHTML()}
    <div class="grid cards" style="margin-bottom:16px">
      <div class="card hero">
        <div>
          <div class="label">${headLabel}</div>
          <div class="big ${cls(headVal)}">${arrow(headVal)}${fmtUSD(Math.abs(headVal))}</div>
          <div class="sub ${cls(headVal)}">${headSub}</div>
          ${secLine(headVal,true)}
        </div>
        <div>
          <div class="label">Current equity</div>
          <div class="value">${fmtUSD(p.equity)}</div>
          <div class="sub muted">cash ${fmtUSD(p.cash)} + holdings ${fmtUSD(p.holdingsValue)}</div>
          ${secLine(p.equity,false)}
        </div>
      </div>
    </div>
    <div class="grid cards">
      <div class="card"><div class="label">${invLabel}</div><div class="value">${fmtUSD(invVal)}</div>
        <div class="sub muted">${invSub}</div>${secLine(invVal,false)}</div>
      <div class="card"><div class="label">Cash available <small class="muted">now</small></div><div class="value ${p.cash<0?'neg':''}">${fmtUSD(p.cash)}</div>
        <div class="sub muted">buying power</div>${secLine(p.cash,false)}</div>
      <div class="card"><div class="label">Holdings value <small class="muted">now</small></div><div class="value">${fmtUSD(p.holdingsValue)}</div>
        <div class="sub muted">cost ${fmtUSD(p.holdingsCost)}</div>${secLine(p.holdingsValue,false)}</div>
      <div class="card"><div class="label">Realized P&L ${isAll?"":tag}</div><div class="value ${cls(rz)}">${arrow(rz)}${fmtUSD(Math.abs(rz))}</div>
        <div class="sub muted">${isAll?"locked-in from sells":`from ${R.sellsP} sell${R.sellsP===1?"":"s"} in range`}</div>${secLine(rz,true)}</div>
      <div class="card"><div class="label">Unrealized P&L <small class="muted">now</small></div><div class="value ${cls(un)}">${arrow(un)}${fmtUSD(Math.abs(un))}</div>
        <div class="sub muted">open positions</div>${secLine(un,true)}</div>
      <div class="card"><div class="label">Fees ${isAll?"paid":tag}</div><div class="value">${fmtUSD(feeVal)}</div>
        <div class="sub muted">${isAll?"total trading fees":"in range"}</div>${secLine(feeVal,false)}</div>
    </div>

    <div class="panel" style="margin-top:18px">
      <h2>Open positions <span class="spacer"></span><span class="muted price-fresh" id="freshHint"></span></h2>
      ${p.holdings.length? holdingsTable(p, true) : emptyBlock("📈","No open positions","Add a Buy transaction to start tracking a holding.")}
    </div>

    <div class="panel" style="margin-top:18px" id="equityChartPanel">
      ${equityChartHTML(p.equity, p.holdings)}
    </div>
  `;
  document.getElementById("freshHint").textContent = freshnessText(p.holdings);
  wireRangeBar();
  wireEquityHover();
  fetchMarketHistoryForAllHeld();
}

/* ---------- equity history + market charts ---------- */
// Record a real market-equity snapshot (device-local, throttled).
function recordEquityPoint(){
  const eq = computePortfolio().equity;
  if(!isFinite(eq)) return;
  const now = Date.now();
  const h = state.equityHistory || (state.equityHistory=[]);
  const last = h[h.length-1];
  if(last && (now-last.t) < 15*60*1000 && Math.abs(eq-last.v) < Math.max(0.01, Math.abs(last.v)*0.0005)) return;
  h.push({ t:now, v:+eq.toFixed(2) });
  if(h.length>1000) h.splice(0, h.length-1000);
  persistLocal();
}

// Fetch and cache CoinGecko market-chart prices for a crypto asset.
// Resolves true when new points were stored.
const HISTORY_TTL_MS = 60*60*1000;
async function fetchAssetPriceHistory(assetId, days){
  const asset = state.assets[assetId];
  if(!asset || asset.type !== "crypto" || !asset.coingeckoId) return false;
  const cache = state.priceHistory[assetId];
  if(cache && cache.days >= days && Date.now() - cache.updatedAt < HISTORY_TTL_MS) return false;
  try{
    const j = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(asset.coingeckoId)}/market_chart?vs_currency=usd&days=${days}`);
    if(!j || !Array.isArray(j.prices) || !j.prices.length) return false;
    const points = j.prices
      .filter(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]))
      .map(([t, p]) => ({ t, p: +p.toPrecision(8) }))   // significant digits, so sub-cent tokens keep their value
      .sort((a, b) => a.t - b.t);
    if(!points.length) return false;
    state.priceHistory[assetId] = { points, days, updatedAt: Date.now() };
    return true;
  }catch(e){ return false; }
}

let _marketFetchAt = 0;
async function fetchMarketHistoryForAllHeld(){
  if(Date.now() - _marketFetchAt < 4000) return;   // renders call this; don't hammer the API
  _marketFetchAt = Date.now();
  const pos = computePortfolio().positions;
  const preset = (state.ui.range && state.ui.range.preset) || "all";
  const daysMap = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365, "ytd": 365, "all": 365 };
  const days = daysMap[preset] || 30;
  const ids = Object.keys(pos).filter(id => pos[id].qty > EPS && state.assets[id] && state.assets[id].type === "crypto");
  const updated = await Promise.all(ids.map(id => fetchAssetPriceHistory(id, days)));
  if(updated.some(Boolean)){
    persistLocal();
    if(state.ui.mode !== "goal" && state.ui.view === "dashboard") renderDashboard();
  }
}

// Catmull-Rom to cubic Bezier spline for smooth chart curves.
function smoothSvgPath(points){
  if(!points || !points.length) return "";
  if(points.length === 1) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  if(points.length === 2){
    return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  }
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for(let i=0; i<points.length-1; i++){
    const p0 = i > 0 ? points[i-1] : points[i];
    const p1 = points[i];
    const p2 = points[i+1];
    const p3 = i < points.length-2 ? points[i+2] : p2;
    const cp1x = p1.x + (p2.x - p0.x)/6;
    const cp1y = p1.y + (p2.y - p0.y)/6;
    const cp2x = p2.x - (p3.x - p1.x)/6;
    const cp2y = p2.y - (p3.y - p1.y)/6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

// Chart series for the active range (one pass over the ledger, see LedgerEngine.equitySeries).
function equitySeries(currentEquity, filter = "all", timeRange = null){
  return LE.equitySeries(valuationCtx(), timeRange || activeRange(), filter, currentEquity, state.equityHistory);
}

function activeRange(){
  const r = (state.ui && state.ui.range) || { preset:"all" };
  const now = Date.now(), D = 86400000;
  const startOfDay = ms => { const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); };
  const endOfDay = ms => { const d=new Date(ms); d.setHours(23,59,59,999); return d.getTime(); };
  let startTs, endTs = now, label;
  switch(r.preset){
    case "24h": startTs = now - D; label = "Last 24 hours"; break;
    case "7d":  startTs = now - 7*D; label = "Last 7 days"; break;
    case "30d": startTs = now - 30*D; label = "Last 30 days"; break;
    case "90d": startTs = now - 90*D; label = "Last 90 days"; break;
    case "1y":  startTs = now - 365*D; label = "Last 12 months"; break;
    case "ytd": startTs = new Date(new Date().getFullYear(),0,1).getTime(); label = "Year to date"; break;
    case "custom":
      startTs = r.start ? startOfDay(new Date(r.start+"T00:00:00").getTime()) : -Infinity;
      endTs   = r.end   ? Math.min(now, endOfDay(new Date(r.end+"T00:00:00").getTime())) : now;
      { const f = t => (t===-Infinity?"start":new Date(t).toLocaleDateString([], {month:'short',day:'2-digit',year:'2-digit'}));
        label = `${f(startTs)} – ${new Date(endTs).toLocaleDateString([], {month:'short',day:'2-digit',year:'2-digit'})}`; }
      break;
    default: startTs = -Infinity; endTs = now; label = "All time";
  }
  return { preset: r.preset||"all", startTs, endTs, label, isAll: (r.preset||"all")==="all" };
}

function computeRange(){
  const R = activeRange();
  return Object.assign(R, LE.rangeStats(valuationCtx(), R));
}

function rangeBarHTML(){
  const r = (state.ui && state.ui.range) || { preset:"all" };
  const presets = [["all","All"],["ytd","YTD"],["24h","24H"],["7d","7D"],["30d","30D"],["90d","90D"],["1y","1Y"],["custom","Custom"]];
  const chips = presets.map(([k,lbl])=>`<button class="rangechip ${r.preset===k?'active':''}" data-range="${k}">${lbl}</button>`).join("");
  const inp = "background:var(--input-bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:var(--radius);margin-left:5px";
  const custom = r.preset==="custom" ? `
    <div class="flex" style="gap:12px;flex-wrap:wrap;margin-top:9px">
      <label class="muted" style="font-size:12.5px">From<input type="date" id="rangeStart" value="${esc(r.start||"")}" style="${inp}"></label>
      <label class="muted" style="font-size:12.5px">To<input type="date" id="rangeEnd" value="${esc(r.end||"")}" style="${inp}"></label>
    </div>` : "";
  return `<div class="rangebar"><span class="muted" style="font-size:12px;margin-right:4px">Range</span>${chips}${custom}</div>`;
}

function wireRangeBar(){
  viewEl.querySelectorAll("[data-range]").forEach(b=>b.onclick=()=>{
    state.ui.range = state.ui.range || { preset:"all" };
    state.ui.range.preset = b.dataset.range;
    persistLocal();
    fetchMarketHistoryForAllHeld();
    renderDashboard();
  });
  const rs = document.getElementById("rangeStart"), re = document.getElementById("rangeEnd");
  if(rs) rs.onchange=()=>{ state.ui.range.start=rs.value||null; persistLocal(); renderDashboard(); };
  if(re) re.onchange=()=>{ state.ui.range.end=re.value||null; persistLocal(); renderDashboard(); };
}

function niceTicks(min, max, count){
  if(!(max > min)) return [min];
  const span = max - min, step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0))), norm = step0 / mag;
  let step; if(norm < 1.5) step = 1; else if(norm < 3) step = 2; else if(norm < 7) step = 5; else step = 10; step *= mag;
  const out = []; for(let v = Math.ceil(min/step)*step; v <= max + step*1e-6; v += step) out.push(+v.toFixed(6));
  return out;
}
function equityTickLabel(t, rangeDays){
  const d = new Date(t);
  if(rangeDays <= 1.2) return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  if(rangeDays <= 14) return d.toLocaleDateString([], {weekday:'short',day:'numeric'});
  if(rangeDays < 365) return d.toLocaleDateString([], {month:'short',day:'numeric'});
  return d.toLocaleDateString([], {month:'short',year:'2-digit'});
}

function equityChartHTML(currentEquity, holdings = []){
  const R = activeRange();
  const chartMode = (state.ui && state.ui.chartMode) || "equity";
  const chartAsset = (state.ui && state.ui.chartAsset) || "all";
  const showNetcap = !(state.ui && state.ui.chart && state.ui.chart.netcap === false);   // net-capital line toggle (equity mode)

  const s = equitySeries(currentEquity, chartAsset, R);

  if(s.length < 2){
    lastEquityChart = null;
    return `
      <div style="padding:16px 18px">
        <div class="chart-header">
          <h2 style="margin:0">Performance</h2>
          <div class="chart-timeframe-bar">
            ${[["24h","24H"],["7d","7D"],["30d","30D"],["90d","90D"],["1y","1Y"],["all","ALL"]].map(([k,lbl])=>`
              <button class="chart-tf-btn ${R.preset===k?'active':''}" data-chart-range="${k}">${lbl}</button>`).join("")}
          </div>
        </div>
        ${emptyBlock("📉","Not enough history to chart","Record a trade or wait for price history to build.")}
      </div>`;
  }

  const W = 800, H = 240, padL = 10, padR = 10, padT = 16, padB = 24;
  const w = W - padL - padR, h = H - padT - padB;
  const tMin = s[0].t, tMax = s[s.length-1].t;

  let plotVal, benchVal, fmtMetric;
  if(chartMode === "profit"){
    plotVal = p => p.profit;
    benchVal = () => 0;
    fmtMetric = v => (v>=0?"+":"") + fmtUSD(v);
  } else if(chartMode === "return"){
    plotVal = p => p.retPct;
    benchVal = () => 0;
    fmtMetric = fmtPct;
  } else {
    plotVal = p => p.v;
    benchVal = p => p.nc;
    fmtMetric = fmtUSD;
  }

  const includeBench = (chartMode !== "equity") || showNetcap;   // exclude net-capital from Y-scale when hidden
  const allv = s.map(plotVal).concat(includeBench ? s.map(benchVal) : []);
  const rawMin = Math.min(...allv), rawMax = Math.max(...allv);
  let vMin = rawMin, vMax = rawMax;
  if(vMin === vMax){
    vMin -= Math.max(1, Math.abs(vMin)*0.05);
    vMax += Math.max(1, Math.abs(vMax)*0.05);
  }
  const padv = (vMax - vMin) * 0.12;
  vMin -= padv; vMax += padv;

  const X = t => padL + (tMax===tMin ? 0 : (t - tMin)/(tMax - tMin)) * w;
  const Y = v => padT + (1 - (v - vMin)/(vMax - vMin)) * h;

  const pts = s.map(p => ({ x: +X(p.t).toFixed(1), y: +Y(plotVal(p)).toFixed(1), p }));
  const mainLinePath = smoothSvgPath(pts);

  const baselineY = Math.min(padT + h, Math.max(padT, Y(0)));
  const bottomY = padT + h;
  const areaPath = pts.length ? `${mainLinePath} L${pts[pts.length-1].x.toFixed(1)},${bottomY.toFixed(1)} L${pts[0].x.toFixed(1)},${bottomY.toFixed(1)} Z` : "";

  // Bench line (Net Capital for equity mode, Zero line for profit/return)
  let benchLinePath;
  if(chartMode === "equity"){
    benchLinePath = showNetcap ? s.map((p,i)=>`${i?"L":"M"}${X(p.t).toFixed(1)},${Y(p.nc).toFixed(1)}`).join(" ") : "";
  } else {
    benchLinePath = `M${padL},${baselineY.toFixed(1)} L${W-padR},${baselineY.toFixed(1)}`;
  }

  // Profit/Loss band for equity mode
  let band = "";
  if(chartMode === "equity" && showNetcap){
    const polys = [];
    for(let i=0; i<s.length-1; i++){
      const x0 = s[i].t, x1 = s[i+1].t, e0 = s[i].v, e1 = s[i+1].v, n0 = s[i].nc, n1 = s[i+1].nc;
      const d0 = e0 - n0, d1 = e1 - n1;
      const poly = (ax,ae,bx,be,bn,an,up) => ({ up, d:`M${X(ax).toFixed(1)},${Y(ae).toFixed(1)} L${X(bx).toFixed(1)},${Y(be).toFixed(1)} L${X(bx).toFixed(1)},${Y(bn).toFixed(1)} L${X(ax).toFixed(1)},${Y(an).toFixed(1)} Z` });
      if((d0>=0 && d1>=0) || (d0<=0 && d1<=0)){
        polys.push(poly(x0,e0,x1,e1,n1,n0,(d0+d1)>=0));
      } else {
        const f = d0 / (d0 - d1);
        const xc = x0 + (x1 - x0)*f, ec = e0 + (e1 - e0)*f, nc = n0 + (n1 - n0)*f;
        polys.push(poly(x0,e0,xc,ec,nc,n0,d0>=0));
        polys.push(poly(xc,ec,x1,e1,n1,nc,d1>=0));
      }
    }
    band = polys.map(p => `<path d="${p.d}" fill="${p.up?'var(--green)':'var(--red)'}" fill-opacity="0.14"/>`).join("");
  }

  const lastP = s[s.length-1];
  const firstP = s[0];
  const curPlotVal = plotVal(lastP);
  const curProfit = lastP.profit;
  const curRetPct = lastP.retPct;
  const isPos = curProfit >= 0;

  // Period stats
  const metricValues = s.map(plotVal);
  const periodHigh = Math.max(...metricValues);
  const periodLow = Math.min(...metricValues);
  const periodChange = curPlotVal - plotVal(firstP);

  const mainColor = isPos ? "var(--green)" : "var(--red)";
  lastEquityChart = {
    series: s,
    pts,
    chartMode,
    chartAsset,
    plotVal,
    benchVal,
    fmtMetric,
    W, H, padL, padR, padT, padB, w, h, tMin, tMax, vMin, vMax,
    stroke: mainColor
  };

  const rangeDays = (tMax - tMin) / 86400000;
  const ticks = [];
  const NT = 5;
  for(let i=0; i<NT; i++){
    const f = i / (NT - 1);
    const t = tMin + f * (tMax - tMin);
    const leftPct = (X(t) / W * 100);
    ticks.push(`<span style="left:${leftPct.toFixed(2)}%">${equityTickLabel(t, rangeDays)}</span>`);
  }

  // Y-axis amount thresholds (nice round values), formatted per the current mode
  const yLabels = niceTicks(rawMin, rawMax, 4)
    .map(v => `<span style="top:${(Y(v)/H*100).toFixed(2)}%">${fmtMetric(v)}</span>`).join("");

  // Asset filter dropdown options
  const uniqueHoldings = (holdings || []).filter(h => h && h.asset);
  let assetFilterHTML = "";
  if(uniqueHoldings.length > 0){
    const opts = `<option value="all" ${chartAsset==="all"?"selected":""}>Entire Portfolio</option>` +
      uniqueHoldings.map(h => `<option value="${esc(h.assetId)}" ${chartAsset===h.assetId?"selected":""}>${esc(symOf(h.asset))} · ${esc(h.asset.name||h.asset.symbol)}</option>`).join("");
    assetFilterHTML = `<select class="chart-asset-select" id="chartAssetSelect" title="Filter performance by asset">${opts}</select>`;
  }

  const tfPresets = [["24h","24H"],["7d","7D"],["30d","30D"],["90d","90D"],["1y","1Y"],["all","ALL"]];
  const tfChips = tfPresets.map(([k,lbl]) => `
    <button class="chart-tf-btn ${R.preset===k?'active':''}" data-chart-range="${k}">${lbl}</button>
  `).join("");

  // Headline representation
  let bigNumText, subBadgeText, subContextText;
  if(chartMode === "profit"){
    bigNumText = (curProfit >= 0 ? "+" : "") + fmtUSD(curProfit);
    subBadgeText = `${fmtPct(curRetPct)} return`;
    subContextText = `on ${fmtUSD(lastP.nc)} net capital`;
  } else if(chartMode === "return"){
    bigNumText = fmtPct(curRetPct);
    subBadgeText = `${curProfit >= 0 ? "+" : ""}${fmtUSD(curProfit)} P/L`;
    subContextText = `on ${fmtUSD(lastP.nc)} net capital`;
  } else {
    bigNumText = fmtUSD(lastP.v);
    subBadgeText = `${curProfit >= 0 ? "+" : ""}${fmtUSD(curProfit)} (${fmtPct(curRetPct)})`;
    subContextText = `vs ${fmtUSD(lastP.nc)} net capital`;
  }

  return `
    <div style="padding:16px 18px 12px">
      <div class="chart-header">
        <div class="flex" style="align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0">Performance</h2>
          <div class="chart-mode-seg" id="chartModeSeg" title="Switch chart representation">
            <button class="${chartMode==='equity'?'active':''}" data-cmode="equity">Equity ($)</button>
            <button class="${chartMode==='profit'?'active':''}" data-cmode="profit">Profit ($)</button>
            <button class="${chartMode==='return'?'active':''}" data-cmode="return">Return (%)</button>
          </div>
        </div>
        <div class="flex" style="align-items:center;gap:8px;flex-wrap:wrap">
          ${assetFilterHTML}
          <div class="chart-timeframe-bar" id="chartTfBar">
            ${tfChips}
          </div>
        </div>
      </div>

      <div class="flex" style="justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <div>
          <span class="bignum ${chartMode!=='equity'?cls(curProfit):''}">${bigNumText}</span>
          <span class="${cls(curProfit)}" style="font-weight:700;font-size:14px;margin-left:8px;padding:2px 7px;border-radius:4px;background:var(--chip)">
            ${arrow(curProfit)}${subBadgeText}
          </span>
          <div class="muted" style="font-size:12px;margin-top:3px">${subContextText} · ${R.label}</div>
        </div>
        <div style="font-size:12px;text-align:right">
          ${chartMode==='equity'
            ? `<span style="color:var(--text);font-weight:600">▬ Equity</span> &nbsp; <label class="chart-legend-toggle" title="Show/hide the net-capital line"><input type="checkbox" id="chkNetcap" ${showNetcap?'checked':''}><span class="muted">╌ Net capital</span></label>
               ${showNetcap?`<div class="muted" style="margin-top:2px"><span class="pos">▮</span> profit &nbsp;<span class="neg">▮</span> loss</div>`:``}`
            : `<span style="color:${mainColor};font-weight:600">▬ ${chartMode==='profit'?'Net Profit':'Return %'}</span> &nbsp; <span class="muted">╌ Zero baseline</span>`}
        </div>
      </div>

      <div class="chart-stats-strip">
        <div class="chart-stat-item"><span class="muted">Period Low:</span> <b>${fmtMetric(periodLow)}</b></div>
        <div class="chart-stat-item"><span class="muted">Period High:</span> <b>${fmtMetric(periodHigh)}</b></div>
        <div class="chart-stat-item"><span class="muted">Period Change:</span> <b class="${cls(periodChange)}">${arrow(periodChange)}${fmtMetric(Math.abs(periodChange))}</b></div>
        <div class="chart-stat-item" style="margin-left:auto"><span class="muted" style="font-size:11px">✨ Real market valuation</span></div>
      </div>

      <div class="eqchart" id="eqChart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:240px;display:block">
          <defs>
            <linearGradient id="eqGreenGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--green)" stop-opacity="0.32"/>
              <stop offset="100%" stop-color="var(--green)" stop-opacity="0.02"/>
            </linearGradient>
            <linearGradient id="eqRedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--red)" stop-opacity="0.32"/>
              <stop offset="100%" stop-color="var(--red)" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          <!-- Grid lines -->
          <line x1="${padL}" y1="${padT}" x2="${W-padR}" y2="${padT}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3"/>
          <line x1="${padL}" y1="${(padT+h*0.5).toFixed(1)}" x2="${W-padR}" y2="${(padT+h*0.5).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3"/>
          <line x1="${padL}" y1="${padT+h}" x2="${W-padR}" y2="${padT+h}" stroke="var(--border)" stroke-width="1"/>

          <!-- Area fill -->
          <path d="${areaPath}" fill="${isPos?'url(#eqGreenGrad)':'url(#eqRedGrad)'}"/>

          <!-- Equity profit/loss band -->
          ${band}

          <!-- Benchmark / Zero line -->
          <path d="${benchLinePath}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>

          <!-- Smooth Main Line -->
          <path d="${mainLinePath}" fill="none" stroke="${mainColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="eqy">${yLabels}</div>
        <div class="eqcross" id="eqCross" style="display:none"></div>
        <div class="eqdot" id="eqDot" style="display:none"></div>
        <div class="eqtip" id="eqTip" style="display:none"></div>
        <div class="eqx">${ticks.join("")}</div>
      </div>
      <div class="muted" style="font-size:11.5px;margin-top:8px">
        ${chartMode==='equity'
          ? "The band highlights profit (green) or loss (red) above your invested capital. Additional capital inflows lift both lines equally without skewing returns."
          : (chartMode==='profit' ? "Tracks net dollar gain/loss over time with zero baseline." : "Tracks overall portfolio percentage gain/loss over time with 0% baseline.")}
      </div>
    </div>`;
}

// Attach hover crosshair + tooltip + button handlers
function wireEquityHover(){
  const c = document.getElementById("eqChart");
  const m = lastEquityChart;
  if(!c || !m) return;

  // Wire mode switcher and timeframe chips
  const panel = document.getElementById("equityChartPanel") || c.closest(".panel");
  if(panel){
    panel.querySelectorAll("[data-cmode]").forEach(b => {
      b.onclick = () => {
        state.ui.chartMode = b.dataset.cmode;
        persistLocal();
        renderDashboard();
      };
    });
    panel.querySelectorAll("[data-chart-range]").forEach(b => {
      b.onclick = () => {
        state.ui.range = state.ui.range || { preset:"all" };
        state.ui.range.preset = b.dataset.chartRange;
        persistLocal();
        fetchMarketHistoryForAllHeld();
        renderDashboard();
      };
    });
    const assetSel = panel.querySelector("#chartAssetSelect");
    if(assetSel){
      assetSel.onchange = () => {
        state.ui.chartAsset = assetSel.value;
        persistLocal();
        renderDashboard();
      };
    }
    const ncChk = panel.querySelector("#chkNetcap");
    if(ncChk){
      ncChk.onchange = () => {
        state.ui.chart = state.ui.chart || {};
        state.ui.chart.netcap = ncChk.checked;
        persistLocal();
        renderDashboard();
      };
    }
  }

  const cross = document.getElementById("eqCross"), dot = document.getElementById("eqDot"), tip = document.getElementById("eqTip");
  if(!cross || !dot || !tip) return;

  cross.style.top = m.padT + "px";
  cross.style.height = m.h + "px";

  const Xv = t => m.padL + (m.tMax===m.tMin ? 0 : (t - m.tMin)/(m.tMax - m.tMin)) * m.w;
  const Yv = v => m.padT + (1 - (v - m.vMin)/(m.vMax - m.vMin)) * m.h;

  function move(clientX){
    const rect = c.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * m.W;
    const tFrac = Math.max(0, Math.min(1, (svgX - m.padL) / m.w));
    const t = m.tMin + tFrac * (m.tMax - m.tMin);

    let bi = 0;
    for(let i=0; i<m.series.length; i++){
      if(Math.abs(m.series[i].t - t) < Math.abs(m.series[bi].t - t)) bi = i;
    }
    const best = m.series[bi];
    const val = m.plotVal(best);
    const bx = Xv(best.t) / m.W * rect.width;
    const by = Yv(val);

    cross.style.left = bx + "px";
    cross.style.display = "block";
    cross.removeAttribute("hidden");

    dot.style.left = bx + "px";
    dot.style.top = by + "px";
    dot.style.background = m.stroke;
    dot.style.display = "block";
    dot.removeAttribute("hidden");

    const dtStr = new Date(best.t).toLocaleDateString([], { month:'short', day:'numeric', year:'2-digit' }) +
      " " + new Date(best.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

    let tipContent = `<div class="muted" style="font-size:11px">${dtStr}</div>`;
    if(m.chartMode === "profit"){
      tipContent += `<b>${(val>=0?"+":"") + fmtUSD(val)}</b> <span class="muted">profit</span>` +
        `<br><span class="muted">equity: ${fmtUSD(best.v)}</span>` +
        `<br><span class="${cls(best.retPct)}">${fmtPct(best.retPct)} return</span>`;
    } else if(m.chartMode === "return"){
      tipContent += `<b>${fmtPct(val)}</b> <span class="muted">return</span>` +
        `<br><span class="muted">equity: ${fmtUSD(best.v)}</span>` +
        `<br><span class="${cls(best.profit)}">${(best.profit>=0?"+":"")+fmtUSD(best.profit)} P/L</span>`;
    } else {
      tipContent += `<b>${fmtUSD(best.v)}</b> <span class="muted">equity</span>` +
        `<br><span class="muted">${fmtUSD(best.nc)} net capital</span>` +
        `<br><span class="${cls(best.profit)}">${arrow(best.profit)}${fmtUSD(Math.abs(best.profit))} (${fmtPct(best.retPct)})</span>`;
    }

    tip.innerHTML = tipContent;
    tip.style.display = "block";
    tip.removeAttribute("hidden");

    const tw = tip.offsetWidth || 140, th = tip.offsetHeight || 60;
    let tl = bx + 12;
    if(tl + tw > rect.width) tl = bx - tw - 12;
    tip.style.left = Math.max(0, tl) + "px";
    tip.style.top = Math.max(0, Math.min(by - th - 8, m.padT + m.h - th)) + "px";
  }

  function hide(){
    cross.style.display = "none"; cross.setAttribute("hidden", "");
    dot.style.display = "none"; dot.setAttribute("hidden", "");
    tip.style.display = "none"; tip.setAttribute("hidden", "");
  }

  c.onmousemove = e => move(e.clientX);
  c.onmouseleave = hide;
  c.ontouchstart = e => { if(e.touches[0]) move(e.touches[0].clientX); };
  c.ontouchmove = e => { if(e.touches[0]){ move(e.touches[0].clientX); e.preventDefault(); } };
  c.ontouchend = hide;
}

function holdingsTable(p, compact){
  const rows = p.holdings.map(h=>{
    const badge = LE.safeUrl(h.asset.img) ? `<img src="${escUrl(h.asset.img)}" alt="" referrerpolicy="no-referrer">` : esc((h.asset.symbol||"?").slice(0,3).toUpperCase());
    const pct = p.holdingsValue>0 && h.marketValue!=null ? (h.marketValue/p.holdingsValue*100):0;
    const uPnlPct = h.costBasis>0 && h.unrealized!=null ? (h.unrealized/h.costBasis*100):null;
    // break-even (vs net capital) cell
    let beCell;
    const be = h.breakevenPrice;
    if(be==null){ beCell='<span class="muted">—</span>'; }
    else if(be<=0){ beCell='<span class="pos" title="Cash + your other holdings already cover net capital">✓ covered</span>'; }
    else{
      let sub='';
      if(h.live!=null){ const mv=(be/h.live-1)*100; sub=` <small class="${mv>0?'neg':'pos'}">(${mv>0?'+':''}${mv.toFixed(1)}%)</small>`; }
      beCell = fmtPrice(be)+sub;
    }
    return `<tr>
      <td><div class="sym"><div class="badge">${badge}</div>
        <div class="meta">${esc((h.asset.symbol||"").toUpperCase())} <span class="tag ${esc(h.asset.type)}">${esc(h.asset.type)}</span><small>${esc(h.asset.name||"")}</small></div></div></td>
      <td>${fmtNum(h.qty)}</td>
      <td>${fmtPrice(h.avgCost)}</td>
      <td>${fmtUSD(h.costBasis)}</td>
      <td>${h.live!=null?fmtPrice(h.live):'<span class="muted">—</span>'}</td>
      <td>${h.marketValue!=null?fmtUSD(h.marketValue):'<span class="muted">—</span>'}</td>
      <td class="${h.unrealized!=null?cls(h.unrealized):''}">${h.unrealized!=null?arrow(h.unrealized)+fmtUSD(Math.abs(h.unrealized))+(uPnlPct!=null?` <small>(${fmtPct(uPnlPct)})</small>`:''):'<span class="muted">—</span>'}</td>
      <td>${beCell}</td>
      ${compact?`<td style="width:110px"><div class="bar"><i style="width:${Math.min(100,pct).toFixed(1)}%"></i></div><small class="muted">${pct.toFixed(1)}%</small></td>`:''}
      <td style="white-space:nowrap;text-align:right">
        <button class="btn sm" data-buy="${esc(h.assetId)}" title="Buy more ${esc((h.asset.symbol||'').toUpperCase())}">＋ Buy</button>
        <button class="btn sm" data-sell="${esc(h.assetId)}" title="Sell some ${esc((h.asset.symbol||'').toUpperCase())}">－ Sell</button>
        <button class="btn sm" data-close="${esc(h.assetId)}" title="Sell your entire ${esc((h.asset.symbol||'').toUpperCase())} position">Close</button>
      </td>
    </tr>`;
  }).join("");
  return `<table><thead><tr>
    <th>Asset</th><th>Qty</th><th>Avg cost</th><th>Cost basis</th><th>Live price</th><th>Market value</th><th>Unrealized P&L</th>
    <th title="Price this asset must reach for total equity to equal your net capital, with cash and other holdings held constant">Break-even <small>(net cap)</small></th>${compact?'<th>Weight</th>':''}<th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHoldings(){
  const p = computePortfolio();
  viewEl.innerHTML = `
    <div class="panel">
      <h2>Holdings <span class="spacer"></span><span class="muted price-fresh">${freshnessText(p.holdings)}</span></h2>
      ${p.holdings.length? holdingsTable(p,false): emptyBlock("📈","No open positions","Add a Buy transaction to start tracking a holding.")}
    </div>`;
}

/* ---------- watchlist / favorites ---------- */
let favSearchType="crypto", favSearchTimer=null;
function freshnessTextFav(){
  const times=(state.favorites||[]).map(f=>state.prices[f.id]).filter(Boolean).map(pr=>new Date(pr.updatedAt).getTime());
  if(!times.length) return "prices not loaded";
  const secs=Math.round((Date.now()-Math.max(...times))/1000);
  return "updated "+(secs<60?secs+"s ago":Math.round(secs/60)+"m ago");
}
function renderWatchlist(){
  const favs=state.favorites||[];
  const rows=favs.map(f=>{
    const pr=state.prices[f.id]; const live=pr?pr.price:null;
    const badge=LE.safeUrl(f.img)?`<img src="${escUrl(f.img)}" alt="" referrerpolicy="no-referrer">`:esc((f.symbol||"?").slice(0,3).toUpperCase());
    return `<tr>
      <td><div class="sym"><div class="badge">${badge}</div>
        <div class="meta">${esc((f.symbol||"").toUpperCase())} <span class="tag ${esc(f.type)}">${esc(f.type)}</span><small>${esc(f.name||"")}</small></div></div></td>
      <td>${live!=null?fmtPrice(live):'<span class="muted">—</span>'}</td>
      <td style="white-space:nowrap;text-align:right">
        ${f.type==="stock"?`<button class="btn sm" data-favnews="${esc(f.symbol)}" title="View news for ${esc(f.symbol)}">📰 News</button>`:''}
        <button class="btn sm" data-favbuy="${esc(f.id)}">＋ Buy</button>
        <button class="iconbtn" data-favdel="${esc(f.id)}" title="Remove from watchlist">🗑</button>
      </td></tr>`;
  }).join("");
  viewEl.innerHTML=`
    <div class="panel">
      <h2>Watchlist <span class="spacer"></span><span class="muted price-fresh">${favs.length?freshnessTextFav():''}</span></h2>
      <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <div class="seg" id="favTypeSeg" style="width:auto;flex:0 0 auto">
            <button data-ft="crypto" class="${favSearchType==='crypto'?'active':''}">Crypto</button>
            <button data-ft="stock" class="${favSearchType==='stock'?'active':''}">Stock</button>
          </div>
          <input id="favSearch" placeholder="Search to add a ticker or coin…" autocomplete="off"
            style="flex:1;min-width:200px;background:var(--input-bg);border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:var(--radius)">
        </div>
        <div class="search-results" id="favResults"></div>
      </div>
      ${favs.length? `<table><thead><tr><th>Asset</th><th>Live price</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : emptyBlock("⭐","Your watchlist is empty","Search above to add stocks or coins you want to keep an eye on.")}
    </div>`;
  viewEl.querySelectorAll("#favTypeSeg button").forEach(b=>b.onclick=()=>{ favSearchType=b.dataset.ft; renderWatchlist(); const i=document.getElementById("favSearch"); if(i) i.focus(); });
  const inp=document.getElementById("favSearch");
  inp.addEventListener("input",()=>{ clearTimeout(favSearchTimer); const q=inp.value.trim(); favSearchTimer=setTimeout(()=>doFavSearch(q),300); });
  viewEl.querySelectorAll("[data-favnews]").forEach(b=>b.onclick=()=>{
    newsFilterTicker = b.dataset.favnews;
    state.ui.view = "news";
    saveUi();
    render();
  });
  viewEl.querySelectorAll("[data-favbuy]").forEach(b=>b.onclick=()=>{ const f=state.favorites.find(x=>x.id===b.dataset.favbuy); if(f) openModal({type:"BUY", asset:f}); });
  viewEl.querySelectorAll("[data-favdel]").forEach(b=>b.onclick=()=>{ state.favorites=state.favorites.filter(x=>x.id!==b.dataset.favdel); save(); render(); toast("Removed from watchlist"); });
}
async function doFavSearch(q){
  const box=document.getElementById("favResults"); if(!box) return;
  if(!q||q.length<2){ box.classList.remove("open"); box.innerHTML=""; return; }
  box.innerHTML=`<div class="sr-item muted">Searching…</div>`; box.classList.add("open");
  try{
    const items=await searchAssets(q, favSearchType);
    box.innerHTML=items.map((it,i)=>`<div class="sr-item" data-i="${i}">
      ${LE.safeUrl(it.img)?`<img src="${escUrl(it.img)}" alt="" referrerpolicy="no-referrer">`:`<div class="badge" style="width:22px;height:22px;font-size:10px">${esc(it.symbol.slice(0,3).toUpperCase())}</div>`}
      <div><b>${esc(it.symbol.toUpperCase())}</b> <small class="muted">${esc(it.name||"")}</small></div></div>`).join("");
    box._items=items;
    box.querySelectorAll(".sr-item[data-i]").forEach(el=>el.onclick=()=>{
      const a=assetFromItem(box._items[parseInt(el.dataset.i,10)]);
      if(!a){ toast("That asset can't be tracked", true); return; }
      if(state.favorites.some(f=>f.id===a.id)){ toast("Already in watchlist"); box.classList.remove("open"); return; }
      state.favorites.push(a); save(); render(); toast(`Added ${a.symbol}`); refreshPrices();
    });
  }catch(e){ box.innerHTML=`<div class="sr-item muted">Search failed: ${esc(e.message)}</div>`; }
}

/* ---------- news for favorite stocks ---------- */
let newsFilterTicker = "ALL";
let newsSearchQuery = "";
const newsCache = Object.create(null); // ticker -> { time: number, articles: [] }
let newsLastRefreshTime = 0;
let currentNewsArticles = [];

function getFavoriteStocks(){
  return (state.favorites || []).filter(f => f && f.type === "stock");
}

function newsLastUpdatedText(){
  if(!newsLastRefreshTime) return "";
  const secs = Math.round((Date.now() - newsLastRefreshTime) / 1000);
  return "updated " + (secs < 60 ? secs + "s ago" : Math.round(secs / 60) + "m ago");
}

function formatRelativeTime(ts){
  if(!ts) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if(diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if(diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if(diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if(diffDays < 30) return `${diffDays}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {month:"short", day:"numeric"});
}

// Shown when live news isn't available. Clearly labelled as a placeholder and
// links to the ticker's real news page; never invents headlines.
function getFallbackNews(symbol, reason){
  const s = (symbol || "STOCK").toUpperCase();
  return [{
    id: `fallback-${s}`,
    ticker: s,
    headline: `Open the latest ${s} news on Yahoo Finance`,
    summary: reason === "error"
      ? `Live news for ${s} couldn't be loaded right now. Try Refresh, or follow the link for the latest coverage.`
      : `Add your free Finnhub API key in Settings to see live ${s} company news here.`,
    source: "CryptoLedger",
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(s)}/news`,
    image: null,
    datetime: Date.now(),
    category: "placeholder"
  }];
}

// Normalizes one Finnhub article; drops anything without a usable http(s) link.
function toArticle(item, sym, idx){
  if(!item || typeof item!=="object") return null;
  const url = LE.safeUrl(item.url);
  const headline = typeof item.headline==="string" ? item.headline.slice(0, 300) : "";
  if(!url || !headline) return null;
  return {
    id: String(item.id != null ? item.id : `${sym}-${idx}`),
    ticker: sym,
    headline,
    summary: typeof item.summary==="string" ? item.summary.slice(0, 1000) : "",
    source: typeof item.source==="string" && item.source ? item.source.slice(0, 80) : "Market News",
    url,
    image: LE.safeUrl(item.image) || null,
    datetime: Number.isFinite(item.datetime) && item.datetime > 0 ? item.datetime * 1000 : Date.now(),
    category: typeof item.category==="string" ? item.category.slice(0, 40) : "company"
  };
}

async function fetchNewsForTicker(symbol){
  const sym = symbol.toUpperCase();
  const now = Date.now();
  const cached = newsCache[sym];
  if(cached && (now - cached.time < 15 * 60 * 1000)) return cached.articles;

  const key = state.settings.finnhubKey;
  let articles;
  if(!key){
    articles = getFallbackNews(sym, "nokey");
  } else {
    try {
      const toDate = new Date().toISOString().slice(0, 10);
      const dFrom = new Date();
      dFrom.setDate(dFrom.getDate() - 30);
      const fromDate = dFrom.toISOString().slice(0, 10);
      const data = await fetchJSON(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${fromDate}&to=${toDate}&token=${encodeURIComponent(key)}`);
      const items = Array.isArray(data) ? data.slice(0, 100).map((it, i) => toArticle(it, sym, i)).filter(Boolean) : [];
      articles = items.length ? items : getFallbackNews(sym, "error");
    } catch(e){
      console.warn("Finnhub news failed for " + sym, e);
      articles = getFallbackNews(sym, "error");
    }
  }
  newsCache[sym] = { time: now, articles };
  return articles;
}

async function fetchNewsArticles(ticker, force){
  const favStocks = getFavoriteStocks();
  if(!favStocks.length) return [];
  if(force){
    if(ticker === "ALL"){
      favStocks.forEach(s => delete newsCache[s.symbol.toUpperCase()]);
    } else {
      delete newsCache[ticker.toUpperCase()];
    }
  }

  newsLastRefreshTime = Date.now();

  if(ticker === "ALL"){
    const results = await Promise.all(favStocks.map(s => fetchNewsForTicker(s.symbol)));
    const all = results.flat();
    all.sort((a, b) => b.datetime - a.datetime);
    return all;
  } else {
    const list = await fetchNewsForTicker(ticker);
    const copy = [...list];
    copy.sort((a, b) => b.datetime - a.datetime);
    return copy;
  }
}

function renderNews(){
  const favStocks = getFavoriteStocks();
  if(!favStocks.length){
    viewEl.innerHTML = `
      <div class="panel">
        <h2>Stock News <span class="spacer"></span><span class="muted price-fresh">0 favorite stocks</span></h2>
        ${emptyBlock("📰", "No favorite stocks in your watchlist", "Add stocks like AAPL, NVDA, or TSLA to your Watchlist to monitor live company news and market updates.")}
        <div style="text-align:center;padding-bottom:32px">
          <button class="btn primary" id="newsGoToWatchlist">Go to Watchlist</button>
        </div>
      </div>`;
    const btn = document.getElementById("newsGoToWatchlist");
    if(btn) btn.onclick = () => { state.ui.view = "watchlist"; saveUi(); render(); };
    return;
  }

  if(newsFilterTicker !== "ALL" && !favStocks.some(s => s.symbol.toUpperCase() === newsFilterTicker.toUpperCase())){
    newsFilterTicker = "ALL";
  }

  const hasKey = Boolean(state.settings.finnhubKey);
  const bannerHTML = !hasKey ? `
    <div class="news-banner">
      <span>⚡ <b>Live Feed Notice:</b> Showing preview headlines for your favorite stocks. Enter your free Finnhub API key in Settings for real-time live company news.</span>
      <div class="spacer"></div>
      <button class="btn sm" id="newsSettingsBtn" style="padding:3px 8px;font-size:11px">Open Settings →</button>
    </div>` : '';

  const pillButtons = [
    `<button class="news-pill ${newsFilterTicker==='ALL'?'active':''}" data-newspill="ALL">
      All Favorites <span class="pill-count">${favStocks.length}</span>
    </button>`,
    ...favStocks.map(s => {
      const sym = s.symbol.toUpperCase();
      const isActive = newsFilterTicker === sym;
      return `<button class="news-pill ${isActive?'active':''}" data-newspill="${esc(sym)}">${esc(sym)}</button>`;
    })
  ].join("");

  viewEl.innerHTML = `
    <div class="panel">
      <h2>Stock News <span class="spacer"></span><span class="muted price-fresh" id="newsFreshness">${newsLastUpdatedText()}</span></h2>
      ${bannerHTML}
      <div class="news-controls">
        <div class="news-pills" id="newsPills">${pillButtons}</div>
        <div class="news-search-box">
          <input type="text" id="newsSearchInput" placeholder="Filter headlines…" value="${esc(newsSearchQuery)}" autocomplete="off" />
          <button class="btn sm" id="newsRefreshBtn" title="Refresh latest news">↻ Refresh</button>
        </div>
      </div>
      <div id="newsGrid" class="news-grid">
        <div class="news-loading" style="grid-column:1/-1">
          <div class="news-spinner"></div>
          <div>Loading news for <b>${esc(newsFilterTicker)}</b>…</div>
        </div>
      </div>
    </div>`;

  const sBtn = document.getElementById("newsSettingsBtn");
  if(sBtn) sBtn.onclick = () => { state.ui.view = "settings"; saveUi(); render(); };

  viewEl.querySelectorAll("[data-newspill]").forEach(b => {
    b.onclick = () => {
      newsFilterTicker = b.dataset.newspill;
      renderNews();
    };
  });

  const searchInput = document.getElementById("newsSearchInput");
  if(searchInput){
    searchInput.oninput = () => {
      newsSearchQuery = searchInput.value;
      filterAndRenderArticles();
    };
  }

  const refreshBtn = document.getElementById("newsRefreshBtn");
  if(refreshBtn){
    refreshBtn.onclick = () => {
      loadNews(true);
    };
  }

  loadNews(false);
}

async function loadNews(force){
  const grid = document.getElementById("newsGrid");
  if(!grid) return;
  if(force){
    grid.innerHTML = `<div class="news-loading" style="grid-column:1/-1"><div class="news-spinner"></div><div>Refreshing news…</div></div>`;
  }
  try {
    currentNewsArticles = await fetchNewsArticles(newsFilterTicker, force);
    const freshEl = document.getElementById("newsFreshness");
    if(freshEl) freshEl.textContent = newsLastUpdatedText();
    filterAndRenderArticles();
  } catch(e){
    if(grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="em">⚠️</div><b>Could not load news</b><div class="muted">${esc(e.message)}</div></div>`;
  }
}

function filterAndRenderArticles(){
  const grid = document.getElementById("newsGrid");
  if(!grid) return;
  const q = (newsSearchQuery || "").trim().toLowerCase();
  let list = currentNewsArticles;
  if(q){
    list = list.filter(a => (a.headline && a.headline.toLowerCase().includes(q)) || (a.summary && a.summary.toLowerCase().includes(q)) || (a.ticker && a.ticker.toLowerCase().includes(q)));
  }

  if(!list.length){
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:40px 10px"><div class="em">🔍</div><b>No news found</b><div class="muted">${q ? `No articles matching "${esc(q)}"` : `No recent articles available for ${esc(newsFilterTicker)}`}</div></div>`;
    return;
  }

  grid.innerHTML = list.map(item => {
    const dateStr = formatRelativeTime(item.datetime);
    const fullDate = new Date(item.datetime).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
    const imgHTML = item.image
      ? `<img class="news-card-img" src="${escUrl(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(item.ticker)}">`
      : `<div class="news-card-img-fallback">${esc(item.ticker)}</div>`;

    return `
      <article class="news-card" data-ticker="${esc(item.ticker)}">
        <div class="news-card-img-wrap">
          ${imgHTML}
        </div>
        <div class="news-card-body">
          <div class="news-card-meta">
            <span class="tag stock news-ticker-tag">${esc(item.ticker)}</span>
            <span class="news-source">${esc(item.source)}</span>
            <span class="news-dot"></span>
            <span class="news-time">${esc(dateStr)}</span>
          </div>
          <h3 class="news-card-title">
            <a href="${escUrl(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.headline)}</a>
          </h3>
          ${item.summary ? `<p class="news-card-snippet">${esc(item.summary)}</p>` : ''}
          <div class="news-card-foot">
            <span class="muted" style="font-size:11px">${esc(fullDate)}</span>
            <a href="${escUrl(item.url)}" target="_blank" rel="noopener noreferrer">Read article ↗</a>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderLedger(){
  const R = activeRange();
  const txns = [...state.transactions]
    .filter(t=>{ if(R.isAll) return true; const ts=new Date(t.date).getTime(); return ts>=R.startTs && ts<=R.endTs; })
    .sort((a,b)=> new Date(b.date)-new Date(a.date) || (b._seq||0)-(a._seq||0));
  // realized P/L per sell (chronological replay over ALL history for correct cost basis)
  const realizedByTxn = LE.realizedBySell(state.transactions);
  const rows = txns.map(t=>{
    let detail, amount, showNote=false;
    if(t.type==="DEPOSIT"||t.type==="WITHDRAW"){ detail=t.note?esc(t.note):"Cash "+t.type.toLowerCase(); amount=t.amount*(t.type==="DEPOSIT"?1:-1); }
    else if(t.type==="ADJUST"){
      showNote=true;
      if(t.target==="cash"){ detail=`Cash adjustment (${t.delta>=0?"added":"removed"})`; amount=t.delta; }
      else{ const a=state.assets[t.assetId]||{symbol:t.assetId};
        detail=`${t.qtyDelta>=0?"+":"−"}${fmtNum(Math.abs(t.qtyDelta))} ${esc((a.symbol||"").toUpperCase())} (holding adjustment)`; amount=null; }
    }
    else{
      const a=state.assets[t.assetId]||{symbol:t.assetId};
      const gross=t.qty*t.price, fee=t.fee||0; showNote=true;
      detail=`${fmtNum(t.qty)} ${esc((a.symbol||"").toUpperCase())} @ ${fmtPrice(t.price)}${fee?` · fee ${fmtUSD(fee)}`:''}`;
      amount = t.type==="BUY" ? -(gross+fee) : (gross-fee);
    }
    const pl = (t.type==="SELL" && realizedByTxn[t.id]!=null) ? realizedByTxn[t.id] : null;
    return `<tr>
      <td><small class="muted">${new Date(t.date).toLocaleString([], {year:'2-digit',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></td>
      <td><span class="tag ${esc(t.type)}">${esc(t.type)}</span></td>
      <td style="text-align:left">${detail}${t.note && showNote?` <small class="muted">— ${esc(t.note)}</small>`:''}</td>
      <td class="${amount==null?'muted':cls(amount)}">${amount==null?'—':sign(amount)+fmtUSD(amount)}</td>
      <td class="${pl==null?'muted':cls(pl)}">${pl==null?'—':arrow(pl)+fmtUSD(Math.abs(pl))}</td>
      <td style="width:1px">
        <button class="iconbtn" data-edit="${esc(t.id)}" title="Edit">✎</button>
        <button class="iconbtn" data-del="${esc(t.id)}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join("");
  viewEl.innerHTML = `
    <div class="panel">
      <h2>Transaction ledger ${R.isAll?"":`<span class="tag" style="font-size:9.5px">${R.label}</span>`}<span class="spacer"></span>
        <button class="btn sm" id="exportBtn">⭳ Export JSON</button>
        <button class="btn sm" id="importBtn">⭱ Import JSON</button>
        <button class="btn sm primary" id="addBtn2">+ Add</button>
      </h2>
      ${txns.length? `<table><thead><tr><th>Date</th><th>Type</th><th style="text-align:left">Details</th><th>Cash impact</th><th>Realized P/L</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : emptyBlock("🧾", R.isAll?"No transactions yet":"No transactions in this range", R.isAll?"Start by adding a Deposit for your initial capital.":"Change the date range on the Dashboard, or pick All.")}
    </div>`;
}

function renderSettings(){
  const s = state.settings;
  viewEl.innerHTML = `
    <div class="panel" style="max-width:640px">
      <h2>Settings</h2>
      <div style="padding:18px">
        <div class="field">
          <label>☁ Cloud sync</label>
          <div id="cloudBox"></div>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <div class="field">
          <label>Finnhub API key (for live stock prices)</label>
          <input type="text" id="setKey" value="${esc(s.finnhubKey||"")}" placeholder="paste your free key" autocomplete="off" spellcheck="false" />
          <div class="hint">Get a free key at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io/register</a>. Crypto prices via CoinGecko need no key.</div>
        </div>
        <div class="field">
          <label>Secondary currency (shown on dashboard alongside USD)</label>
          <select id="setCurrency">
            <option value="PKR">PKR — Pakistani Rupee</option>
            <option value="INR">INR — Indian Rupee</option>
            <option value="AED">AED — UAE Dirham</option>
            <option value="GBP">GBP — British Pound</option>
            <option value="EUR">EUR — Euro</option>
            <option value="CAD">CAD — Canadian Dollar</option>
            <option value="SAR">SAR — Saudi Riyal</option>
            <option value="JPY">JPY — Japanese Yen</option>
          </select>
          <div class="hint">Live USD exchange rate via open.er-api.com (free, no key). Values in this currency appear under each dashboard figure.</div>
        </div>
        <div class="field">
          <label>Exchange rate</label>
          <label class="flex" style="font-weight:600;color:var(--text);cursor:pointer;margin-bottom:8px">
            <input type="checkbox" id="setManual" style="width:auto"> Override rate manually
          </label>
          <input type="text" inputmode="decimal" class="amt" id="setRate" placeholder="e.g. 285" autocomplete="off" />
          <div class="hint" id="rateHint"></div>
        </div>
        <div class="field">
          <label>Auto-refresh prices</label>
          <select id="setRefresh">
            <option value="0">Off (manual only)</option>
            <option value="30">Every 30 seconds</option>
            <option value="60">Every 1 minute</option>
            <option value="300">Every 5 minutes</option>
          </select>
        </div>
        <div class="flex" style="margin-top:8px">
          <button class="btn primary" id="saveSettings">Save settings</button>
          <span class="spacer" style="flex:1"></span>
          <button class="btn danger" id="resetAll">Reset all data</button>
        </div>
        <div class="warn" style="margin-top:16px">Your data is stored only in this browser (localStorage). Use <b>Export JSON</b> in the Ledger tab to back it up.</div>
      </div>
    </div>`;
  renderCloudBox();
  document.getElementById("setRefresh").value = String(s.autoRefreshSec||0);
  document.getElementById("setCurrency").value = secCode();
  const manualChk = document.getElementById("setManual");
  const rateInp = document.getElementById("setRate");
  const rateHint = document.getElementById("rateHint");
  function syncRateUI(){
    rateInp.disabled = !manualChk.checked;
    rateInp.style.opacity = manualChk.checked ? "1" : ".5";
    const fetched = fetchedRate();
    rateHint.innerHTML = manualChk.checked
      ? `Using your fixed rate. ${fetched!=null?`Live market rate is ${fetched.toLocaleString(undefined,{maximumFractionDigits:2})}.`:""} Uncheck to follow the live rate.`
      : `Following the live market rate${fetched!=null?` (${fetched.toLocaleString(undefined,{maximumFractionDigits:2})})`:""}. Check the box to pin your own (e.g. your USDT conversion rate).`;
  }
  manualChk.checked = rateIsManual();
  rateInp.value = rateIsManual() ? fmtAmtStr(s.manualRate) : (fetchedRate()!=null ? fmtAmtStr(+fetchedRate().toFixed(2)) : "");
  manualChk.onchange = syncRateUI;
  syncRateUI();
  document.getElementById("saveSettings").onclick = ()=>{
    state.settings.finnhubKey = document.getElementById("setKey").value.trim();
    state.settings.autoRefreshSec = parseInt(document.getElementById("setRefresh").value,10)||0;
    const prevCur = state.settings.secondaryCurrency;
    state.settings.secondaryCurrency = document.getElementById("setCurrency").value;
    if(manualChk.checked){
      const v = stripNum(rateInp.value);
      if(!(v>0)){ toast("Enter a positive rate, or uncheck override", true); return; }
      state.settings.manualRate = v;
    } else {
      state.settings.manualRate = null;
    }
    // a manual rate is tied to the currency it was set for; switching currency drops it
    if(state.settings.secondaryCurrency!==prevCur) state.settings.manualRate = null;
    save(); setupAutoRefresh(); updateFxChip(); render(); toast("Settings saved");
    if(state.settings.secondaryCurrency!==prevCur) fetchFx(true).then(()=>render());
    if(state.settings.finnhubKey) refreshPrices();
  };
  document.getElementById("resetAll").onclick = ()=>{
    if(confirm("Delete ALL transactions and settings? This cannot be undone.")){
      state=defaultState(); save(); applyTheme(); setupAutoRefresh(); updateFxChip(); render(); toast("All data cleared");
    }
  };
}

function emptyBlock(em,title,sub){ return `<div class="empty"><div class="em">${em}</div><b>${title}</b><div class="muted" style="margin-top:4px">${sub}</div></div>`; }
function freshnessText(holdings){
  const times = holdings.map(h=>h.updatedAt).filter(Boolean).map(t=>new Date(t).getTime());
  if(!times.length) return "prices not loaded";
  const latest = Math.max(...times);
  const secs = Math.round((Date.now()-latest)/1000);
  return "updated " + (secs<60? secs+"s ago" : Math.round(secs/60)+"m ago");
}

/* ---------- price fetching ---------- */
// Assets to price = current holdings + watchlist favorites (deduped by id).
function priceTargets(){
  const map=Object.create(null);
  const positions = computePortfolio().positions;
  for(const id of Object.keys(positions)){ if(positions[id].qty>EPS && state.assets[id]) map[id]=state.assets[id]; }
  for(const f of state.favorites){ map[f.id]=f; }
  return Object.values(map);
}
async function fetchCryptoPrices(assets){
  const ids = [...new Set(assets.map(a=>a.coingeckoId))];
  const j = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(",")}&vs_currencies=usd`);
  const now = new Date().toISOString();
  let ok=0;
  for(const a of assets){
    const usd = j && j[a.coingeckoId] && j[a.coingeckoId].usd;
    if(Number.isFinite(usd) && usd>0){ state.prices[a.id]={price:usd, updatedAt:now}; ok++; }
  }
  return { ok, fail: assets.length-ok };
}
async function fetchStockQuote(symbol, key){
  const j = await fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol.toUpperCase())}&token=${encodeURIComponent(key)}`);
  return j && Number.isFinite(j.c) && j.c>0 ? j.c : null;
}
async function fetchStockPrices(assets){
  const key = state.settings.finnhubKey;
  if(!key) return { ok:0, fail:assets.length };
  const now = new Date().toISOString();
  const results = await Promise.allSettled(assets.map(a=>fetchStockQuote(a.symbol, key)));
  let ok=0;
  results.forEach((r,i)=>{ if(r.status==="fulfilled" && r.value!=null){ state.prices[assets[i].id]={price:r.value, updatedAt:now}; ok++; } });
  return { ok, fail: assets.length-ok };
}

let _refreshing=null, _refreshQueued=false;
// Refreshes FX + all prices. Overlapping calls (auto-refresh, saves, the button)
// collapse into the running one plus at most one follow-up run.
function refreshPrices(){
  if(_refreshing){ _refreshQueued=true; return _refreshing; }
  _refreshing = doRefreshPrices().finally(()=>{
    _refreshing=null;
    if(_refreshQueued){ _refreshQueued=false; refreshPrices(); }
  });
  return _refreshing;
}
async function doRefreshPrices(){
  const status = document.getElementById("apiStatus");
  await fetchFx();                       // keep USD -> secondary-currency rate fresh (throttled)
  const targets = priceTargets();
  const cryptos = targets.filter(a=>a.type==="crypto" && a.coingeckoId);
  const stocks = targets.filter(a=>a.type==="stock");
  if(!cryptos.length && !stocks.length){ status.textContent="prices: nothing to price"; render(); return; }
  status.textContent="prices: updating…";
  const [c, s] = await Promise.all([
    cryptos.length ? fetchCryptoPrices(cryptos).catch(()=>({ok:0, fail:cryptos.length})) : {ok:0, fail:0},
    stocks.length ? fetchStockPrices(stocks) : {ok:0, fail:0}
  ]);
  const ok=c.ok+s.ok, fail=c.fail+s.fail;
  persistLocal();
  recordEquityPoint();                 // capture a real equity snapshot with fresh prices
  status.textContent = ok||fail ? `prices: ${ok} ok${fail?`, ${fail} failed`:''}` : "prices: error";
  if(stocks.length && !state.settings.finnhubKey) toast("Add a Finnhub key in Settings for stock prices", true);
  render();
}

let autoTimer=null;
function setupAutoRefresh(){
  if(autoTimer){ clearInterval(autoTimer); autoTimer=null; }
  const s = state.settings.autoRefreshSec||0;
  if(s>0){ autoTimer=setInterval(refreshPrices, s*1000); }
}

/* ---------- transaction modal ---------- */
const overlay = document.getElementById("txOverlay");
let modalType="DEPOSIT", modalAssetType="crypto", pickedAsset=null, editingId=null, searchTimer=null;
let adjTarget="cash", adjDir="add";

// txn: pass an existing transaction (with id) to edit, or a prefill object
// {type, assetId, qty?, price?} with no id to start a new one pre-filled.
function openModal(txn){
  editingId = (txn && txn.id) ? txn.id : null;
  document.getElementById("txTitle").textContent = editingId ? "Edit transaction" : "Add transaction";
  // defaults
  modalType = txn? txn.type : "DEPOSIT";
  pickedAsset = (txn && txn.asset) ? txn.asset : (txn && txn.assetId ? state.assets[txn.assetId] : null);
  modalAssetType = pickedAsset ? pickedAsset.type : "crypto";
  setSeg("txTypeSeg","type",modalType);
  setSeg("assetTypeSeg","atype",modalAssetType);
  setAmt(document.getElementById("cashAmount"), txn && (txn.type==="DEPOSIT"||txn.type==="WITHDRAW")? txn.amount : "");
  document.getElementById("assetSearch").value = pickedAsset && txn && txn.type!=="ADJUST"? `${(pickedAsset.symbol||"").toUpperCase()} — ${pickedAsset.name||""}` : "";
  setAmt(document.getElementById("qty"), txn && txn.qty!=null? txn.qty : "");
  setAmt(document.getElementById("price"), txn && txn.price!=null? txn.price : "");
  setAmt(document.getElementById("total"), (txn && txn.qty>0 && txn.price>0) ? +(txn.qty*txn.price).toFixed(2) : "");
  document.getElementById("pctSlider").value=0;
  document.querySelectorAll("#pctSeg button").forEach(b=>b.classList.remove("active"));
  document.getElementById("sizeHint").textContent="";
  setAmt(document.getElementById("fee"), txn && txn.fee? txn.fee : "");
  document.getElementById("txNote").value = txn? (txn.note||"") : "";
  document.getElementById("txDate").value = toLocalInput(txn? txn.date : new Date().toISOString());
  document.getElementById("searchResults").classList.remove("open");
  document.getElementById("assetPicked").textContent = pickedAsset && (!txn||txn.type!=="ADJUST")? `Tracking ${(pickedAsset.symbol||"").toUpperCase()} (${pickedAsset.type})` : "";
  // adjust defaults
  if(txn && txn.type==="ADJUST"){
    adjTarget = txn.target==="cash" ? "cash" : "asset";
    adjDir = (txn.target==="cash" ? txn.delta : txn.qtyDelta) >= 0 ? "add" : "remove";
    setAmt(document.getElementById("adjAmount"), Math.abs(txn.target==="cash" ? txn.delta : txn.qtyDelta));
  } else {
    adjTarget="cash"; adjDir="add"; document.getElementById("adjAmount").value="";
  }
  setSeg("adjTargetSeg","adj",adjTarget);
  setSeg("adjDirSeg","dir",adjDir);
  populateAdjAssets(txn && txn.type==="ADJUST" ? txn.assetId : null);
  updateModalMode(); updateTradeCalc(); updateAdjustCalc();
  overlay.classList.add("open");
}
function closeModal(){ overlay.classList.remove("open"); }

function setSeg(segId, attr, val){
  document.querySelectorAll(`#${segId} button`).forEach(b=>b.classList.toggle("active", b.dataset[attr]===val));
}
function populateAdjAssets(selectId){
  const sel=document.getElementById("adjAsset");
  const held=heldAssets(editingId);
  sel.innerHTML = held.length
    ? held.map(a=>`<option value="${esc(a.id)}">${esc((a.symbol||"").toUpperCase())} — ${esc(a.name||"")}</option>`).join("")
    : `<option value="">(no holdings to adjust)</option>`;
  if(selectId) sel.value=selectId;
}
function updateModalMode(){
  const isCash = modalType==="DEPOSIT"||modalType==="WITHDRAW";
  const isAdjust = modalType==="ADJUST";
  const isTrade = modalType==="BUY"||modalType==="SELL";
  document.getElementById("cashFields").style.display = isCash? "block":"none";
  document.getElementById("tradeFields").style.display = isTrade? "block":"none";
  document.getElementById("adjustFields").style.display = isAdjust? "block":"none";
  if(isAdjust){
    document.getElementById("adjAssetField").style.display = adjTarget==="asset"? "block":"none";
    document.getElementById("adjAmtLabel").textContent = adjTarget==="cash"? "Amount (USD)" : "Quantity";
  }
  if(isTrade){
    populateAssetPick();
    document.getElementById("sizeLabel").textContent = modalType==="SELL" ? "Sell size (% of holding)" : "Buy size (% of cash)";
  }
  updateBalanceStrip();
}

// Quick-pick dropdown: your holdings (for Sell) or holdings + watchlist (for Buy).
function populateAssetPick(){
  const field=document.getElementById("assetPickField"), sel=document.getElementById("assetPick");
  const label=document.getElementById("assetPickLabel");
  let list;
  if(modalType==="SELL"){ label.textContent="Pick a holding to sell"; list=heldAssets(editingId); }
  else { // BUY: everything you hold or watch, deduped
    label.textContent="Pick an existing asset";
    const map={}; heldAssets(editingId).forEach(a=>map[a.id]=a);
    (state.favorites||[]).forEach(f=>{ if(!map[f.id]) map[f.id]=f; });
    Object.values(state.assets).forEach(a=>{ if(!map[a.id]) map[a.id]=a; });
    list=Object.values(map);
  }
  if(!list.length){ field.style.display="none"; sel.innerHTML=""; return; }
  field.style.display="block";
  sel.innerHTML = `<option value="">— pick, or search below —</option>` +
    list.map(a=>`<option value="${esc(a.id)}">${esc((a.symbol||"").toUpperCase())} — ${esc(a.name||"")}</option>`).join("");
  sel.value = (pickedAsset && list.some(a=>a.id===pickedAsset.id)) ? pickedAsset.id : "";
  // keep a lookup so the change handler can resolve the picked object
  sel._byId = {}; list.forEach(a=>sel._byId[a.id]=a);
}

// Shows available cash / units for the current transaction context.
function updateBalanceStrip(){
  const strip=document.getElementById("balanceStrip");
  const p=computePortfolio(editingId);
  const chips=[];
  const cashChip=`<div class="bchip"><span class="bl">Available cash</span><span class="bv ${p.cash<0?'neg':''}">${fmtUSD(p.cash)}</span></div>`;
  function heldChip(asset){
    if(!asset) return "";
    const pos=p.positions[asset.id]; const q=pos?pos.qty:0;
    const pr=state.prices[asset.id]; const val=pr?q*pr.price:null;
    return `<div class="bchip"><span class="bl">You hold · ${esc((asset.symbol||"").toUpperCase())}</span><span class="bv">${fmtNum(q)}${val!=null?` <small class="muted">(${fmtUSD(val)})</small>`:''}</span></div>`;
  }
  if(modalType==="DEPOSIT"||modalType==="WITHDRAW"){ chips.push(cashChip); }
  else if(modalType==="BUY"){ chips.push(cashChip); if(pickedAsset) chips.push(heldChip(pickedAsset)); }
  else if(modalType==="SELL"){ if(pickedAsset) chips.push(heldChip(pickedAsset)); chips.push(cashChip); }
  else if(modalType==="ADJUST"){
    if(adjTarget==="cash") chips.push(cashChip);
    else { const sel=document.getElementById("adjAsset"); const a=sel&&sel.value?state.assets[sel.value]:null; chips.push(heldChip(a)); }
  }
  strip.innerHTML=chips.join("");
}

function updateAdjustCalc(){
  if(modalType!=="ADJUST") return;
  const el=document.getElementById("adjustCalc"), warn=document.getElementById("adjustWarn");
  warn.innerHTML="";
  const amt=stripNum(document.getElementById("adjAmount").value)||0;
  const p=computePortfolio(editingId);
  if(adjTarget==="cash"){
    const after = p.cash + (adjDir==="add"? amt : -amt);
    el.innerHTML=`Cash ${adjDir==="add"?"→ increases":"→ decreases"} by <b>${fmtUSD(amt)}</b> &nbsp;·&nbsp; cash after: <b class="${after<0?'neg':''}">${fmtUSD(after)}</b>`;
    if(adjDir==="remove" && amt>p.cash+EPS) warn.innerHTML=`<div class="warn">You can't remove more than your available cash (${fmtUSD(p.cash)}).</div>`;
    else el.innerHTML+=` <small class="muted">— counts toward return, not net capital (use Deposit/Withdraw for your own capital).</small>`;
  } else {
    const sel=document.getElementById("adjAsset"); const a=sel&&sel.value?state.assets[sel.value]:null;
    const held=a? (p.positions[a.id]?p.positions[a.id].qty:0) : 0;
    const after = held + (adjDir==="add"? amt : -amt);
    el.innerHTML= a? `${esc((a.symbol||"").toUpperCase())} ${adjDir==="add"?"+":"−"}${fmtNum(amt)} units &nbsp;·&nbsp; holding after: <b>${fmtNum(after)}</b>` : "Pick a holding to adjust.";
    if(a && adjDir==="remove" && amt>held+EPS) warn.innerHTML=`<div class="warn">You only hold ${fmtNum(held)} units of ${esc((a.symbol||"").toUpperCase())}.</div>`;
    else if(a && adjDir==="add") el.innerHTML+=` <small class="muted">— added at $0 cost (e.g. airdrop/bonus); raises equity/return.</small>`;
    else if(a && adjDir==="remove") el.innerHTML+=` <small class="muted">— removed at average cost, no realized P&L.</small>`;
  }
}
function toLocalInput(iso){
  const d=new Date(iso); const p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Keep quantity / price / total consistent: given the field just edited and one
// other value present, compute the third. (total = qty × price)
function syncTriad(edited){
  const qEl=document.getElementById("qty"), pEl=document.getElementById("price"), tEl=document.getElementById("total");
  const q=stripNum(qEl.value), p=stripNum(pEl.value), t=stripNum(tEl.value);
  const ok=x=>Number.isFinite(x)&&x>0;
  const trim=(x,d)=>Number.isFinite(x)?+x.toFixed(d):"";
  if(edited==="qty"){
    if(ok(q)&&ok(p)) setAmt(tEl,trim(q*p,2));
    else if(ok(q)&&ok(t)) setAmt(pEl,trim(t/q,8));
  } else if(edited==="price"){
    if(ok(p)&&ok(q)) setAmt(tEl,trim(q*p,2));
    else if(ok(p)&&ok(t)) setAmt(qEl,trim(t/p,8));
  } else if(edited==="total"){
    if(ok(t)&&ok(p)) setAmt(qEl,trim(t/p,8));
    else if(ok(t)&&ok(q)) setAmt(pEl,trim(t/q,8));
  }
  updateTradeCalc();
}

// Size control: Sell = % of the held quantity, Buy = % of available cash.
function applySizePct(pct){
  pct=Math.max(0,Math.min(100,Math.round(pct)));
  const slider=document.getElementById("pctSlider"); if(slider) slider.value=pct;
  document.querySelectorAll("#pctSeg button").forEach(b=>b.classList.toggle("active", b.dataset.pct===String(pct)));
  const hint=document.getElementById("sizeHint");
  const p=computePortfolio(editingId);
  if(modalType==="SELL"){
    if(!pickedAsset){ if(hint) hint.textContent="Pick a holding first, then choose a size."; return; }
    const pos=p.positions[pickedAsset.id]; const held=pos?pos.qty:0;
    const qty=+(held*pct/100).toFixed(8);
    setAmt(document.getElementById("qty"), held>0 ? qty : "");
    syncTriad("qty");
    if(hint) hint.textContent = held>0 ? `Selling ${fmtNum(qty)} of ${fmtNum(held)} ${(pickedAsset.symbol||"").toUpperCase()} (${pct}%)` : "You don't hold this asset.";
  } else if(modalType==="BUY"){
    const cash=p.cash;
    const spend=+(cash*pct/100).toFixed(2);
    setAmt(document.getElementById("total"), spend>0 ? spend : "");
    syncTriad("total");
    const hasPrice=stripNum(document.getElementById("price").value)>0;
    if(hint) hint.textContent = `Spending ${fmtUSD(spend)} of ${fmtUSD(cash)} cash (${pct}%)` + (hasPrice?"":" — set a price to get quantity");
  }
}
// Reflect current qty/total back onto the slider position (one-way display sync).
function refreshSizeSlider(){
  const slider=document.getElementById("pctSlider"); if(!slider) return;
  const p=computePortfolio(editingId); let pct=null;
  if(modalType==="SELL" && pickedAsset){ const pos=p.positions[pickedAsset.id]; const held=pos?pos.qty:0;
    const q=stripNum(document.getElementById("qty").value); if(held>0 && Number.isFinite(q)) pct=q/held*100; }
  else if(modalType==="BUY"){ const t=stripNum(document.getElementById("total").value); if(p.cash>0 && Number.isFinite(t)) pct=t/p.cash*100; }
  if(pct!=null){ const cl=Math.max(0,Math.min(100,pct)); slider.value=Math.round(cl);
    document.querySelectorAll("#pctSeg button").forEach(b=>b.classList.toggle("active", b.dataset.pct===String(Math.round(cl)))); }
}

function updateTradeCalc(){
  updateBalanceStrip();
  const cashWarn=document.getElementById("cashWarn"); cashWarn.innerHTML="";
  if(modalType==="WITHDRAW"){
    const amt=stripNum(document.getElementById("cashAmount").value)||0;
    const avail=computePortfolio(editingId).cash;
    if(amt>avail+EPS) cashWarn.innerHTML=`<div class="warn">You only have ${fmtUSD(avail)} in cash to withdraw.</div>`;
  }
  const el=document.getElementById("tradeCalc"), warn=document.getElementById("tradeWarn");
  warn.innerHTML="";
  if(modalType==="DEPOSIT"||modalType==="WITHDRAW"||modalType==="ADJUST"){ return; }
  const qty=stripNum(document.getElementById("qty").value)||0;
  const price=stripNum(document.getElementById("price").value)||0;
  const fee=stripNum(document.getElementById("fee").value)||0;
  const gross=qty*price;
  const p=computePortfolio(editingId);
  if(modalType==="BUY"){
    const total=gross+fee;
    el.innerHTML=`Cost: <b>${fmtUSD(total)}</b> (${fmtNum(qty)} × ${fmtPrice(price)}${fee?` + ${fmtUSD(fee)} fee`:''}) &nbsp;·&nbsp; cash after: <b class="${(p.cash-total)<0?'neg':''}">${fmtUSD(p.cash-total)}</b>`;
    if(total>p.cash+EPS) warn.innerHTML=`<div class="warn">This buy exceeds your available cash (${fmtUSD(p.cash)}). It's allowed, but your cash will go negative.</div>`;
  }else{
    const proceeds=gross-fee;
    let basisSold=0, held=0;
    if(pickedAsset){ const pos=p.positions[pickedAsset.id]; held = pos?pos.qty:0; const avg=pos&&pos.qty>0?pos.costBasis/pos.qty:0; basisSold=avg*qty; }
    const realized=proceeds-basisSold;
    el.innerHTML=`Proceeds: <b>${fmtUSD(proceeds)}</b> &nbsp;·&nbsp; realized P&L: <b class="${cls(realized)}">${sign(realized)}${fmtUSD(realized)}</b>`;
    if(pickedAsset && qty>held+EPS) warn.innerHTML=`<div class="warn">You only hold ${fmtNum(held)} units of ${esc((pickedAsset.symbol||"").toUpperCase())}. Selling more than held isn't allowed.</div>`;
  }
  refreshSizeSlider();
}

/* asset search (CoinGecko for crypto, Finnhub for stocks) — reusable */
const typedStock = (q) => [{type:"stock",symbol:q.toUpperCase().slice(0,32),name:q.toUpperCase().slice(0,32),coingeckoId:null,img:null}];
async function searchAssets(q, assetType){
  if(assetType==="crypto"){
    const j=await fetchJSON(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
    return (Array.isArray(j && j.coins) ? j.coins : [])
      .filter(c=>c && typeof c.symbol==="string" && c.symbol && typeof c.id==="string")
      .slice(0,8).map(c=>({type:"crypto",symbol:c.symbol,name:String(c.name||""),coingeckoId:c.id,img:c.thumb}));
  }
  const key=state.settings.finnhubKey;
  if(!key) return typedStock(q);
  const j=await fetchJSON(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(key)}`);
  const items=(Array.isArray(j && j.result) ? j.result : [])
    .filter(x=>x && typeof x.symbol==="string" && x.symbol && !x.symbol.includes("."))
    .slice(0,8).map(x=>({type:"stock",symbol:x.symbol,name:String(x.description||""),coingeckoId:null,img:null}));
  return items.length ? items : typedStock(q);
}
// Builds a validated asset record from a search result (null if unusable).
function assetFromItem(it){
  const symbol = String(it.symbol||"").toUpperCase().slice(0,32);
  return LE.sanitizeAsset({ id:`${it.type}:${symbol}`, type:it.type, symbol, name:it.name, coingeckoId:it.coingeckoId, img:it.img });
}
async function doAssetSearch(q){
  const box=document.getElementById("searchResults");
  if(!q || q.length<2){ box.classList.remove("open"); box.innerHTML=""; return; }
  box.innerHTML=`<div class="sr-item muted">Searching…</div>`; box.classList.add("open");
  try{
    const items=await searchAssets(q, modalAssetType);
    box.innerHTML = items.map((it,i)=>`<div class="sr-item" data-i="${i}">
       ${LE.safeUrl(it.img)?`<img src="${escUrl(it.img)}" alt="" referrerpolicy="no-referrer">`:`<div class="badge" style="width:22px;height:22px;font-size:10px">${esc(it.symbol.slice(0,3).toUpperCase())}</div>`}
       <div><b>${esc(it.symbol.toUpperCase())}</b> <small class="muted">${esc(it.name||"")}</small></div></div>`).join("");
    box._items=items;
    box.querySelectorAll(".sr-item[data-i]").forEach(el=>el.onclick=()=>{
      const a=assetFromItem(box._items[parseInt(el.dataset.i,10)]);
      if(!a){ toast("That asset can't be tracked", true); return; }
      pickedAsset = a;
      document.getElementById("assetSearch").value=`${pickedAsset.symbol} — ${pickedAsset.name||""}`;
      document.getElementById("assetPicked").textContent=`Tracking ${pickedAsset.symbol} (${pickedAsset.type})`;
      const sel=document.getElementById("assetPick"); if(sel) sel.value="";
      box.classList.remove("open");
      updateTradeCalc();
    });
  }catch(e){ box.innerHTML=`<div class="sr-item muted">Search failed: ${esc(e.message)}</div>`; }
}

async function useLivePrice(){
  if(!pickedAsset){ toast("Pick an asset first", true); return; }
  try{
    let price=null;
    if(pickedAsset.type==="crypto" && pickedAsset.coingeckoId){
      const j=await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(pickedAsset.coingeckoId)}&vs_currencies=usd`);
      price = j && j[pickedAsset.coingeckoId] ? j[pickedAsset.coingeckoId].usd : null;
    }else if(pickedAsset.type==="stock"){
      const key=state.settings.finnhubKey; if(!key){ toast("Add a Finnhub key in Settings", true); return; }
      price = await fetchStockQuote(pickedAsset.symbol, key);
    }
    if(Number.isFinite(price) && price>0){ setAmt(document.getElementById("price"), price); syncTriad("price"); toast(`Live ${pickedAsset.symbol}: ${fmtPrice(price)}`); }
    else toast("Couldn't get a live price", true);
  }catch(e){ toast("Live price failed: "+e.message, true); }
}

function saveTransaction(){
  const dateVal=document.getElementById("txDate").value;
  const dateMs = dateVal ? new Date(dateVal).getTime() : Date.now();
  if(!Number.isFinite(dateMs)){ toast("Enter a valid date", true); return; }
  const date = new Date(dateMs).toISOString();
  const note=document.getElementById("txNote").value.trim().slice(0, 500);
  const p=computePortfolio(editingId);
  let txn;
  if(modalType==="DEPOSIT"||modalType==="WITHDRAW"){
    const amount=stripNum(document.getElementById("cashAmount").value);
    if(!(amount>0)){ toast("Enter a positive amount", true); return; }
    if(modalType==="WITHDRAW" && amount>p.cash+EPS){ toast(`Can't withdraw ${fmtUSD(amount)}; only ${fmtUSD(p.cash)} in cash`, true); return; }
    txn={type:modalType, amount, date, note};
  }else if(modalType==="ADJUST"){
    const amount=stripNum(document.getElementById("adjAmount").value);
    if(!(amount>0)){ toast("Enter a positive amount", true); return; }
    if(adjTarget==="cash"){
      if(adjDir==="remove" && amount>p.cash+EPS){ toast(`Can't remove ${fmtUSD(amount)}; only ${fmtUSD(p.cash)} in cash`, true); return; }
      txn={type:"ADJUST", target:"cash", delta:(adjDir==="add"?amount:-amount), date, note};
    }else{
      const sel=document.getElementById("adjAsset"); const assetId=sel&&sel.value;
      if(!assetId || !state.assets[assetId]){ toast("No holding selected to adjust", true); return; }
      const held=p.positions[assetId]?p.positions[assetId].qty:0;
      if(adjDir==="remove" && amount>held+EPS){ toast(`Can't remove ${fmtNum(amount)}; you only hold ${fmtNum(held)}`, true); return; }
      txn={type:"ADJUST", target:"asset", assetId, qtyDelta:(adjDir==="add"?amount:-amount), date, note};
    }
  }else{
    if(!pickedAsset){ toast("Search and pick an asset", true); return; }
    const qty=stripNum(document.getElementById("qty").value);
    const price=stripNum(document.getElementById("price").value);
    const feeRaw=document.getElementById("fee").value.trim();
    const fee=feeRaw ? stripNum(feeRaw) : 0;
    if(!(qty>0)){ toast("Enter a positive quantity", true); return; }
    if(!(price>0)){ toast("Enter a positive price", true); return; }
    if(!(fee>=0)){ toast("Fee must be zero or a positive number", true); return; }
    if(modalType==="SELL"){
      // validate against held qty (incl. adjustments), excluding the transaction being edited
      const pos=p.positions[pickedAsset.id];
      const held=pos?pos.qty:0;
      if(qty>held+EPS){ toast(`Can't sell ${fmtNum(qty)}; you only hold ${fmtNum(held)}`, true); return; }
    }
    const asset = LE.sanitizeAsset(pickedAsset);
    if(!asset){ toast("That asset can't be tracked", true); return; }
    state.assets[asset.id]=asset;   // register asset
    txn={type:modalType, assetId:asset.id, qty, price, fee, date, note};
  }
  if(editingId){
    const idx=state.transactions.findIndex(t=>t.id===editingId);
    if(idx<0){ toast("That transaction no longer exists (it may have been deleted on another device)", true); closeModal(); render(); return; }
    txn.id=editingId; txn._seq=state.transactions[idx]._seq;
    state.transactions[idx]=txn;
  }else{
    txn.id=uid();
    txn._seq=state.transactions.reduce((m,t)=>Math.max(m, t._seq||0), -1)+1;   // unique even after deletions
    state.transactions.push(txn);
  }
  save(); closeModal(); render(); toast("Transaction saved"); refreshPrices();
}

/* ---------- export / import ---------- */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`cryptoledger-backup-${new Date().toISOString().slice(0,10)}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function importData(){
  const inp=document.createElement("input"); inp.type="file"; inp.accept="application/json,.json";
  inp.onchange=()=>{
    const f=inp.files[0]; if(!f) return;
    if(f.size>MAX_IMPORT_BYTES){ toast("Import failed: file is larger than 10 MB", true); return; }
    const rd=new FileReader();
    rd.onload=()=>{
      try{
        const s=JSON.parse(rd.result);
        if(!s || typeof s!=="object" || !Array.isArray(s.transactions)) throw new Error("not a CryptoLedger backup");
        if(!confirm(`Replace ALL current data with this backup (${s.transactions.length} transactions)?`)) return;
        state=normalizeState(s, state.ui);
        save(); applyTheme(); setupAutoRefresh(); updateFxChip(); render();
        toast(state._dropped ? `Data imported · skipped ${state._dropped} invalid transaction(s)` : "Data imported", !!state._dropped);
        refreshPrices();
      }catch(e){ toast("Import failed: "+e.message, true); }
    };
    rd.readAsText(f);
  };
  inp.click();
}

/* ---------- toast ---------- */
let toastTimer=null;
function toast(msg, err){
  const t=document.getElementById("toast"); t.textContent=msg; t.className="toast show"+(err?" err":"");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className="toast",2600);
}

/* ---------- wiring ---------- */
document.getElementById("tabs").addEventListener("click",e=>{
  const tab=e.target.closest(".tab"); if(!tab) return;
  if(!tab.dataset.view) return;
  state.ui.view=tab.dataset.view; saveUi(); render();
});
document.getElementById("modeSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  state.ui.mode=b.dataset.mode==="goal"?"goal":"portfolio"; saveUi(); render();
});
document.getElementById("themeBtn").onclick=()=>{
  state.ui.theme = (state.ui.theme==="dark") ? "light" : "dark";
  saveUi(); applyTheme();
};
document.getElementById("addBtn").onclick=()=>openModal(null);
document.getElementById("refreshBtn").onclick=refreshPrices;
document.getElementById("txClose").onclick=closeModal;
document.getElementById("txCancel").onclick=closeModal;
document.getElementById("txSave").onclick=saveTransaction;
overlay.addEventListener("click",e=>{ if(e.target===overlay) closeModal(); });

document.getElementById("txTypeSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  modalType=b.dataset.type; setSeg("txTypeSeg","type",modalType); updateModalMode(); updateTradeCalc();
});
document.getElementById("assetTypeSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  modalAssetType=b.dataset.atype; setSeg("assetTypeSeg","atype",modalAssetType);
  pickedAsset=null; document.getElementById("assetSearch").value=""; document.getElementById("assetPicked").textContent="";
  document.getElementById("searchResults").classList.remove("open");
});
document.getElementById("assetSearch").addEventListener("input",e=>{
  pickedAsset=null; document.getElementById("assetPicked").textContent="";
  const sel=document.getElementById("assetPick"); if(sel) sel.value="";
  clearTimeout(searchTimer); const q=e.target.value.trim(); searchTimer=setTimeout(()=>doAssetSearch(q),300);
});
// quick-pick an existing holding / watched asset
document.getElementById("assetPick").addEventListener("change",e=>{
  const sel=e.target, id=sel.value;
  if(!id){ return; }
  const a = (sel._byId && sel._byId[id]) || state.assets[id];
  if(!a) return;
  pickedAsset = a; modalAssetType = a.type; setSeg("assetTypeSeg","atype",modalAssetType);
  document.getElementById("assetSearch").value = `${(a.symbol||"").toUpperCase()} — ${a.name||""}`;
  document.getElementById("assetPicked").textContent = `Tracking ${(a.symbol||"").toUpperCase()} (${a.type})`;
  document.getElementById("searchResults").classList.remove("open");
  updateTradeCalc();
});
document.getElementById("qty").addEventListener("input",()=>syncTriad("qty"));
document.getElementById("price").addEventListener("input",()=>syncTriad("price"));
document.getElementById("total").addEventListener("input",()=>syncTriad("total"));
document.getElementById("fee").addEventListener("input",updateTradeCalc);
document.getElementById("cashAmount").addEventListener("input",updateTradeCalc);
document.getElementById("useLive").onclick=useLivePrice;
document.getElementById("pctSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b) applySizePct(parseInt(b.dataset.pct,10)); });
document.getElementById("pctSlider").addEventListener("input",e=>applySizePct(parseInt(e.target.value,10)));

// adjust controls
document.getElementById("adjTargetSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  adjTarget=b.dataset.adj; setSeg("adjTargetSeg","adj",adjTarget); updateModalMode(); updateAdjustCalc();
});
document.getElementById("adjDirSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  adjDir=b.dataset.dir; setSeg("adjDirSeg","dir",adjDir); updateAdjustCalc();
});
document.getElementById("adjAmount").addEventListener("input",updateAdjustCalc);
document.getElementById("adjAsset").addEventListener("change",()=>{ updateBalanceStrip(); updateAdjustCalc(); });

// Open a pre-filled new transaction for a specific holding.
function openHoldingTxn(assetId, type, closeAll){
  const asset=state.assets[assetId]; if(!asset) return;
  const prefill={type, assetId};
  // Note: price is left blank on purpose — you enter the price you actually
  // bought/sold at. Use the "Use live price" button if you want the market price.
  if(closeAll){
    const pos=computePortfolio().positions[assetId];
    prefill.qty = pos? pos.qty : 0;              // sell the whole position
  }
  openModal(prefill);
}

// event delegation for ledger + dynamically-rendered buttons
viewEl.addEventListener("click",e=>{
  const ed=e.target.closest("[data-edit]"); const del=e.target.closest("[data-del]");
  const buy=e.target.closest("[data-buy]"), sell=e.target.closest("[data-sell]"), close=e.target.closest("[data-close]");
  if(buy){ openHoldingTxn(buy.dataset.buy,"BUY",false); return; }
  if(sell){ openHoldingTxn(sell.dataset.sell,"SELL",false); return; }
  if(close){ openHoldingTxn(close.dataset.close,"SELL",true); return; }
  if(ed){ const t=state.transactions.find(x=>x.id===ed.dataset.edit); if(t) openModal(t); return; }
  if(del){ const id=del.dataset.del; if(confirm("Delete this transaction?")){ state.transactions=state.transactions.filter(x=>x.id!==id); save(); render(); toast("Deleted"); } return; }
  if(e.target.closest("#exportBtn")) exportData();
  else if(e.target.closest("#importBtn")) importData();
  else if(e.target.closest("#addBtn2")) openModal(null);
});
// Broken news thumbnails fall back to a ticker tile (no inline onerror handlers, so a strict CSP works).
viewEl.addEventListener("error",e=>{
  const img=e.target;
  if(!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const tile=document.createElement("div"); tile.className="news-card-img-fallback"; tile.textContent=img.dataset.fallback;
  img.replaceWith(tile);
}, true);
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && overlay.classList.contains("open")) closeModal(); });
// live thousands-separator formatting for any amount input (runs before field handlers)
document.addEventListener("input",e=>{ if(e.target && e.target.classList && e.target.classList.contains("amt")) formatAmt(e.target); }, true);

/* ---------- boot ---------- */
_lastSyncSig = syncSignature();   // baseline so opening the app isn't seen as a data change
applyTheme();
recordEquityPoint();
render();
setupAutoRefresh();
updateFxChip();
// refreshPrices() also refreshes the FX rate; without a ledger just load the rate for the PKR lines.
if(state.transactions.length) refreshPrices();
else fetchFx().then(()=>render());
