# Présidentielle 2027 · les chances

Static site turning 2027 French presidential polls into calibrated probabilities (who reaches the
second round, who wins), plus « Mon vote », a tool comparing the effect of each first-round vote
given your own preferences. Everything runs in the visitor's browser; no data is collected.

Methodology (in French, for the public): `site/methode.html`.

## Pipeline

```
uv run pipeline/fetch.py      # polls: MieuxVoter (MIT) + Sondax (CC-BY-SA) → data/polls.csv
uv run pipeline/backtest.py   # fit + leave-one-election-out validation on 1995–2022 → data/error_params.json
uv run pipeline/model.py      # averages, 10 000 simulations per scenario → site/data/
node tests/vote-logic.test.mjs
uv run pipeline/blackout.py   # legal blackout guard (loi 77-808): no build on the eve and day of each round
```

`.github/workflows/daily.yml` runs fetch → model → tests daily, commits the published data
(legal record) and deploys `site/` to GitHub Pages, except during the blackout windows.

## Data

- 2027 polls: [MieuxVoter/presidentielle2027](https://github.com/MieuxVoter/presidentielle2027), [Sondax](https://sondax.fr).
- History: `data/hist_polls.csv` (Wikipedia poll tables 1995–2017, [NSPPolls](https://github.com/nsppolls/nsppolls) 2022),
  `data/results_history.csv` (official results 1965–2022), `data/jw_france_r1.csv`
  (extract of Jennings & Wlezien, doi:10.7910/DVN/8421DX). `pipeline/history.py` rebuilds the first two.
- Editorial choices: `data/lineups.toml` (reference line-up), `data/blocs.csv` (political blocs, used only for tests).
