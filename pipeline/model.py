"""Daily forecast: poll averages → R2 strengths → Monte Carlo → site/data/.

R2 for unpolled pairs: Bradley–Terry strengths, logit r_AB = s_A − s_B, least squares on polled pairs.
Candidates never polled in R2 borrow a neighbour's strength (R2_PROXY) with extra model error.
"""

import json
import sys
import tomllib
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from aggregate import r1_average, r2_averages
from simulate import ErrorParams, draw_r1, draw_r2, outcomes, sigma

ROOT = Path(__file__).resolve().parent.parent
POLLS = ROOT / "data" / "polls.csv"
LINEUPS = ROOT / "data" / "lineups.toml"
PARAMS = ROOT / "data" / "error_params.json"
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
R2_PROXY = {
    "arthaud": ("melenchon", 0.0),
    "roussel": ("melenchon", 0.2),
    "tondelier": ("glucksmann", 0.0),
    "dupont-aignan": ("retailleau", -0.3),
    "zemmour": ("le-pen", -0.5),
    "lisnard": ("retailleau", 0.0),
    "hollande": ("glucksmann", 0.0),
    "faure": ("glucksmann", 0.0),
}
QUANTILES = [0.05, 0.1, 0.5, 0.9, 0.95]
MIN_LINEUP_POLLSTERS = 3  # an alternative line-up is offered only if this many pollsters tested it recently
MAJOR_SHARE = 3.0  # % — line-ups are compared on candidates above this
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


def r2_inputs(
    polled: pd.DataFrame,
    cands: list[str],
    substitute: dict[str, str],
    shift: dict[str, tuple[float, float]],
) -> pd.DataFrame:
    """One row per pair of reference candidates (i < j): mu (logit share of i), model_sd, polled flag.
    substitute renames a polled candidate (le-pen → bardella); shift adds (offset, sd) to its logit."""
    polled = polled.replace({"a": substitute, "b": substitute})
    flip = polled.a > polled.b
    polled.loc[flip, ["a", "b"]] = polled.loc[flip, ["b", "a"]].to_numpy()
    polled.loc[flip, "logit_a"] *= -1
    strengths, model_sd = fit_strengths(polled, cands)
    extra = {}
    for c in cands:
        if c not in strengths:
            neighbour, offset = R2_PROXY[c]
            strengths[c], extra[c] = (
                strengths[substitute.get(neighbour, neighbour)] + offset,
                PROXY_EXTRA_SD,
            )
    poll_map = {(a, b): r for a, b, r in zip(polled.a, polled.b, polled.itertuples())}
    rows = []
    for i, a in enumerate(cands):
        for j in range(i + 1, len(cands)):
            b = cands[j]
            key = (a, b) if a < b else (b, a)
            sign = 1 if a < b else -1
            model_mu = strengths[a] - strengths[b]
            msd = float(np.hypot(model_sd, np.hypot(extra.get(a, 0), extra.get(b, 0))))
            if key in poll_map and not ({a, b} & shift.keys()):
                r = poll_map[key]
                prec_poll = r.n_eff / POLL_LOGIT_SD**2
                prec_mod = 1 / msd**2
                mu = (prec_poll * sign * r.logit_a + prec_mod * model_mu) / (prec_poll + prec_mod)
                rows.append({"i": i, "j": j, "mu": mu, "model_sd": 0.0, "polled": True})
            else:
                rows.append({"i": i, "j": j, "mu": model_mu, "model_sd": msd, "polled": False})
    out = pd.DataFrame(rows)
    for c, (offset, sd) in shift.items():
        ci = cands.index(c)
        sign = np.where(out.i == ci, 1, np.where(out.j == ci, -1, 0))
        out["mu"] += sign * offset
        out.loc[sign != 0, "model_sd"] = np.hypot(out.loc[sign != 0, "model_sd"], sd)
        out.loc[sign != 0, "polled"] = False
    return out


def bardella_r2_delta(r2: pd.DataFrame) -> tuple[float, float]:
    """Mean and s.e. of logit(Bardella vs X) − logit(Le Pen vs X), same poll, same opponent X."""
    hyp = r2.groupby("hyp").agg(
        cands=("candidate", frozenset),
        pollster=("pollster", "first"),
        end=("end", "first"),
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
                lb = np.log(share[h_b, "bardella"] / share[h_b, x])
                ll = np.log(share[match[0], "le-pen"] / share[match[0], x])
                deltas.append(lb - ll)
    d = np.array(deltas)
    return float(d.mean()), float(d.std(ddof=1) / np.sqrt(len(d)))


def bardella_r1_delta(r1: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Mean and s.e. of log-share changes when Bardella replaces Le Pen in an otherwise identical
    hypothesis of the same poll."""
    lineups = r1.groupby("hyp").candidate.agg(frozenset)
    meta = r1.drop_duplicates("hyp").set_index("hyp")[["pollster", "end"]].assign(lineup=lineups)
    deltas = []
    for _, g in meta.groupby(["pollster", "end"]):
        for h_b, lu_b in g.lineup.items():
            if "bardella" not in lu_b:
                continue
            target = (lu_b - {"bardella"}) | {"le-pen"}
            match = g.index[g.lineup == target]
            if len(match):
                pb = r1[r1.hyp == h_b].set_index("candidate").share
                pl = r1[r1.hyp == match[0]].set_index("candidate").share.rename({"le-pen": "bardella"})
                deltas.append(np.log(pb) - np.log(pl))
    d = pd.DataFrame(deltas)
    return d.mean(), d.std() / np.sqrt(d.count())


def tested_lineups(r1: pd.DataFrame, reference: list[str], asof: pd.Timestamp) -> list[list[str]]:
    """Alternative line-ups (sets of major candidates) tested by ≥ MIN_LINEUP_POLLSTERS pollsters recently.
    Minor reference candidates are kept in every line-up."""
    recent = r1[pd.to_datetime(r1.end) > asof - pd.Timedelta(days=45)]
    mean = recent.groupby("candidate").share.mean()
    major = set(mean[mean >= MAJOR_SHARE].index)
    minors = [c for c in reference if c not in major]
    hyps = recent.groupby("hyp").agg(
        m=("candidate", lambda c: frozenset(set(c) & major)), p=("pollster", "first")
    )
    counts = hyps.groupby("m").p.nunique()
    ref_major = frozenset(set(reference) & major)
    keep = [
        m
        for m, n in counts.sort_values(ascending=False).items()
        if n >= MIN_LINEUP_POLLSTERS and m != ref_major
    ]
    return [sorted(m) + minors for m in keep]


def lineup_label(lineup: list[str], reference: list[str], names: dict[str, str]) -> str:
    out = [names.get(c, c) for c in reference if c not in lineup]
    add = [names.get(c, c) for c in lineup if c not in reference]
    if len(out) == 1 and len(add) == 1:
        return f"{add[0]} au lieu de {out[0]}"
    parts = [f"avec {a}" for a in add] + [f"sans {o}" for o in out]
    return ", ".join(parts)


def scenario_inputs(polls: pd.DataFrame, lineups: dict, asof: pd.Timestamp, names: dict[str, str]) -> dict:
    d1 = (R1_DATE - asof).days
    r1, r2 = polls[polls["round"] == 1], polls[polls["round"] == 2]
    avg = r1_average(r1, lineups["lepen"]["candidates"], asof, d1)
    polled_r2 = r2_averages(r2, asof, d1 + 14)
    out = {
        "lepen": {
            "avg": avg,
            "extra_sd": pd.Series(0.0, index=avg.shares.index),
            "substitute": {},
            "shift": {},
        }
    }
    delta, se = bardella_r1_delta(r1)
    log_b = np.log(avg.shares.rename({"le-pen": "bardella"})) + delta.reindex(
        avg.shares.rename({"le-pen": "bardella"}).index
    ).fillna(0)
    shares_b = 100 * np.exp(log_b) / np.exp(log_b).sum()
    extra_b = se.reindex(shares_b.index).fillna(0)
    out["bardella"] = {
        "avg": type(avg)(shares_b.sort_values(ascending=False), avg.d_eff, avg.polls),
        "extra_sd": extra_b,
        "substitute": {"le-pen": "bardella"},
        "shift": {"bardella": bardella_r2_delta(r2)},
    }
    for n, lineup in enumerate(tested_lineups(r1, lineups["lepen"]["candidates"], asof)):
        alt = r1_average(r1, lineup, asof, d1)
        if alt.polls.pollster.nunique() < MIN_LINEUP_POLLSTERS:
            continue
        out[f"lineup{n + 1}"] = {
            "avg": alt,
            "extra_sd": pd.Series(0.0, index=alt.shares.index),
            "substitute": {},
            "shift": {},
            "label": lineup_label(lineup, lineups["lepen"]["candidates"], names),
        }
    out["polled_r2"] = polled_r2
    return out


def simulate_scenario(
    sc: dict,
    polled_r2: pd.DataFrame,
    p1: ErrorParams,
    p2: ErrorParams,
    rn_bias: dict,
    d2: float,
    rng: np.random.Generator,
) -> dict:
    avg, extra_sd = sc["avg"], sc["extra_sd"]
    cands = list(avg.shares.index)
    share = avg.shares.to_numpy() / 100
    r1 = draw_r1(share, avg.d_eff, p1, rng, N_DRAWS)
    if extra_sd.any():  # parameter uncertainty of the Bardella delta, applied on top
        bump = np.exp(rng.standard_normal((N_DRAWS, len(cands))) * extra_sd.reindex(cands).to_numpy())
        r1 = r1 * bump / (r1 * bump).sum(axis=1, keepdims=True)
    pairs = r2_inputs(polled_r2, cands, sc["substitute"], sc["shift"])
    pair_arr = pairs[["i", "j"]].to_numpy()
    pair_index = np.zeros((len(cands), len(cands)), dtype=int)
    pair_index[pair_arr[:, 0], pair_arr[:, 1]] = np.arange(len(pairs))
    # R2 horizon: days to R2 plus the (precision-weighted) age of the head-to-head polls
    d2_eff = d2 + float(np.average(polled_r2.d_eff - (d2), weights=polled_r2.n_eff)) if len(polled_r2) else d2
    sd2 = float(p2.scale * sigma(d2_eff, p2))
    is_rn = np.isin(cands, rn_bias["candidates"])
    bias, bias_sd = is_rn * rn_bias["mean"], is_rn * rn_bias["sd"]
    r2 = draw_r2(
        pairs.mu.to_numpy(),
        pair_arr,
        pairs.model_sd.to_numpy(),
        sd2,
        p2.nu,
        len(cands),
        rng,
        N_DRAWS,
        bias,
        bias_sd,
    )
    return {
        "cands": cands,
        "r1": r1,
        "r2": r2,
        "pairs": pairs,
        "pair_index": pair_index,
    }


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
    hyps = used.drop_duplicates("hyp")
    return [
        {
            "pollster": r.pollster,
            "start": r.start,
            "end": r.end,
            "n": None if pd.isna(r.n) else int(r.n),
            "ref": r.ref,
            "weight": round(float(r.w), 3),
        }
        for r in hyps.itertuples()
    ]


def main(asof: pd.Timestamp | None = None) -> None:
    asof = asof or pd.Timestamp(date.today())
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("r?_lineup*.bin"):  # line-ups change daily
        stale.unlink()
    polls = pd.read_csv(POLLS)
    lineups = tomllib.loads(LINEUPS.read_text())
    names = polls.dropna(subset=["name"]).drop_duplicates("candidate").set_index("candidate").name.to_dict()
    p1, p2, rn_bias = load_params()
    inputs = scenario_inputs(polls, lineups, asof, names)
    d2 = (R2_DATE - asof).days
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
        "scenarios": {},
    }
    used_pollsters = {p for k, v in inputs.items() if k != "polled_r2" for p in v["avg"].polls.pollster}
    recent = polls[pd.to_datetime(polls.end) > asof - pd.Timedelta(days=45)]
    for scen in [k for k in inputs if k != "polled_r2"]:
        sc = inputs[scen]
        sim = simulate_scenario(sc, inputs["polled_r2"], p1, p2, rn_bias, d2, rng)
        summary["scenarios"][scen] = {
            "label": sc.get("label") or lineups[scen]["label"],
            "kind": "lineup" if scen.startswith("lineup") else "rn",
            "n_pollsters": int(sc["avg"].polls.pollster.nunique()),
            "d_eff": sc["avg"].d_eff,
            **summarise(sim, sc["avg"], names),
        }
        export_draws(sim, scen)
        summary["scenarios"][scen]["pairs"] = sim["pairs"][["i", "j"]].to_numpy().tolist()
    all_used = pd.concat([v["avg"].polls for k, v in inputs.items() if k != "polled_r2"]).drop_duplicates(
        "hyp"
    )
    summary["polls_used"] = polls_table(all_used)
    summary["pollsters_excluded"] = sorted(set(recent.pollster) - used_pollsters)
    summary["r2_polled"] = inputs["polled_r2"].assign(last=lambda d: d["last"].astype(str)).to_dict("records")
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    append_history(summary)
    for scen, s in summary["scenarios"].items():
        top = sorted(s["candidates"], key=lambda c: -c["p_win"])[:5]
        print(
            scen,
            " · ".join(f"{c['id']} win {c['p_win']:.0%} (R2 {c['p_qualify']:.0%})" for c in top),
        )


def append_history(summary: dict) -> None:
    path = OUT / "history.csv"
    rows = [
        {
            "date": summary["asof"],
            "scenario": scen,
            "candidate": c["id"],
            "poll_avg": round(c["poll_avg"], 2),
            "p_qualify": round(c["p_qualify"], 4),
            "p_win": round(c["p_win"], 4),
        }
        for scen, s in summary["scenarios"].items()
        if s["kind"] == "rn"  # line-up variants are re-numbered daily: no time series
        for c in s["candidates"]
    ]
    new = pd.DataFrame(rows)
    if path.exists():
        old = pd.read_csv(path)
        new = pd.concat([old[old.date != summary["asof"]], new])
    new.to_csv(path, index=False)


if __name__ == "__main__":
    main(pd.Timestamp(sys.argv[1]) if len(sys.argv) > 1 else None)
