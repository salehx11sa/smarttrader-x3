'use strict';
const assert = require('assert'); const X = require('./x3.cjs');
// time: DST transitions
assert.strictEqual(new Date(X.nyToUtc('2026-10-26', '09:30')).toISOString(), '2026-10-26T13:30:00.000Z');
assert.strictEqual(new Date(X.nyToUtc('2026-11-02', '09:30')).toISOString(), '2026-11-02T14:30:00.000Z');
assert.strictEqual(new Date(X.nyToUtc('2026-11-27', '13:00')).toISOString(), '2026-11-27T18:00:00.000Z');
// rounding
assert.strictEqual(X.up2(10.001), 10.01); assert.strictEqual(X.dn2(10.009), 10); assert.strictEqual(X.up2(10.1), 10.1);
// dailyStats
const bars = []; for (let i = 0; i < 25; i++) bars.push({ o: 10, h: 11, l: 9, c: 10, v: 2e6 });
const st = X.dailyStats(bars); assert.strictEqual(st.atr, 2); assert.strictEqual(st.avgVol, 2e6); assert.strictEqual(st.prevClose, 10); assert.strictEqual(st.sigma, 0);
assert.strictEqual(X.dailyStats(bars.slice(0, 20)), null);
// orbPick
const mk = (sym, o, c, v, sh = true) => ({ sym, st: { atr: 2, avgVol: 2e6, avgDollarVol: 5e7, prevClose: 20, sigma: 0.02 }, bar: { o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c, v }, hist: Array(14).fill(1000), shortable: sh });
let p = X.orbPick([mk('AAA', 20, 21, 5000), mk('BBB', 20, 19, 3000), mk('CCC', 20, 20, 9000), mk('DDD', 20, 19, 8000, false), mk('EEE', 20, 21, 500)]);
assert.deepStrictEqual(p.map(x => x.sym + ':' + x.dir), ['AAA:long', 'BBB:short']);
assert.strictEqual(p[0].entry, 21.1); assert.strictEqual(p[0].stop, 20.9); assert.strictEqual(p[0].qty, Math.floor(Math.min(300 / 0.2, 6000 / 21.1)));
assert.strictEqual(p[1].entry, 18.9); assert.strictEqual(p[1].stop, 19.1);
// fadePick
const f = X.fadePick([mk('AAA', 21.5, 21, 1), mk('BBB', 21.5, 21, 1, false), mk('CCC', 20.5, 20, 1), mk('DDD', 22, 21, 1)], new Set(['DDD']));
assert.deepStrictEqual(f.map(x => x.sym), ['AAA']); assert.strictEqual(f[0].stop, 22); assert.strictEqual(f[0].qty, Math.floor(Math.min(300 / 1, 6000 / 21)));
// pairAction
const pr = { a: 'A', b: 'B', base_a: 100, base_b: 50, sigma: 0.04 };
assert.strictEqual(X.pairAction(pr, 110, 50, 0, 0).act, 'open'); assert.strictEqual(X.pairAction(pr, 110, 50, 0, 0).shortSym, 'A');
assert.strictEqual(X.pairAction(pr, 90, 50, 0, 0).shortSym, 'B');
assert.strictEqual(X.pairAction(pr, 103, 50, 0, 0).act, 'none');
assert.strictEqual(X.pairAction(pr, 103, 50, -10, 20).act, 'hold');
assert.strictEqual(X.pairAction(pr, 99, 50, -10, 20).act, 'close');
assert.strictEqual(X.pairAction(pr, 101, 50, 10, -20).act, 'close');
assert.strictEqual(X.pairAction(pr, 103, 50, -10, 0).act, 'repair');
assert.strictEqual(X.pairAction(pr, 110, 50, -10, 20, 2, true).act, 'close');
assert.strictEqual(X.pairAction(pr, 110, 50, 0, 0, 2, true).act, 'none');
// pairQty
assert.deepStrictEqual(X.pairQty(3800, 230), { qa: 1, qb: 17, legUsd: 3800 }); assert.deepStrictEqual(X.pairQty(100, 50), { qa: 15, qb: 30, legUsd: 1500 });
// cashflowPnl
const r = X.cashflowPnl([{ side: 'sell', filled_qty: '10', filled_avg_price: '20' }, { side: 'buy', filled_qty: '10', filled_avg_price: '19' }, { side: 'buy', filled_qty: '0' }], { Z: { market_value: '-5' } }, ['Z']);
assert.strictEqual(r.pnl, 5); assert.strictEqual(r.fills, 2);
// pairs file
assert.strictEqual(X.PAIRS.pairs.length, 10); const all = X.PAIRS.pairs.flatMap(p => [p.a, p.b]); assert.strictEqual(new Set(all).size, 20);
console.log('ALL TESTS PASS');
