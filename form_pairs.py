#!/usr/bin/env python3
"""X3 pairs formation (Gatev-Goetzmann-Rouwenhorst distance method), frozen before 2026-10-26.
Usage: python3 -I form_pairs.py <gapdata_dir> <out_dir>   (keys from env APCA_KEY/APCA_SEC)"""
import os, sys, json, gzip, glob, re, math, time, urllib.request, urllib.parse, itertools, statistics as st
GD, OUT = sys.argv[1], sys.argv[2]
K, S = os.environ['APCA_KEY'], os.environ['APCA_SEC']
H = {'APCA-API-KEY-ID': K, 'APCA-API-SECRET-KEY': S}
def get(url):
    for a in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60) as r: return json.load(r)
        except Exception as e:
            if a == 4: raise
            time.sleep(2 + 3 * a)
ETF_RE = re.compile(r'\b(ETF|ETN|Fund|Trust|iShares|SPDR|ProShares|Direxion|Invesco|Vanguard|Index|Portfolio|Shares|Notes?|Warrants?|Units?|Rights?|Preferred|Depositary)\b', re.I)
uni = {u['symbol']: u for u in json.load(open(os.path.join(GD, 'universe.json'))) if u['status'] == 'active'}
# 1) liquidity ranking from frozen local daily data (to 2026-10-22)
rank = []
for f in sorted(glob.glob(os.path.join(GD, 'daily', '*.json.gz'))):
    d = json.load(gzip.open(f, 'rt'))
    for sym, bars in d.items():
        if sym not in uni or not re.fullmatch(r'[A-Z]{1,5}', sym) or ETF_RE.search(uni[sym]['name'] or ''): continue
        if len(bars) < 300: continue
        last = bars[-60:]
        if last[-1][0] < '2026-10-21': continue
        px = last[-1][4]
        if px < 10: continue
        dv = sum(b[4] * b[5] for b in last) / len(last)
        rank.append((dv, sym))
rank.sort(reverse=True); top = [s for _, s in rank[:150]]
print('ranked', len(rank), 'top150 min $vol', round(rank[149][0] / 1e6, 1), 'M')
# 2) shortable / easy-to-borrow now
assets = {a['symbol']: a for a in get('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity')}
top = [s for s in top if assets.get(s, {}).get('shortable') and assets.get(s, {}).get('easy_to_borrow') and assets[s].get('tradable')]
print('after ETB', len(top))
# 3) fresh daily bars (adjustment=all for formation, raw close on 2026-10-23 for trading base)
def bars(syms, adj):
    out = {}; tok = None
    while True:
        q = {'symbols': ','.join(syms), 'timeframe': '1Day', 'start': '2025-09-01', 'end': '2026-10-23T21:00:00Z', 'adjustment': adj, 'feed': 'sip', 'limit': 10000}
        if tok: q['page_token'] = tok
        j = get('https://data.alpaca.markets/v2/stocks/bars?' + urllib.parse.urlencode(q))
        for s, b in (j.get('bars') or {}).items(): out.setdefault(s, []).extend(b)
        tok = j.get('next_page_token')
        if not tok: return out
A, R = {}, {}
for i in range(0, len(top), 50):
    A.update(bars(top[i:i + 50], 'all')); R.update(bars(top[i:i + 50], 'raw')); time.sleep(0.5)
cal = sorted({b['t'][:10] for b in A['AAPL']})
assert cal[-1] == '2026-10-23', cal[-1]
form = cal[-252:]
series = {}
for s in top:
    m = {b['t'][:10]: b['c'] for b in A.get(s, [])}
    if all(d in m for d in form) and R.get(s) and R[s][-1]['t'][:10] == '2026-10-23':
        p0 = m[form[0]]; series[s] = [m[d] / p0 for d in form]
syms = sorted(series); print('with full 252d', len(syms))
first = lambda s: re.split(r'[\s,.]+', (uni.get(s, {}).get('name') or assets[s]['name']).strip())[0].lower()
cands = []
for a, b in itertools.combinations(syms, 2):
    if first(a) == first(b): continue
    sa, sb = series[a], series[b]
    ssd = sum((x - y) ** 2 for x, y in zip(sa, sb))
    cands.append((ssd, a, b))
cands.sort(); used = set(); pairs = []
for ssd, a, b in cands:
    if a in used or b in used: continue
    spread = [x - y for x, y in zip(series[a], series[b])]
    pairs.append({'a': a, 'b': b, 'ssd': round(ssd, 6), 'sigma': round(st.pstdev(spread), 6),
                  'base_a': R[a][-1]['c'], 'base_b': R[b][-1]['c'], 'name_a': assets[a]['name'], 'name_b': assets[b]['name']})
    used |= {a, b}
    if len(pairs) == 10: break
os.makedirs(OUT, exist_ok=True)
res = {'method': 'Gatev distance: 252d formation ending 2026-10-23, normalized adj close, min SSD, disjoint greedy top 10',
       'formation': [form[0], form[-1]], 'universe_n': len(syms), 'open_k_sigma': 2.0, 'base_date': '2026-10-23', 'pairs': pairs}
json.dump(res, open(os.path.join(OUT, 'pairs.json'), 'w'), indent=1, ensure_ascii=False)
for p in pairs: print(p['a'], p['b'], p['ssd'], p['sigma'], '|', p['name_a'][:30], '/', p['name_b'][:30])
