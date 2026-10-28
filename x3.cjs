/* SmartTrader X3 — three paper-trading strategies in one Alpaca PAPER account (forward test, pre-registered).
   ORB  : Opening Range Breakout on "stocks in play" (Zarattini, Barbon & Aziz 2024), 5-min OR, top-20 relative volume.
   FADE : short large opening gaps-up on liquid, easy-to-borrow stocks; exit at close or stop.
   PAIR : Gatev-Goetzmann-Rouwenhorst distance pairs (frozen pairs.json), open at 2 sigma, close at convergence.
   Safety: paper-api only • books use disjoint symbols • TRADING_ENABLED=true is required to send orders (else dry run)
   • keys never printed • stateless: all state is re-read from the broker on every start.
   Usage: node x3.cjs            (env: APCA_KEY, APCA_SEC, TRADING_ENABLED, X3_MAX_MIN optional)                        */
'use strict';
const fs = require('fs'), path = require('path');
const VERSION = 'x3-1.2';
const PAPER = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const PAIRS = JSON.parse(fs.readFileSync(path.join(__dirname, 'pairs.json'), 'utf8'));

const R = Object.freeze({
  start: '2026-10-26', end: '2026-12-18', accountPrefix: 'PA',
  book: 30000, killLossUsd: 4500,
  orb: Object.freeze({ top: 20, minPrice: 5, minAvgVol: 1e6, minAtr: 0.5, rvolMin: 1.0, lookback: 14, stopAtrFrac: 0.10, riskUsd: 300, maxNotional: 6000, lastEntryMinAfterOpen: 15 }),
  fade: Object.freeze({ top: 5, minPrice: 5, minDollarVol: 20e6, minGap: 0.04, minZ: 2.5, stopAtrFrac: 0.5, riskUsd: 300, maxNotional: 6000 }),
  pair: Object.freeze({ legUsd: 1500, kSigma: 2.0, minBeforeClose: 15 }),
  cancelMinBeforeClose: 10, flattenMinBeforeClose: 5,
  judge: Object.freeze({ extraCostPerSidePct: 0.05, minTrades: 100, minPF: 1.2, minT: 2.4 })
});
const ETF_RE = /\b(ETF|ETN|Fund|iShares|SPDR|ProShares|Direxion|Index|Notes?|Warrants?|Units?|Rights?|Preferred)\b/i;
const EXCH = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS']);
const TRADING = String(process.env.TRADING_ENABLED || '').trim().toLowerCase() === 'true';
const MAX_MIN = +(process.env.X3_MAX_MIN || 340);
const log = [];
const say = (...a) => { const s = new Date().toISOString().slice(11, 19) + 'Z ' + a.join(' '); console.log(s); log.push(s); };
const clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }; /* replaceable only in dry simulation */
const sleep = ms => clock.sleep(ms);

/* ---------- pure helpers (unit-tested) ---------- */
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const c2 = x => Math.round(x * 100) / 100;
const up2 = x => Math.ceil(x * 100 - 1e-9) / 100, dn2 = x => Math.floor(x * 100 + 1e-9) / 100;
function dailyStats(bars) { /* bars: [{o,h,l,c,v}] oldest→newest, last = previous session */
  if (bars.length < 21) return null;
  const tr = []; for (let i = bars.length - 14; i < bars.length; i++) { const b = bars[i], pc = bars[i - 1].c; tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))); }
  const last14 = bars.slice(-14), last20 = bars.slice(-21);
  const lr = []; for (let i = 1; i < last20.length; i++) lr.push(Math.log(last20[i].c / last20[i - 1].c));
  return { atr: mean(tr), avgVol: mean(last14.map(b => b.v)), avgDollarVol: mean(bars.slice(-20).map(b => b.v * b.c)), prevClose: bars[bars.length - 1].c, sigma: sd(lr) };
}
function orbPick(rows, P = R.orb) { /* rows: {sym, st, bar:{o,h,l,c,v}, hist:[v...], shortable} */
  const el = [];
  for (const r of rows) {
    if (!r.st || !r.bar || r.st.prevClose < P.minPrice || r.st.avgVol < P.minAvgVol || r.st.atr <= P.minAtr) continue;
    if (!r.hist || r.hist.length < 10) continue; const h = mean(r.hist); if (!(h > 0)) continue;
    const rvol = r.bar.v / h; if (!(rvol >= P.rvolMin)) continue;
    const dir = r.bar.c > r.bar.o ? 'long' : r.bar.c < r.bar.o ? 'short' : null; if (!dir) continue;
    if (dir === 'short' && !r.shortable) continue;
    el.push({ sym: r.sym, rvol, dir, atr: r.st.atr, h: r.bar.h, l: r.bar.l, c: r.bar.c });
  }
  el.sort((a, b) => b.rvol - a.rvol || (a.sym < b.sym ? -1 : 1));
  return el.slice(0, P.top).map(x => {
    const entry = x.dir === 'long' ? up2(x.h) : dn2(x.l); const dist = P.stopAtrFrac * x.atr;
    const stop = x.dir === 'long' ? dn2(entry - dist) : up2(entry + dist);
    const qty = Math.floor(Math.min(P.riskUsd / Math.max(Math.abs(entry - stop), 0.01), P.maxNotional / entry));
    return { ...x, entry, stop, qty };
  }).filter(x => x.qty >= 1);
}
function fadePick(rows, exclude, P = R.fade) {
  const el = [];
  for (const r of rows) {
    if (!r.st || !r.bar || exclude.has(r.sym) || !r.shortable) continue;
    if (r.st.prevClose < P.minPrice || r.st.avgDollarVol < P.minDollarVol || !(r.st.sigma > 0)) continue;
    const gap = r.bar.o / r.st.prevClose - 1; if (gap < P.minGap) continue;
    const z = Math.log(r.bar.o / r.st.prevClose) / r.st.sigma; if (z < P.minZ) continue;
    el.push({ sym: r.sym, gap, z, atr: r.st.atr, ref: r.bar.c });
  }
  el.sort((a, b) => b.z - a.z || (a.sym < b.sym ? -1 : 1));
  return el.slice(0, P.top).map(x => { const stop = up2(x.ref + P.stopAtrFrac * x.atr); const qty = Math.floor(Math.min(P.riskUsd / Math.max(stop - x.ref, 0.01), P.maxNotional / x.ref)); return { ...x, stop, qty }; }).filter(x => x.qty >= 1);
}
function pairAction(p, pa, pb, posA, posB, k = R.pair.kSigma, lastDay = false) { /* pos: signed qty (0 = none) */
  const spread = pa / p.base_a - pb / p.base_b;
  const open = posA !== 0 || posB !== 0;
  if (open) {
    if (posA === 0 || posB === 0 || Math.sign(posA) === Math.sign(posB)) return { act: 'repair', spread };
    if (lastDay) return { act: 'close', spread, why: 'end-of-test' };
    const dir = posA < 0 ? 1 : -1; /* short A when spread was positive */
    if (dir * spread <= 0) return { act: 'close', spread, why: 'converged' };
    return { act: 'hold', spread };
  }
  if (lastDay) return { act: 'none', spread };
  if (spread > k * p.sigma) return { act: 'open', spread, shortSym: p.a, longSym: p.b };
  if (spread < -k * p.sigma) return { act: 'open', spread, shortSym: p.b, longSym: p.a };
  return { act: 'none', spread };
}
function pairQty(pa, pb, leg = R.pair.legUsd) { const eff = Math.max(leg, pa, pb); return { qa: Math.max(1, Math.round(eff / pa)), qb: Math.max(1, Math.round(eff / pb)), legUsd: eff }; }
function cashflowPnl(orders, positionsBySym, symsOfBook) { /* realized+unrealized from filled orders (flattened incl. legs) */
  let cash = 0, n = 0;
  for (const o of orders) { const q = +o.filled_qty || 0; if (!q) continue; const px = +o.filled_avg_price; cash += (o.side === 'buy' ? -1 : 1) * q * px; n++; }
  let mv = 0; for (const s of symsOfBook) { const p = positionsBySym[s]; if (p) mv += +p.market_value; }
  return { pnl: cash + mv, fills: n };
}
/* ---------- time ---------- */
const NYF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function ny(ms) { const p = {}; for (const x of NYF.formatToParts(new Date(ms))) p[x.type] = x.value; const date = `${p.year}-${p.month}-${p.day}`; const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second); return { date, offsetMs: asUtc - Math.floor(ms / 1000) * 1000 }; }
function nyToUtc(date, hhmm) { const [y, m, d] = date.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); const guess = Date.UTC(y, m - 1, d, h, mi); return guess - ny(guess).offsetMs; }
const ymd = d => d.replace(/-/g, '');

/* ---------- broker ---------- */
let calls = 0;
async function api(base, method, p, body, okStatuses = []) {
  if (base !== PAPER && base !== DATA) throw new Error('base not allowed');
  for (let a = 0; ; a++) {
    calls++; if (calls % 150 === 0) await sleep(15000);
    let r; try { r = await fetch(base + p, { method, headers: { 'APCA-API-KEY-ID': process.env.APCA_KEY, 'APCA-API-SECRET-KEY': process.env.APCA_SEC, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (a < 4) { await sleep(2000 * (a + 1)); continue; } throw e; }
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { raw: t.slice(0, 200) }; }
    if (r.ok || okStatuses.includes(r.status)) return { status: r.status, j };
    if ((r.status === 429 || r.status >= 500) && a < 5) { await sleep(3000 * (a + 1)); continue; }
    const e = new Error(`${method} ${p.split('?')[0]} -> ${r.status} ${(j && j.message) || ''}`); e.status = r.status; throw e;
  }
}
async function multiBars(syms, q) { const out = {}; for (let i = 0; i < syms.length; i += 200) { let tok = null; do { const qs = new URLSearchParams({ ...q, symbols: syms.slice(i, i + 200).join(','), limit: '10000' }); if (tok) qs.set('page_token', tok); const { j } = await api(DATA, 'GET', '/v2/stocks/bars?' + qs); for (const [s, b] of Object.entries(j.bars || {})) (out[s] = out[s] || []).push(...b); tok = j.next_page_token; } while (tok); } return out; }
const orders = [];
const SESSION = { closeMs: Infinity };
async function submit(o) {
  const rec = { at: new Date().toISOString(), ...o, sent: TRADING };
  if (!TRADING) { rec.result = 'dry-run'; orders.push(rec); say('DRY', o.client_order_id, o.side, o.qty, o.symbol, o.type, o.stop_price || ''); return null; }
  try { const { status, j } = await api(PAPER, 'POST', '/v2/orders', o, [422]);
    if (status === 422 && /client.?order.?id/i.test((j && j.message) || '')) { const g = await api(PAPER, 'GET', '/v2/orders:by_client_order_id?client_order_id=' + encodeURIComponent(o.client_order_id), null, [404]); if (g.status === 200) { rec.result = 'exists:' + g.j.status; rec.id = g.j.id; orders.push(rec); say('ORDER', o.client_order_id, rec.result); return g.j; } }
    rec.result = status === 422 ? 'rejected:' + (j && j.message) : j.status; rec.id = j && j.id; orders.push(rec); say('ORDER', o.client_order_id, rec.result); return status === 422 ? null : j; }
  catch (e) { rec.result = 'error:' + e.message; orders.push(rec); say('ORDER-ERR', o.client_order_id, e.message); return null; }
}

/* ---------- main ---------- */
async function main() {
  const t0 = clock.now(); const deadline = t0 + MAX_MIN * 60000;
  const rep = { version: VERSION, trading: TRADING, startedAt: new Date(t0).toISOString(), runId: process.env.GITHUB_RUN_ID || 'local', phases: {}, books: {} };
  const acct = (await api(PAPER, 'GET', '/v2/account')).j;
  if (!String(acct.account_number || '').startsWith(R.accountPrefix)) throw new Error('not a paper account');
  const today = ny(clock.now()).date; rep.date = today;
  if (process.env.X3_REPLAY_DATE) return replay(rep, process.env.X3_REPLAY_DATE);
  const simIgnoreWindow = !TRADING && process.env.X3_SIM_IGNORE_WINDOW === '1';
  if (!simIgnoreWindow && (today < R.start || today > R.end)) { say('outside test window', today); return finish(rep); }
  const cal = (await api(PAPER, 'GET', `/v2/calendar?start=${today}&end=${today}`)).j;
  if (!cal.length || cal[0].date !== today) { say('market closed today'); return finish(rep); }
  const openMs = nyToUtc(today, cal[0].open), closeMs = nyToUtc(today, cal[0].close); const lastDay = today === R.end;
  rep.open = new Date(openMs).toISOString(); rep.close = new Date(closeMs).toISOString(); SESSION.closeMs = closeMs;
  if (clock.now() > closeMs + 10 * 60000) { say('after close'); return finish(rep); }
  if (clock.now() < openMs - 200 * 60000) { say('too early'); return finish(rep); }
  const D = ymd(today); const pairSyms = new Set(PAIRS.pairs.flatMap(p => [p.a, p.b]));
  const halted = await bookStatus(rep, today);

  /* 1) stale intraday positions (missed flatten on an earlier day) -> close at the open */
  const todays = async () => (await api(PAPER, 'GET', `/v2/orders?status=all&after=${new Date(openMs - 12 * 3600e3).toISOString()}&limit=500&nested=true`)).j;
  const positions = async () => (await api(PAPER, 'GET', '/v2/positions')).j;

  /* 2) universe before the open */
  let U = null;
  if (clock.now() < openMs + R.orb.lastEntryMinAfterOpen * 60000) {
    U = await buildUniverse(today, openMs, pairSyms); rep.phases.universe = { n: U.rows.length, at: new Date().toISOString() };
  }
  /* 3) stale positions from earlier days are closed right after the open; decisions at open + 5 min */
  if (U) {
    await sleepUntil(openMs + 30000);
    await closeStale(await todays(), await positions(), pairSyms, D);
    await sleepUntil(openMs + 5 * 60000 + 15000);
    const already = (await todays()).filter(o => o.client_order_id.startsWith(`orb-${D}`) || o.client_order_id.startsWith(`fade-${D}`));
    if (already.length) say('decisions already made today by another run:', already.length);
    else if (clock.now() > openMs + R.orb.lastEntryMinAfterOpen * 60000) { say('too late for ORB/FADE today'); rep.phases.missed = true; }
    else {
      const bars = await multiBars(U.rows.map(r => r.sym), { timeframe: '5Min', start: new Date(openMs).toISOString(), end: new Date(openMs + 60000).toISOString(), feed: 'iex' });
      for (const r of U.rows) { const b = (bars[r.sym] || [])[0]; r.bar = b && Date.parse(b.t) === openMs ? b : null; }
      const live = new Set((await positions()).map(p => p.symbol)); const rows = U.rows.filter(r => !live.has(r.sym));
      const orb = halted.orb ? [] : orbPick(rows);
      const ex = new Set([...orb.map(x => x.sym), ...pairSyms, ...live]);
      const fade = halted.fade ? [] : fadePick(rows, ex);
      rep.phases.decisions = { at: new Date().toISOString(), withBar: U.rows.filter(r => r.bar).length, orb, fade };
      for (const x of orb) {
        const r1 = await submit({ symbol: x.sym, qty: String(x.qty), side: x.dir === 'long' ? 'buy' : 'sell', type: 'stop', stop_price: x.entry.toFixed(2), time_in_force: 'day', order_class: 'oto', stop_loss: { stop_price: x.stop.toFixed(2) }, client_order_id: `orb-${D}-${x.sym}` });
        const last = orders[orders.length - 1];
        if (!r1 && TRADING && /stop price must be (greater|less) than current price/.test(last.result || '')) { /* x3-1.2: the opening range already broke before 09:35:15 -> the stop entry would trigger at once: enter at market, stop 0.1 ATR from the latest price */
          const lt = (await api(DATA, 'GET', `/v2/stocks/trades/latest?symbols=${x.sym}&feed=iex`)).j.trades || {}; const px = lt[x.sym] && lt[x.sym].p;
          if (px) { const st = x.dir === 'long' ? dn2(px - R.orb.stopAtrFrac * x.atr) : up2(px + R.orb.stopAtrFrac * x.atr);
            await submit({ symbol: x.sym, qty: String(x.qty), side: x.dir === 'long' ? 'buy' : 'sell', type: 'market', time_in_force: 'day', order_class: 'oto', stop_loss: { stop_price: st.toFixed(2) }, client_order_id: `orbm-${D}-${x.sym}` }); }
        }
      }
      for (const x of fade) await submit({ symbol: x.sym, qty: String(x.qty), side: 'sell', type: 'market', time_in_force: 'day', order_class: 'oto', stop_loss: { stop_price: x.stop.toFixed(2) }, client_order_id: `fade-${D}-${x.sym}` });
    }
  }
  /* 4) stale positions: anything not a pair symbol and not opened today by orb/fade */
  if (clock.now() >= openMs) await closeStale(await todays(), await positions(), pairSyms, D);
  /* 5) wait for the pairs decision, cancel, flatten */
  const tPair = closeMs - R.pair.minBeforeClose * 60000, tCancel = closeMs - R.cancelMinBeforeClose * 60000, tFlat = closeMs - R.flattenMinBeforeClose * 60000;
  /* x3-1.1: protection loop until the pairs time (Alpaca cancelled one OTO stop leg at fill on 2026-10-27) */
  while (clock.now() < Math.min(tPair, deadline)) { if (clock.now() >= openMs) await protectPositions(D, pairSyms); await sleep(Math.min(60000, Math.max(0, Math.min(tPair, deadline) - clock.now()))); }
  if (deadline < tPair) { say('deadline before pairs time; next run continues'); return finish(rep); }
  if (clock.now() < tCancel) await doPairs(rep, D, lastDay || halted.pair, await positions(), halted.pair);
  if (deadline < tCancel) { await sleepUntil(deadline); return finish(rep); }
  await sleepUntil(tCancel);
  const tod = await todays();
  for (const o of tod) if (/^(orb|fade)-\d{8}-/.test(o.client_order_id) && ['new', 'accepted', 'held', 'pending_new', 'partially_filled'].includes(o.status) && TRADING) { try { await api(PAPER, 'DELETE', `/v2/orders/${o.id}`, null, [404, 422]); say('cancel entry', o.client_order_id); } catch (e) { say('cancel err', e.message); } }
  await sleepUntil(tFlat);
  await flattenIntraday(await todays(), await positions(), pairSyms, D);
  await sleep(60000);
  await bookStatus(rep, today);
  return finish(rep);
}
async function replay(rep, day) { /* pipeline check on a past session: never sends orders */
  if (TRADING) throw new Error('replay requires TRADING_ENABLED off');
  const openMs = nyToUtc(day, '09:30'); const pairSyms = new Set(PAIRS.pairs.flatMap(p => [p.a, p.b])); rep.replay = day;
  const U = await buildUniverse(day, openMs, pairSyms);
  const bars = await multiBars(U.rows.map(r => r.sym), { timeframe: '5Min', start: new Date(openMs).toISOString(), end: new Date(openMs + 60000).toISOString(), feed: 'iex' });
  for (const r of U.rows) { const b = (bars[r.sym] || [])[0]; r.bar = b && Date.parse(b.t) === openMs ? b : null; }
  const orb = orbPick(U.rows); const fade = fadePick(U.rows, new Set([...orb.map(x => x.sym), ...pairSyms]));
  rep.phases.decisions = { universe: U.rows.length, withBar: U.rows.filter(r => r.bar).length, orb, fade }; say('replay', day, 'orb', orb.length, 'fade', fade.length);
  await bookStatus(rep, day); return finish(rep);
}
async function sleepUntil(ms) { while (clock.now() < ms) await sleep(Math.min(30000, ms - clock.now())); }
async function buildUniverse(today, openMs, pairSyms) {
  const assets = (await api(PAPER, 'GET', '/v2/assets?status=active&asset_class=us_equity')).j;
  const A = {}; for (const a of assets) if (a.tradable && EXCH.has(a.exchange) && /^[A-Z]{1,5}$/.test(a.symbol) && !ETF_RE.test(a.name || '') && !pairSyms.has(a.symbol)) A[a.symbol] = a;
  const syms = Object.keys(A); say('assets', syms.length);
  const end = new Date(Math.min(clock.now() - 20 * 60000, nyToUtc(today, '00:00') - 1000)).toISOString(); /* previous sessions only */
  const start = new Date(openMs - 45 * 86400e3).toISOString();
  const db = await multiBars(syms, { timeframe: '1Day', start, end, adjustment: 'split', feed: 'sip' });
  const days = (await api(PAPER, 'GET', `/v2/calendar?start=${new Date(openMs - 30 * 86400e3).toISOString().slice(0, 10)}&end=${today}`)).j.filter(d => d.date < today).slice(-R.orb.lookback);
  const prevDay = days[days.length - 1].date;
  const rows = [];
  for (const s of syms) { const b = db[s]; if (!b || b[b.length - 1].t.slice(0, 10) !== prevDay) continue; const st = dailyStats(b); if (!st) continue;
    const okOrb = st.prevClose >= R.orb.minPrice && st.avgVol >= R.orb.minAvgVol && st.atr > R.orb.minAtr; const okFade = st.prevClose >= R.fade.minPrice && st.avgDollarVol >= R.fade.minDollarVol;
    if (okOrb || okFade) rows.push({ sym: s, st, shortable: !!(A[s].shortable && A[s].easy_to_borrow), hist: [] }); }
  say('liquid universe', rows.length);
  const list = rows.map(r => r.sym); const idx = Object.fromEntries(rows.map(r => [r.sym, r]));
  for (const d of days) { const o = nyToUtc(d.date, d.open); const hb = await multiBars(list, { timeframe: '5Min', start: new Date(o).toISOString(), end: new Date(o + 60000).toISOString(), feed: 'iex' });
    for (const [s, b] of Object.entries(hb)) if (b[0] && Date.parse(b[0].t) === o) idx[s].hist.push(b[0].v); }
  return { rows };
}
async function bookOf(sym) { /* book of the latest orb/fade entry on this symbol */
  const o = (await api(PAPER, 'GET', `/v2/orders?status=all&symbols=${sym}&limit=100&direction=desc&after=${R.start}T00:00:00Z`)).j.find(x => /^(orb|fade)-\d{8}-/.test(x.client_order_id));
  return o ? o.client_order_id.split('-')[0] : 'other';
}
async function protectPositions(D, pairSyms) { /* x3-1.1: every open ORB/FADE position must have a broker stop; if the price is already beyond the planned stop, close */
  try {
    const pos = (await api(PAPER, 'GET', '/v2/positions')).j; const opn = (await api(PAPER, 'GET', '/v2/orders?status=open&limit=500&nested=false')).j;
    const need = pos.filter(p => !pairSyms.has(p.symbol) && !opn.some(o => o.symbol === p.symbol && /stop/.test(o.type) && o.side === (+p.qty > 0 ? 'sell' : 'buy')));
    if (!need.length) return;
    const tod = (await api(PAPER, 'GET', `/v2/orders?status=all&after=${new Date(clock.now() - 16 * 3600e3).toISOString()}&limit=500&nested=true`)).j;
    const lt = (await api(DATA, 'GET', `/v2/stocks/trades/latest?symbols=${need.map(p => p.symbol).join(',')}&feed=iex`)).j.trades || {};
    const toClose = [];
    for (const p of need) {
      const e = tod.find(o => o.symbol === p.symbol && [`orbm-${D}-${p.symbol}`, `orb-${D}-${p.symbol}`, `fade-${D}-${p.symbol}`].includes(o.client_order_id) && +o.filled_qty > 0);
      const stop = e && e.legs && e.legs[0] ? +e.legs[0].stop_price : null; const px = lt[p.symbol] && lt[p.symbol].p;
      if (!e || !stop || !px) { say('PROTECT cannot resolve', p.symbol, !!e, stop, px); continue; }
      const book = e.client_order_id.split('-')[0].replace('orbm', 'orb'); const n = 1 + tod.filter(o => o.client_order_id.startsWith(`${book}p-${D}-${p.symbol}`)).length; const cid = `${book}p-${D}-${p.symbol}-${n}`;
      const beyond = +p.qty > 0 ? px <= stop : px >= stop;
      say('PROTECT', p.symbol, p.qty, 'px', px, 'stop', stop, beyond ? 'close' : 'stop');
      if (beyond) toClose.push({ p, cid }); else await submit({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: +p.qty > 0 ? 'sell' : 'buy', type: 'stop', stop_price: stop.toFixed(2), time_in_force: 'day', client_order_id: cid });
    }
    if (toClose.length) await closeMany(toClose);
  } catch (err) { say('PROTECT error', err.message); }
}
async function closeStale(tod, pos, pairSyms, D) {
  const mine = new Set(tod.filter(o => o.client_order_id.startsWith(`orb-${D}`) || o.client_order_id.startsWith(`fade-${D}`)).map(o => o.symbol));
  const list = []; for (const p of pos) if (!pairSyms.has(p.symbol) && !mine.has(p.symbol)) { const b = await bookOf(p.symbol); say('STALE position', p.symbol, p.qty, b); list.push({ p, cid: `${b}s-${D}-${p.symbol}` }); }
  await closeMany(list);
}
const OPEN_ST = s => !['filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'].includes(s);
async function cancelSymbolOrders(sym) {
  for (let k = 0; k < 5; k++) {
    const a = (await api(PAPER, 'GET', `/v2/orders?status=open&symbols=${sym}&nested=false&limit=500`)).j, b = (await api(PAPER, 'GET', `/v2/orders?status=open&symbols=${sym}&nested=true&limit=500`)).j;
    const ids = new Set(); for (const o of [...a, ...b]) for (const x of [o, ...(o.legs || [])]) if (OPEN_ST(x.status)) ids.add(x.id);
    if (!ids.size) return true;
    for (const id of ids) { try { await api(PAPER, 'DELETE', `/v2/orders/${id}`, null, [404, 422]); } catch (e) { say('cancel err', e.message); } }
    await sleep(2000);
  }
  say('could not clear open orders for', sym); return false;
}
async function closeMany(list) { /* cancel protective orders, close at market, verify, retry up to 3 times */
  for (let k = 1; k <= 3 && list.length; k++) {
    if (clock.now() > SESSION.closeMs - 30000) { say('session ending; positions left for the next open:', list.map(x => x.p.symbol).join(',')); return; }
    for (const { p, cid } of list) { if (TRADING) await cancelSymbolOrders(p.symbol); await submit({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: +p.qty > 0 ? 'sell' : 'buy', type: 'market', time_in_force: 'day', client_order_id: k === 1 ? cid : `${cid}-r${k}` }); }
    if (!TRADING) return;
    await sleep(20000);
    const pos = Object.fromEntries((await api(PAPER, 'GET', '/v2/positions')).j.map(p => [p.symbol, p]));
    list = list.filter(x => pos[x.p.symbol]).map(x => ({ p: pos[x.p.symbol], cid: x.cid }));
    if (list.length) say('still open after close attempt', k, list.map(x => x.p.symbol).join(','));
  }
}
async function flattenIntraday(tod, pos, pairSyms, D) {
  const list = []; for (const p of pos) if (!pairSyms.has(p.symbol)) { const t = tod.find(o => o.symbol === p.symbol && /^(orb|fade)-/.test(o.client_order_id)); const b = t ? t.client_order_id.split('-')[0] : await bookOf(p.symbol); list.push({ p, cid: `${b}x-${D}-${p.symbol}` }); }
  await closeMany(list);
}
async function doPairs(rep, D, closeAll, pos, halted) {
  const P = Object.fromEntries(pos.map(p => [p.symbol, +p.qty]));
  const syms = [...new Set(PAIRS.pairs.flatMap(p => [p.a, p.b]))];
  const lt = (await api(DATA, 'GET', `/v2/stocks/trades/latest?symbols=${syms.join(',')}&feed=iex`)).j.trades || {};
  const acts = [];
  for (const p of PAIRS.pairs) {
    const pa = lt[p.a] && lt[p.a].p, pb = lt[p.b] && lt[p.b].p; if (!pa || !pb) { acts.push({ pair: p.a + '/' + p.b, act: 'no-price' }); continue; }
    let a = pairAction(p, pa, pb, P[p.a] || 0, P[p.b] || 0, R.pair.kSigma, closeAll);
    if (halted && a.act === 'open') a = { act: 'none', spread: a.spread, why: 'book halted' };
    acts.push({ pair: p.a + '/' + p.b, pa, pb, ...a, sigma: p.sigma });
    if (a.act === 'open') { const q = pairQty(pa, pb); const qs = a.shortSym === p.a ? q.qa : q.qb, ql = a.longSym === p.a ? q.qa : q.qb;
      const s1 = await submit({ symbol: a.shortSym, qty: String(qs), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: `pair-${D}-o-${a.shortSym}` });
      if (s1 || !TRADING) await submit({ symbol: a.longSym, qty: String(ql), side: 'buy', type: 'market', time_in_force: 'day', client_order_id: `pair-${D}-o-${a.longSym}` }); }
    if (a.act === 'close' || a.act === 'repair') for (const s of [p.a, p.b]) if (P[s]) await submit({ symbol: s, qty: String(Math.abs(P[s])), side: P[s] > 0 ? 'sell' : 'buy', type: 'market', time_in_force: 'day', client_order_id: `pair-${D}-c-${s}` });
  }
  rep.phases.pairs = { at: new Date().toISOString(), acts };
}
async function bookStatus(rep, today) {
  const all = []; let until = null;
  for (let i = 0; i < 40; i++) { const q = new URLSearchParams({ status: 'closed', after: R.start + 'T00:00:00Z', limit: '500', nested: 'true', direction: 'desc' }); if (until) q.set('until', until); const b = (await api(PAPER, 'GET', '/v2/orders?' + q)).j; all.push(...b); if (b.length < 500) break; until = b[b.length - 1].submitted_at; }
  const flat = []; const seen = new Set(); for (const o of all) for (const x of [o, ...(o.legs || [])]) if (!seen.has(x.id)) { seen.add(x.id); flat.push({ ...x, book: (/^(orb|fade|pair)/.exec(o.client_order_id) || [])[1] || 'other' }); }
  const pos = (await api(PAPER, 'GET', '/v2/positions')).j; const PB = Object.fromEntries(pos.map(p => [p.symbol, p]));
  const pairSyms = new Set(PAIRS.pairs.flatMap(p => [p.a, p.b])); const halted = {};
  const owner = {}; for (const o of [...flat].sort((x, y) => (x.filled_at || '') < (y.filled_at || '') ? -1 : 1)) if (+o.filled_qty && /^(orb|fade)$/.test(o.book)) owner[o.symbol] = o.book;
  for (const b of ['orb', 'fade', 'pair']) { const os = flat.filter(o => o.book === b); const syms = b === 'pair' ? [...pairSyms] : Object.keys(owner).filter(s => owner[s] === b && !pairSyms.has(s));
    const r = cashflowPnl(os, PB, syms); halted[b] = r.pnl <= -R.killLossUsd; rep.books[b] = { ...r, halted: halted[b], at: new Date().toISOString() }; }
  say('books', JSON.stringify(rep.books)); return halted;
}
function finish(rep) {
  rep.orders = orders; rep.log = log; rep.calls = calls; rep.endedAt = new Date().toISOString();
  const dir = path.join(__dirname, 'reports'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rep.date || 'nodate'}-${rep.runId}.json`), JSON.stringify(rep, null, 1));
  say('done');
}
module.exports = { main, clock, orders, dailyStats, orbPick, fadePick, pairAction, pairQty, cashflowPnl, nyToUtc, ny, up2, dn2, R, buildUniverse, multiBars, api, PAIRS, DATA, PAPER };
if (require.main === module) main().catch(e => { say('FATAL', e.message); try { finish({ version: VERSION, fatal: e.message, runId: process.env.GITHUB_RUN_ID || 'local', date: ny(clock.now()).date, books: {} }); } catch (_) {} process.exitCode = 1; });
