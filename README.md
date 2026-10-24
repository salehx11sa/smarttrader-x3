# smarttrader-x3

SmartTrader X3: a pre-registered forward **paper** test of three day-trading methods (ORB stocks-in-play, gap-fade shorts, distance pairs), 2026-10-26 → 2026-12-18. Alpaca paper account only. No real money.

- `x3.cjs`: runner (stateless; orders only if repo variable `TRADING_ENABLED=true`)
- `pairs.json`: frozen pairs (formation ending 2026-10-23)
- `PREREG-X3.md`: rules and judging criteria (Arabic)
- `reports/`: one JSON per run
- Secrets required: `APCA_KEY`, `APCA_SEC` (paper keys)
