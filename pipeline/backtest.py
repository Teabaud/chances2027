"""Fit the poll-error model on past elections and validate it leave-one-election-out (LOEO).

Errors are measured with the *same* aggregator as the live model (pipeline/aggregate.py) on individual
polls 2002–2022 (data/hist_polls.csv), at fixed horizons before each round. Jennings & Wlezien daily poll
averages give extra R1 errors for 1981–1995 (their own averaging; sparse polls).
Outputs data/error_params.json (read by model.py) and site/data/backtest.json (shown on the site).
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats

sys.path.insert(0, str(Path(__file__).parent))
from aggregate import R1_WINDOW_DAYS, r1_average, r2_averages
from simulate import ErrorParams, draw_r1, sigma, size_scaling

ROOT = Path(__file__).resolve().parent.parent
HIST_POLLS = ROOT / "data" / "hist_polls.csv"
RESULTS = ROOT / "data" / "results_history.csv"
JW = ROOT / "data" / "jw_france_r1.csv"  # extract of Jennings & Wlezien (doi:10.7910/DVN/8421DX), see README
PARAMS_OUT = ROOT / "data" / "error_params.json"
SITE_OUT = ROOT / "site" / "data" / "backtest.json"
HORIZONS = [1, 7, 14, 30, 60, 90, 120, 180, 270]
MIN_SHARE = 2.0  # % — smaller candidates are too noisy to fit on
NU_GRID = [4, 6, 10, 30]
JW_YEARS = [1981, 1988, 1995]  # earlier years have ≤5 polls per election
COVERAGE_LEVELS = [0.5, 0.8, 0.95]
WITHDRAWN_PRESENCE = 0.5
RN_CANDIDATES = {"le-pen"}  # FN/RN candidates in past run-offs (J.-M. Le Pen 2002, M. Le Pen 2017/2022)
RN_BIAS_PRIOR_SD = 0.10  # logit; prior on a party-level R2 polling bias (independent review, 2026-10)
# R2 error: judgement, not a fit. Six run-offs cannot pin these (a fit of σ_f hit any floor we set), so they are
# stated as such (methode.html « Limites »): final week ≈ 2.5 pp (Jennings & Wlezien, across countries), far-horizon
# asymptote and half-life from the independent review (≈ 0.27 logit at 190 days).
R2_SIGMA_FINAL, R2_SIGMA_INF, R2_D_HALF = 0.10, 0.30, 64.0
R2_TYPICAL_SD = 0.15  # logit; typical single-election R2 error, for the bias standard error
LATE_DAYS = 14  # « the last two weeks », reported separately and used by the site
N_SIM = 4000


def withdrawn_at(polls: pd.DataFrame, finalists: set[str], asof: pd.Timestamp) -> list[str]:
    """Candidates not on the final ballot but tested in at least half of the recent hypotheses at `asof`
    (e.g. Taubira early 2022, Bayrou early 2017): part of the line-up *as it was known then*."""
    end = pd.to_datetime(polls.end)
    recent = polls[(end <= asof) & (end > asof - pd.Timedelta(days=R1_WINDOW_DAYS))]
    if recent.empty:
        return []
    presence = recent.groupby("candidate").hyp.nunique() / recent.hyp.nunique()
    return [c for c in presence.index if c not in finalists and presence[c] >= WITHDRAWN_PRESENCE]


def r1_errors(polls: pd.DataFrame, results: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for year, res in results[results["round"] == 1].groupby("year"):
        day = pd.Timestamp(res.election_date.iloc[0])
        yp = polls[(polls.year == year) & (polls["round"] == 1)]
        if yp.empty:
            continue
        result = res.set_index("candidate").share
        for d in HORIZONS:
            asof = day - pd.Timedelta(days=d)
            reference = list(result.index) + withdrawn_at(yp, set(result.index), asof)
            avg = r1_average(yp, reference, asof, d)
            if avg.polls.empty:
                continue
            # withdrawn candidates leave the comparison; their voters are treated as spread pro rata
            shares = avg.shares[avg.shares.index.isin(result.index)]
            shares = 100 * shares / shares.sum()
            truth = result.reindex(shares.index)
            truth = 100 * truth / truth.sum()
            for c, s in shares.items():
                rows.append(
                    {
                        "year": year,
                        "d": d,
                        "d_eff": avg.d_eff,
                        "candidate": c,
                        "avg": s,
                        "result": truth[c],
                        "source": "polls",
                    }
                )
    return pd.DataFrame(rows)


def jw_errors() -> pd.DataFrame:
    jw = pd.read_csv(JW)
    jw = jw[(jw["round"] == 1) & jw.electionyr.round().isin(JW_YEARS)]
    rows = []
    for (yr, party), g in jw.groupby([jw.electionyr.round().astype(int), "partyid"]):
        g = g.set_index("daysbeforeED").sort_index()
        polled_days = g.index[g.poll_.notna()]
        for d in HORIZONS:
            if not len(polled_days) or (np.abs(polled_days - d) <= max(7, d / 4)).sum() == 0:
                continue  # no actual poll near this horizon
            if d in g.index and pd.notna(g.ipoll_[d]):
                rows.append(
                    {
                        "year": yr,
                        "d": d,
                        "d_eff": d,
                        "candidate": f"jw{int(party)}",
                        "avg": g.ipoll_[d],
                        "result": g.vote_.iloc[0],
                        "source": "jw",
                    }
                )
    return pd.DataFrame(rows)


def r2_errors(polls: pd.DataFrame, results: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for year, res in results[results["round"] == 2].groupby("year"):
        day = pd.Timestamp(res.election_date.iloc[0])
        a, b = sorted(res.candidate)
        truth = float(np.log(res.set_index("candidate").share[a] / res.set_index("candidate").share[b]))
        yp = polls[(polls.year == year) & (polls["round"] == 2)]
        for d in HORIZONS:
            avgs = r2_averages(yp, day - pd.Timedelta(days=d), d)
            hit = avgs[(avgs.a == a) & (avgs.b == b)] if len(avgs) else avgs
            if len(hit):
                rows.append(
                    {
                        "year": year,
                        "d": d,
                        "a": a,
                        "b": b,
                        "d_eff": hit.d_eff.iloc[0],
                        "logit_poll": hit.logit_a.iloc[0],
                        "logit_result": truth,
                        "err": truth - hit.logit_a.iloc[0],
                    }
                )
    return pd.DataFrame(rows)


def obs_weights(err: pd.DataFrame) -> np.ndarray:
    """Each (election, candidate) counts once whatever its number of horizons; elections count equally."""
    per_cand = err.groupby(["year", "candidate"]).d.transform("size")
    cands_per_year = err.groupby("year").candidate.transform("nunique")
    w = 1 / (per_cand * cands_per_year)
    return (w / w.mean()).to_numpy()


def r1_logpdf(theta: np.ndarray, err: pd.DataFrame, nu: float) -> np.ndarray:
    p = ErrorParams(*np.abs(theta[:3]), theta[3], nu)
    sd = sigma(err.d_eff.to_numpy(), p) * size_scaling(err.avg.to_numpy() / 100, p.k)
    e = np.log(err.result.to_numpy() / err.avg.to_numpy())
    return stats.t.logpdf(e / sd, nu) - np.log(sd)


def fit_r1(err: pd.DataFrame, nu: float) -> ErrorParams:
    w = obs_weights(err)
    res = optimize.minimize(
        lambda th: -(w * r1_logpdf(th, err, nu)).sum(),
        x0=[0.1, 0.3, 60, 0.7],
        method="Nelder-Mead",
        options={"maxiter": 4000, "xatol": 1e-4, "fatol": 1e-6},
    )
    s_f, s_i, d_h = np.abs(res.x[:3])
    return ErrorParams(float(s_f), float(s_i), float(d_h), float(res.x[3]), nu)


def rn_error(err: pd.DataFrame) -> pd.Series:
    """R2 error expressed as (result − polls) for the RN candidate's logit share; NaN for other pairs."""
    sign = np.where(err.a.isin(RN_CANDIDATES), 1.0, np.where(err.b.isin(RN_CANDIDATES), -1.0, np.nan))
    return err.err * sign


def rn_bias(err: pd.DataFrame) -> tuple[float, float]:
    """Empirical-Bayes party bias: per-election mean RN error, shrunk toward 0 with a N(0, prior²) prior.
    Returns (posterior mean, posterior sd), in logit of the RN share (negative = RN over-polled)."""
    per_year = rn_error(err).groupby(err.year).mean().dropna()
    # each election's mean error is one noisy draw: use the typical R2 error, not the (lucky) observed spread
    se2 = R2_TYPICAL_SD**2 / len(per_year)
    shrink = RN_BIAS_PRIOR_SD**2 / (RN_BIAS_PRIOR_SD**2 + se2)
    return float(shrink * per_year.mean()), float(np.sqrt(1 / (1 / RN_BIAS_PRIOR_SD**2 + 1 / se2)))


def loeo_logscore(err: pd.DataFrame, nu: float) -> float:
    total = 0.0
    for year in err.year.unique():
        p = fit_r1(err[err.year != year], nu)
        held = err[err.year == year]
        total += (
            obs_weights(held) * r1_logpdf(np.array([p.sigma_final, p.sigma_inf, p.d_half, p.k]), held, nu)
        ).sum()
    return total


def loeo_coverage(
    err: pd.DataFrame,
    err_sim: pd.DataFrame,
    nu: float,
    scale: float,
    rng: np.random.Generator,
) -> pd.DataFrame:
    """Simulate each held-out (election, horizon) with params fitted on the other elections; record where
    each candidate's result falls in its simulated distribution (PIT) and qualify forecasts."""
    rows = []
    for year in sorted(err_sim.year.unique()):
        p = fit_r1(err[err.year != year], nu)
        p.scale = scale
        for d, g in err_sim[err_sim.year == year].groupby("d"):
            # simulate the full field (incl. candidates < MIN_SHARE), score the fitted ones
            sims = draw_r1(g.avg.to_numpy() / 100, g.d_eff.iloc[0], p, rng, N_SIM)
            top2 = np.argsort(-sims, axis=1)[:, :2]
            true_top2 = set(np.argsort(-g.result.to_numpy())[:2])
            for i, r in enumerate(g.itertuples()):
                rows.append(
                    {
                        "year": year,
                        "d": d,
                        "candidate": r.candidate,
                        "avg": r.avg,
                        "result": r.result,
                        "pit": float((sims[:, i] < r.result / 100).mean()),
                        "p_qualify": float((top2 == i).any(axis=1).mean()),
                        "qualified": i in true_top2,
                    }
                )
    return pd.DataFrame(rows)


def coverage_table(pit: pd.DataFrame) -> dict[str, float]:
    return {str(lv): float((np.abs(pit.pit - 0.5) <= lv / 2).mean()) for lv in COVERAGE_LEVELS}


def calibrate_scale(
    err: pd.DataFrame, err_all: pd.DataFrame, nu: float, rng: np.random.Generator
) -> tuple[float, pd.DataFrame]:
    """Smallest-loss scale so pooled LOEO 80% coverage (candidates ≥ MIN_SHARE) hits 80%."""
    best = None
    for scale in np.arange(0.8, 2.01, 0.1):
        cov = loeo_coverage(err, err_all, nu, float(scale), rng)
        fitted = cov[cov.avg >= MIN_SHARE]
        gap = abs(coverage_table(fitted)["0.8"] - 0.8)
        if best is None or gap < best[0]:
            best = (gap, float(scale), cov)
    return best[1], best[2]


def main() -> None:
    rng = np.random.default_rng(2027)
    polls, results = pd.read_csv(HIST_POLLS), pd.read_csv(RESULTS)
    err_all = r1_errors(polls, results)  # full fields, for simulation
    err = pd.concat([err_all[err_all.avg >= MIN_SHARE], jw_errors()], ignore_index=True)
    print(f"R1 errors: {len(err)} obs, {err.groupby(['year', 'candidate']).ngroups} election×candidate")
    scores = {nu: loeo_logscore(err, nu) for nu in NU_GRID}
    nu = max(scores, key=scores.get)
    p1 = fit_r1(err, nu)
    print("LOEO log score by ν:", {k: round(v, 1) for k, v in scores.items()}, "→ ν =", nu)
    scale, cov = calibrate_scale(err, err_all, nu, rng)
    p1.scale = scale
    fitted = cov[cov.avg >= MIN_SHARE]
    cov_all, cov_late = coverage_table(fitted), coverage_table(fitted[fitted.d <= LATE_DAYS])
    brier = float(((cov.p_qualify - cov.qualified) ** 2).mean())
    brier_late = float(((cov[cov.d <= LATE_DAYS].p_qualify - cov[cov.d <= LATE_DAYS].qualified) ** 2).mean())
    print("R1 params:", p1.to_dict())
    print("LOEO coverage all horizons:", cov_all, " D≤14:", cov_late)
    print(f"Qualify Brier: all {brier:.3f}, D≤14 {brier_late:.3f}")

    e2 = r2_errors(polls, results)
    bias, bias_sd = rn_bias(e2)
    p2 = ErrorParams(R2_SIGMA_FINAL, R2_SIGMA_INF, R2_D_HALF, 1.0, nu)
    print(f"RN R2 bias (logit of RN share): {bias:.3f} ± {bias_sd:.3f}")
    print("R2 errors (logit, result − polls):")
    print(
        e2.assign(pp=lambda d: 100 / (1 + np.exp(-d.logit_result)) - 100 / (1 + np.exp(-d.logit_poll)))
        .round(3)
        .to_string(index=False)
    )
    print("R2 params:", p2.to_dict())

    rn = {"candidates": ["le-pen", "bardella"], "mean": bias, "sd": bias_sd}
    PARAMS_OUT.write_text(json.dumps({"r1": p1.to_dict(), "r2": p2.to_dict(), "r2_rn_bias": rn}, indent=1))
    by_h = err.assign(abs_pp=(err.result - err.avg).abs()).groupby("d").abs_pp.mean()
    SITE_OUT.parent.mkdir(parents=True, exist_ok=True)
    SITE_OUT.write_text(
        json.dumps(
            {
                "years": sorted(int(y) for y in err.year.unique()),
                "late_days": LATE_DAYS,
                "nu": nu,
                "r1": p1.to_dict(),
                "r2": p2.to_dict(),
                "r2_rn_bias": rn,
                "coverage_all": cov_all,
                "coverage_late": cov_late,
                "brier_qualify": brier,
                "brier_qualify_late": brier_late,
                "mae_by_horizon": {int(k): float(v) for k, v in by_h.items()},
                "r1_errors": err.round(3).to_dict("records"),
                "r2_errors": e2.round(4).to_dict("records"),
                "pit": cov.round(4).to_dict("records"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
