"""Daily forecast: poll averages → R2 strengths → Monte Carlo → site/data/.

R2 for unpolled pairs: Bradley–Terry strengths, logit r_AB = s_A − s_B, least squares on polled pairs.
Candidates never polled in R2 borrow a neighbour's strength (R2_PROXY) with extra model error.
"""

import hashlib
import json
import sys
import tomllib
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from aggregate import R1_WINDOW_DAYS, pollsters_testing, r1_average, r2_averages, tested_counts
from blackout import WINDOWS as BLACKOUT
from simulate import ErrorParams, draw_r1, draw_r2, outcomes, sigma

ROOT = Path(__file__).resolve().parent.parent
POLLS = ROOT / "data" / "polls.csv"
LINEUPS = ROOT / "data" / "lineups.toml"
PARAMS = ROOT / "data" / "error_params.json"
BACKTEST = ROOT / "site" / "data" / "backtest.json"
OUT = ROOT / "site" / "data"
R1_DATE = pd.Timestamp("2027-04-18")
R2_DATE = pd.Timestamp("2027-05-02")
N_DRAWS = 10_000
REGISTERED = 49_000_000  # ponytail: 2022 figures held fixed; update with the 2027 electoral roll
TURNOUT_EXPRESSED_R1, TURNOUT_EXPRESSED_R2 = 0.72, 0.63
MODEL_SD_FLOOR = 0.15  # logit; error of a strength-model estimate for an unpolled pair
PROXY_EXTRA_SD = 0.4  # logit; extra error when a candidate's strength is borrowed
# Candidates never polled in R2: (neighbour whose strength is borrowed, offset in logit). Judgement; they
# reach R2 in well under 1% of simulations, so this barely moves headline numbers.
RN = "rn"  # in R2_PROXY: whichever RN candidate the scenario has (Le Pen or Bardella)
R2_PROXY = {
    "arthaud": ("melenchon", 0.0),
    "roussel": ("melenchon", 0.2),
    "tondelier": ("glucksmann", 0.0),
    "dupont-aignan": ("retailleau", -0.3),
    "zemmour": (RN, -0.5),
    "lisnard": ("retailleau", 0.0),
    "hollande": ("glucksmann", 0.0),
    "faure": ("glucksmann", 0.0),
}
QUANTILES = [0.05, 0.1, 0.5, 0.9, 0.95]
MIN_LINEUP_POLLSTERS = 3  # an alternative line-up is offered only if this many pollsters tested it recently
MIN_DELTA_POLLS = 3  # the Bardella scenario needs this many polls that tested both Le Pen and Bardella
HISTORY_START = pd.Timestamp("2026-07-15")  # first date of the history chart (day after the appeal ruling)
POLL_LOGIT_SD = 0.065  # sampling sd of one R2 poll in logit (n ≈ 1000)


def load_params() -> tuple[ErrorParams, ErrorParams, dict]:
    raw = json.loads(PARAMS.read_text())
    return ErrorParams(**raw["r1"]), ErrorParams(**raw["r2"]), raw["r2_rn_bias"]


def fit_strengths(pairs: pd.DataFrame, cands: list[str]) -> tuple[pd.Series, float]:
    """Least-squares strengths (anchored at mean 0) and leave-one-pair-out RMSE."""

    def solve(rows: pd.DataFrame) -> pd.Series:
        known = sorted(set(rows.a) | set(rows.b))
        x = np.zeros((len(rows) + 1, len(known)))
        for i, (a, b) in enumerate(zip(rows.a, rows.b)):
            x[i, known.index(a)], x[i, known.index(b)] = 1, -1
        x[-1, :] = 1  # anchor
        sol = np.linalg.lstsq(x, np.append(rows.logit_a.to_numpy(), 0), rcond=None)[0]
        return pd.Series(sol, index=known)

    # all polled pairs (not only this line-up): proxies may borrow a non-running neighbour's strength
    s = solve(pairs)
    errs = []
    for i in range(len(pairs)):
        rest = pairs.drop(pairs.index[i])
        a, b = pairs.a.iloc[i], pairs.b.iloc[i]
        if len(rest) and {a, b} <= set(rest.a) | set(rest.b):
            si = solve(rest)
            errs.append(si[a] - si[b] - pairs.logit_a.iloc[i])
    rmse = float(np.sqrt(np.mean(np.square(errs)))) if errs else MODEL_SD_FLOOR
    return s, max(rmse, MODEL_SD_FLOOR)


def r2_inputs(polled: pd.DataFrame, cands: list[str]) -> pd.DataFrame:
    """One row per pair of scenario candidates (i < j): mu (logit share of i), model_sd, polled flag.
    `polled` holds the head-to-head averages of the scenario (already transformed for a derived scenario), with
    `extra_sd` > 0 for pairs derived from another candidate's polls."""
    flip = polled.a > polled.b
    polled = polled.copy()
    polled.loc[flip, ["a", "b"]] = polled.loc[flip, ["b", "a"]].to_numpy()
    polled.loc[flip, "logit_a"] *= -1
    strengths, model_sd = fit_strengths(polled, cands)
    rn = next((c for c in cands if c in ("le-pen", "bardella")), "le-pen")
    extra = {}
    for c in cands:
        if c not in strengths:
            neighbour, offset = R2_PROXY[c]
            strengths[c], extra[c] = strengths[rn if neighbour == RN else neighbour] + offset, PROXY_EXTRA_SD
    poll_map = {(a, b): r for a, b, r in zip(polled.a, polled.b, polled.itertuples())}
    rows = []
    for i, a in enumerate(cands):
        for j in range(i + 1, len(cands)):
            b = cands[j]
            key, sign = ((a, b), 1) if a < b else ((b, a), -1)
            model_mu = strengths[a] - strengths[b]
            msd = float(np.hypot(model_sd, np.hypot(extra.get(a, 0), extra.get(b, 0))))
            if key in poll_map:
                r = poll_map[key]
                var_poll = POLL_LOGIT_SD**2 / r.n_eff + r.extra_sd**2
                mu = (sign * r.logit_a / var_poll + model_mu / msd**2) / (1 / var_poll + 1 / msd**2)
                rows.append(
                    {"i": i, "j": j, "mu": mu, "model_sd": float(r.extra_sd), "polled": bool(r.extra_sd == 0)}
                )
            else:
                rows.append({"i": i, "j": j, "mu": model_mu, "model_sd": msd, "polled": False})
    return pd.DataFrame(rows)


def bardella_r2_delta(r2: pd.DataFrame) -> tuple[float, float, int]:
    """Mean and s.e. of logit(Bardella vs X) − logit(Le Pen vs X), same poll and opponent; number of pairs."""
    hyp = r2.groupby("hyp").agg(
        cands=("candidate", frozenset), pollster=("pollster", "first"), end=("end", "first")
    )
    share = r2.set_index(["hyp", "candidate"]).share
    deltas = []
    for _, g in hyp.groupby(["pollster", "end"]):
        for h_b, cb in g.cands.items():
            if "bardella" not in cb or len(cb) != 2:
                continue
            (x,) = cb - {"bardella"}
            match = g.index[g.cands == frozenset({"le-pen", x})]
            if len(match):
                deltas.append(
                    np.log(share[h_b, "bardella"] / share[h_b, x])
                    - np.log(share[match[0], "le-pen"] / share[match[0], x])
                )
    if len(deltas) < 2:
        raise ValueError(
            f"only {len(deltas)} R2 polls tested both Le Pen and Bardella against the same opponent"
        )
    d = np.array(deltas)
    return float(d.mean()), float(d.std(ddof=1) / np.sqrt(len(d))), len(d)


def bardella_r1_delta(r1: pd.DataFrame) -> tuple[pd.Series, pd.Series, int]:
    """Mean and s.e. of log-share changes when Bardella replaces Le Pen in an otherwise identical hypothesis
    of the same poll; number of such pairs."""
    lineups = r1.groupby("hyp").candidate.agg(frozenset)
    meta = r1.drop_duplicates("hyp").set_index("hyp")[["pollster", "end"]].assign(lineup=lineups)
    deltas = []
    for _, g in meta.groupby(["pollster", "end"]):
        for h_b, lu_b in g.lineup.items():
            if "bardella" not in lu_b:
                continue
            match = g.index[g.lineup == (lu_b - {"bardella"}) | {"le-pen"}]
            if len(match):
                pb = r1[r1.hyp == h_b].set_index("candidate").share
                pl = r1[r1.hyp == match[0]].set_index("candidate").share.rename({"le-pen": "bardella"})
                deltas.append(np.log(pb) - np.log(pl))
    if len(deltas) < MIN_DELTA_POLLS:
        raise ValueError(f"only {len(deltas)} R1 polls tested both Le Pen and Bardella in the same line-up")
    d = pd.DataFrame(deltas)
    return d.mean(), d.std() / np.sqrt(d.count()), len(d)


def as_bardella(polled: pd.DataFrame, delta: float, se: float) -> pd.DataFrame:
    """Le Pen head-to-heads turned into Bardella ones: rename, shift by the measured gap, carry its uncertainty.
    Real Bardella duels polled in the window take precedence over derived ones."""
    real = set(
        map(frozenset, polled.loc[(polled.a == "bardella") | (polled.b == "bardella"), ["a", "b"]].to_numpy())
    )
    out = polled[(polled.a != "bardella") & (polled.b != "bardella")].copy()
    lp_a, lp_b = out.a == "le-pen", out.b == "le-pen"
    out.loc[lp_a, "logit_a"] += delta
    out.loc[lp_b, "logit_a"] -= delta
    out.loc[lp_a | lp_b, "extra_sd"] = se
    out = out.replace({"a": {"le-pen": "bardella"}, "b": {"le-pen": "bardella"}})
    derived = out[[frozenset((a, b)) not in real for a, b in zip(out.a, out.b)]]
    return pd.concat(
        [derived, polled[(polled.a == "bardella") | (polled.b == "bardella")]], ignore_index=True
    )


def lineup_id(lineup: list[str]) -> str:
    """Identity of a line-up = its candidates (not a difference from the reference): same id whatever the
    reference list, so the history of a line-up never mixes two different fields."""
    return "lu-" + hashlib.sha1(",".join(sorted(lineup)).encode()).hexdigest()[:8]


def lineup_label(lineup: list[str], reference: list[str], names: dict[str, str]) -> str:
    """Short label vs the reference, surnames only: 'avec Hollande, sans Glucksmann, sans Attal'."""
    surname = lambda c: names.get(c, c).split(" ", 1)[-1]  # 'Marine Le Pen' -> 'Le Pen'
    return ", ".join(
        [f"avec {surname(c)}" for c in lineup if c not in reference]
        + [f"sans {surname(c)}" for c in reference if c not in lineup]
    )


def tested_lineups(r1: pd.DataFrame, reference: list[str], asof: pd.Timestamp) -> list[list[str]]:
    """Line-ups (sets of major candidates) tested by ≥ MIN_LINEUP_POLLSTERS pollsters recently, the reference
    first. Minor reference candidates are kept in every line-up."""
    major, counts = tested_counts(r1, asof)
    minors = [c for c in reference if c not in major]
    ref_major = frozenset(set(reference) & major)
    others = [
        m
        for m, n in sorted(counts.items(), key=lambda kv: -kv[1])
        if n >= MIN_LINEUP_POLLSTERS and m != ref_major
    ]
    return [reference] + [sorted(m) + minors for m in others]


def reference_lineup() -> list[str]:
    return tomllib.loads(LINEUPS.read_text())["lepen"]["candidates"]


def candidate_names(polls: pd.DataFrame) -> dict[str, str]:
    return polls.dropna(subset=["name"]).drop_duplicates("candidate").set_index("candidate").name.to_dict()


def build_scenarios(
    polls: pd.DataFrame,
    reference: list[str],
    asof: pd.Timestamp,
    names: dict[str, str],
    only: list[list[str]] | None = None,
    bardella: bool = True,
) -> list[dict]:
    """Every scenario for one date, from the polls published by then (no look-ahead).
    A scenario = an RN candidate × a line-up: each tested line-up with Le Pen (or the given `only` line-ups, for
    the history backfill), plus Bardella on the reference line-up, derived from Le Pen's polls (R1 and R2)
    shifted by the gap measured in polls that tested both."""
    polls = polls[pd.to_datetime(polls.end) <= asof]
    r1, r2 = polls[polls["round"] == 1], polls[polls["round"] == 2]
    d1 = (R1_DATE - asof).days
    polled = r2_averages(r2, asof, (R2_DATE - asof).days).assign(extra_sd=0.0)
    out = []
    for lineup in only if only is not None else tested_lineups(r1, reference, asof):
        avg = r1_average(r1, lineup, asof, d1)
        if avg.polls.empty:
            continue
        is_ref = sorted(lineup) == sorted(reference)
        out.append(
            {
                "key": lineup_id(lineup),
                "rn": "lepen",
                "lineup": lineup,
                "reference": is_ref,
                "avg": avg,
                "extra_sd": None,
                "polled": polled,
                "n_pollsters": pollsters_testing(r1, lineup, asof),
                "delta_polls": None,
                "label": "Liste de référence" if is_ref else lineup_label(lineup, reference, names),
            }
        )
    if bardella:
        delta1, se1, n1 = bardella_r1_delta(r1)
        delta2, se2, _ = bardella_r2_delta(r2)
        avg = r1_average(r1, reference, asof, d1)
        shares = avg.shares.rename({"le-pen": "bardella"})
        log_b = np.log(shares) + delta1.reindex(shares.index).fillna(0)
        shares_b = (100 * np.exp(log_b) / np.exp(log_b).sum()).sort_values(ascending=False)
        out.append(
            {
                "key": "bd-" + lineup_id(reference),
                "rn": "bardella",
                "lineup": [c if c != "le-pen" else "bardella" for c in reference],
                "reference": True,
                "avg": type(avg)(shares_b, avg.d_eff, avg.polls),
                "extra_sd": se1.reindex(shares_b.index).fillna(0).to_numpy(),
                "polled": as_bardella(polled, delta2, se2),
                "n_pollsters": None,
                "delta_polls": n1,
                "label": "Liste de référence",
            }
        )
    return out


def simulate_scenario(
    sc: dict, p1: ErrorParams, p2: ErrorParams, rn_bias: dict, rng: np.random.Generator
) -> dict:
    avg, polled = sc["avg"], sc["polled"]
    cands = list(avg.shares.index)
    r1 = draw_r1(avg.shares.to_numpy() / 100, avg.d_eff, p1, rng, N_DRAWS, sc["extra_sd"])
    pairs = r2_inputs(polled, cands)
    pair_arr = pairs[["i", "j"]].to_numpy()
    pair_index = np.zeros((len(cands), len(cands)), dtype=int)
    pair_index[pair_arr[:, 0], pair_arr[:, 1]] = np.arange(len(pairs))
    d2_eff = float(
        np.average(polled.d_eff, weights=polled.n_eff)
    )  # days to R2 + age of the head-to-head polls
    is_rn = np.isin(cands, rn_bias["candidates"])
    r2 = draw_r2(
        pairs.mu.to_numpy(),
        pair_arr,
        pairs.model_sd.to_numpy(),
        float(p2.scale * sigma(d2_eff, p2)),
        p2.nu,
        len(cands),
        rng,
        N_DRAWS,
        is_rn * rn_bias["mean"],
        is_rn * rn_bias["sd"],
    )
    return {"cands": cands, "r1": r1, "r2": r2, "pairs": pairs, "pair_index": pair_index}


def summarise(sim: dict, avg, names: dict[str, str]) -> dict:
    cands, r1, r2, pairs = sim["cands"], sim["r1"], sim["r2"], sim["pairs"]
    first, second, winner = outcomes(r1, r2, sim["pair_index"])
    k = len(cands)
    qualify = np.array([((first == c) | (second == c)).mean() for c in range(k)])
    win = np.bincount(winner, minlength=k) / len(winner)
    assert abs(win.sum() - 1) < 1e-9 and abs(qualify.sum() - 2) < 1e-9
    a, b = np.minimum(first, second), np.maximum(first, second)
    finals = (
        pd.DataFrame({"a": a, "b": b, "a_wins": winner == a})
        .groupby(["a", "b"])
        .agg(p=("a_wins", "size"), p_a_wins=("a_wins", "mean"))
        .reset_index()
    )
    finals["p"] /= len(winner)
    pair_polled = {(i, j): bool(pl) for i, j, pl in zip(pairs.i, pairs.j, pairs.polled)}
    duel = [
        {
            "a": cands[i],
            "b": cands[j],
            "p_a": float((r2[:, n] > 0.5).mean()),
            "share_a": float(np.median(r2[:, n])),
            "polled": bool(pl),
        }
        for n, (i, j, pl) in enumerate(zip(pairs.i, pairs.j, pairs.polled))
    ]
    q = np.quantile(r1, QUANTILES, axis=0)
    return {
        "candidates": [
            {
                "id": c,
                "name": names.get(c, c),
                "poll_avg": float(avg.shares[c]),
                "share_q": {str(qq): float(100 * q[n, i]) for n, qq in enumerate(QUANTILES)},
                "p_qualify": float(qualify[i]),
                "p_win": float(win[i]),
                "p_win_if_qualified": float(win[i] / qualify[i]) if qualify[i] > 0 else None,
            }
            for i, c in enumerate(cands)
        ],
        "finals": [
            {
                "a": cands[r.a],
                "b": cands[r.b],
                "p": float(r.p),
                "p_a_wins": float(r.p_a_wins),
                "polled": pair_polled[(min(r.a, r.b), max(r.a, r.b))],
            }
            for r in finals.sort_values("p", ascending=False).head(10).itertuples()
        ],
        "duels": duel,
    }


def export_draws(sim: dict, scen: str) -> None:
    (np.round(sim["r1"] * 10000)).astype("<u2").tofile(OUT / f"r1_{scen}.bin")
    (np.round(sim["r2"] * 10000)).astype("<u2").tofile(OUT / f"r2_{scen}.bin")


def polls_table(used: pd.DataFrame) -> list[dict]:
    """One row per poll (not per hypothesis or scenario), for the legal mentions."""
    polls = used.sort_values("end").drop_duplicates(["pollster", "start", "end"])
    return [
        {
            "pollster": r.pollster,
            "start": r.start,
            "end": r.end,
            "n": None if pd.isna(r.n) else int(r.n),
            "sponsor": None if pd.isna(r.sponsor) else r.sponsor,
            "ref": r.ref,
        }
        for r in polls.itertuples()
    ]


def scenario_summary(sc: dict, sim: dict, names: dict[str, str]) -> dict:
    fields = ["rn", "lineup", "reference", "label", "n_pollsters", "delta_polls"]
    return {
        **{k: sc[k] for k in fields},
        "d_eff": sc["avg"].d_eff,
        **summarise(sim, sc["avg"], names),
        "pairs": sim["pairs"][["i", "j"]].to_numpy().tolist(),
    }


def main(asof: pd.Timestamp | None = None) -> None:
    asof = asof or pd.Timestamp(date.today())
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("r?_*.bin"):  # the offered scenarios change from day to day
        stale.unlink()
    polls = pd.read_csv(POLLS)
    names = candidate_names(polls)
    p1, p2, rn_bias = load_params()
    backtest = json.loads(BACKTEST.read_text())
    scenarios = build_scenarios(polls, reference_lineup(), asof, names)
    rng = np.random.default_rng(int(asof.strftime("%Y%m%d")))
    summary = {
        "asof": asof.date().isoformat(),
        "r1_date": R1_DATE.date().isoformat(),
        "r2_date": R2_DATE.date().isoformat(),
        "n_draws": N_DRAWS,
        "electorate": {
            "registered": REGISTERED,
            "expressed_r1": TURNOUT_EXPRESSED_R1,
            "expressed_r2": TURNOUT_EXPRESSED_R2,
        },
        "params": {"r1": p1.to_dict(), "r2": p2.to_dict(), "r2_rn_bias": rn_bias},
        # constants the site uses: defined once here and in backtest.py / blackout.py, never retyped in JS
        "constants": {
            "window_days": R1_WINDOW_DAYS,
            "min_lineup_pollsters": MIN_LINEUP_POLLSTERS,
            "late_days": backtest["late_days"],
            "blackout": [[a.isoformat(), b.isoformat()] for a, b in BLACKOUT],
        },
        "mae_by_horizon": backtest[
            "mae_by_horizon"
        ],  # poll error by days before R1, for the « too early » caveat
        "reference": next(s["key"] for s in scenarios if s["rn"] == "lepen" and s["reference"]),
        "scenarios": {},
    }
    for sc in scenarios:
        sim = simulate_scenario(sc, p1, p2, rn_bias, rng)
        summary["scenarios"][sc["key"]] = scenario_summary(sc, sim, names)
        export_draws(sim, sc["key"])
    used = pd.concat([sc["avg"].polls for sc in scenarios]).drop_duplicates("hyp")
    summary["polls_used"] = polls_table(used)
    summary["r2_polled"] = (
        scenarios[0]["polled"].assign(last=lambda d: d["last"].astype(str)).to_dict("records")
    )
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    append_history(summary["asof"], summary["scenarios"])
    for s in summary["scenarios"].values():
        top = sorted(s["candidates"], key=lambda c: -c["p_win"])[:4]
        print(f"{s['rn']:8} {s['label'][:40]:40}", " · ".join(f"{c['id']} {c['p_win']:.0%}" for c in top))


def append_history(day: str, scenarios: dict) -> None:
    if not scenarios:  # e.g. a backfill date before a line-up was first tested
        return
    path = OUT / "history.csv"
    new = pd.DataFrame(
        [
            {
                "date": day,
                "scenario": k,
                "candidate": c["id"],
                "poll_avg": round(c["poll_avg"], 2),
                "p_qualify": round(c["p_qualify"], 4),
                "p_win": round(c["p_win"], 4),
                "n_pollsters": s["n_pollsters"],
            }
            for k, s in scenarios.items()
            for c in s["candidates"]
        ]
    )
    if path.exists():
        old = pd.read_csv(path)
        old = old[[(d, k) not in set(zip(new.date, new.scenario)) for d, k in zip(old.date, old.scenario)]]
        new = pd.concat([old, new]).sort_values(["date", "scenario"])
    new.to_csv(path, index=False)


def backfill_history() -> None:
    """Give every scenario offered today a past: weekly from HISTORY_START, plus every date already in the history,
    computed from the polls published by each date (line-ups tested by fewer pollsters then are drawn dashed)."""
    summary = json.loads((OUT / "summary.json").read_text())
    offered = summary["scenarios"]
    path = OUT / "history.csv"
    hist = pd.read_csv(path) if path.exists() else pd.DataFrame(columns=["date", "scenario"])
    weekly = pd.date_range(HISTORY_START, pd.Timestamp(summary["asof"]) - pd.Timedelta(days=1), freq="7D")
    dates = sorted({d.date().isoformat() for d in weekly} | set(hist.date) - {summary["asof"]})
    have = set(zip(hist.date, hist.scenario))
    polls = pd.read_csv(POLLS)
    names, reference = candidate_names(polls), reference_lineup()
    p1, p2, rn_bias = load_params()
    for d in dates:
        todo = [s["lineup"] for k, s in offered.items() if s["rn"] == "lepen" and (d, k) not in have]
        need_bd = any(s["rn"] == "bardella" and (d, k) not in have for k, s in offered.items())
        if not todo and not need_bd:
            continue
        asof = pd.Timestamp(d)
        rng = np.random.default_rng(int(asof.strftime("%Y%m%d")))
        part = {}
        for sc in build_scenarios(polls, reference, asof, names, only=todo, bardella=need_bd):
            if sc["key"] in offered:
                part[sc["key"]] = scenario_summary(sc, simulate_scenario(sc, p1, p2, rn_bias, rng), names)
        append_history(d, part)
        print(
            d,
            {
                offered[k]["label"][:25] + ("/BD" if offered[k]["rn"] == "bardella" else ""): v["n_pollsters"]
                for k, v in part.items()
            },
        )


if __name__ == "__main__":
    if sys.argv[1:] == ["--backfill"]:
        backfill_history()
    else:
        main(pd.Timestamp(sys.argv[1]) if len(sys.argv) > 1 else None)
