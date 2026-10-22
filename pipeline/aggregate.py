"""Poll averages. Shared by the live model and the historical backtest, so both use the same code.

R1: per poll, pick the hypothesis closest to the reference line-up; keep the latest poll per pollster;
exponentially time-decayed, sample-size weighted mean of log shares, renormalised (softmax).
R2: same weighting on the logit of the head-to-head share, one average per pair.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

R1_WINDOW_DAYS = 45
R2_WINDOW_DAYS = 120  # head-to-heads are polled less often
MAJOR_SHARE = 3.0  # % — a missing/extra candidate above this disqualifies a hypothesis
SHARE_FLOOR = 0.2  # % — avoids log(0) for candidates polled at 0
N_CAP = 3000
TAU_DIVISOR, TAU_MIN, TAU_MAX = 8.0, 3.0, 21.0  # τ(D) = clip(D / 8, 3, 21) days


@dataclass
class R1Average:
    shares: pd.Series  # % by candidate, sums to 100 over the reference line-up
    d_eff: float  # effective horizon: days to election + weighted mean poll age
    polls: pd.DataFrame  # the hypotheses used, with weights (for the legal table / transparency)


def tau(days_to_election: float) -> float:
    return float(np.clip(days_to_election / TAU_DIVISOR, TAU_MIN, TAU_MAX))


def with_age(polls: pd.DataFrame, asof: pd.Timestamp) -> pd.DataFrame:
    mid = pd.to_datetime(polls.start) + (pd.to_datetime(polls.end) - pd.to_datetime(polls.start)) / 2
    return polls.assign(age=(asof - mid).dt.days.clip(lower=0))


def weights(age: pd.Series, n: pd.Series, days_to_election: float) -> pd.Series:
    size = np.sqrt(n.fillna(1000).clip(upper=N_CAP) / 1000)
    return np.exp(-age / tau(days_to_election)) * size


def pick_hypotheses(polls: pd.DataFrame, reference: list[str]) -> pd.DataFrame:
    """Per poll keep the hypotheses closest to the reference; drop polls whose best match still
    lacks a major reference candidate or includes a major outsider."""
    # ponytail: pollsters that never test the reference line-up are dropped (Oct 2026: Cluster17, Odoxa
    # test Philippe *or* Attal). Upgrade: within-poll substitution deltas, like the Bardella scenario.
    mean_share = polls.groupby("candidate").share.mean()
    major = set(mean_share[mean_share >= MAJOR_SHARE].index)
    ref = set(reference)
    lineups = polls.groupby("hyp").candidate.agg(set)
    missing = lineups.map(lambda s: len((ref & major) - s))
    outsiders = lineups.map(lambda s: len((s - ref) & major))
    dist = lineups.map(lambda s: len(ref ^ s))
    meta = pd.DataFrame({"missing": missing, "outsiders": outsiders, "dist": dist})
    meta = meta[(meta.missing == 0) & (meta.outsiders == 0)]
    hyps = polls[polls.hyp.isin(meta.index)].drop_duplicates("hyp")[["hyp", "pollster", "end"]]
    hyps = hyps.assign(dist=hyps.hyp.map(meta.dist))
    best = hyps.groupby(["pollster", "end"]).dist.transform("min")
    return polls[polls.hyp.isin(hyps[hyps.dist == best].hyp)]


def latest_per_pollster(polls: pd.DataFrame) -> pd.DataFrame:
    last = polls.groupby("pollster").end.transform("max")
    return polls[polls.end == last]


def r1_average(
    polls: pd.DataFrame,
    reference: list[str],
    asof: pd.Timestamp,
    days_to_election: float,
) -> R1Average:
    """polls: one election's round-1 rows (schema of data/polls.csv)."""
    recent = polls[
        (pd.to_datetime(polls.end) <= asof)
        & (pd.to_datetime(polls.end) > asof - pd.Timedelta(days=R1_WINDOW_DAYS))
    ]
    used = latest_per_pollster(pick_hypotheses(recent, reference))
    used = with_age(used[used.candidate.isin(reference)], asof)
    # tied hypotheses in one poll share that poll's weight
    hyps_per_poll = used.groupby(["pollster", "end"]).hyp.transform("nunique")
    used = used.assign(w=weights(used.age, used.n, days_to_election) / hyps_per_poll)
    log_share = np.log(used.share.clip(lower=SHARE_FLOOR))
    num = (used.w * log_share).groupby(used.candidate).sum()
    mean_log = num / used.groupby("candidate").w.sum()
    shares = np.exp(mean_log)
    shares = 100 * shares / shares.sum()
    poll_w = used.drop_duplicates("hyp")
    if poll_w.empty:
        return R1Average(shares, float("nan"), used)
    d_eff = days_to_election + float((poll_w.w * poll_w.age).sum() / poll_w.w.sum())
    return R1Average(shares.sort_values(ascending=False), d_eff, used)


def r2_averages(polls: pd.DataFrame, asof: pd.Timestamp, days_to_election: float) -> pd.DataFrame:
    """One row per polled pair (a, b) with a < b: mean logit share of a, effective number of polls."""
    recent = polls[
        (pd.to_datetime(polls.end) <= asof)
        & (pd.to_datetime(polls.end) > asof - pd.Timedelta(days=R2_WINDOW_DAYS))
    ]
    hyp = recent.groupby("hyp").agg(
        cands=("candidate", lambda s: tuple(sorted(s))),
        pollster=("pollster", "first"),
        end=("end", "first"),
        start=("start", "first"),
        n=("n", "first"),
    )
    hyp = hyp[hyp.cands.map(len) == 2]
    share = recent.set_index(["hyp", "candidate"]).share
    hyp["a"], hyp["b"] = hyp.cands.str[0], hyp.cands.str[1]
    hyp["logit_a"] = [np.log(share[h, a] / share[h, b]) for h, a, b in zip(hyp.index, hyp.a, hyp.b)]
    hyp = with_age(hyp, asof)
    rows = []
    for (a, b), g in hyp.groupby(["a", "b"]):
        g = g[g.end == g.groupby("pollster").end.transform("max")]
        w = weights(g.age, g.n, days_to_election)
        rows.append(
            {
                "a": a,
                "b": b,
                "logit_a": float((w * g.logit_a).sum() / w.sum()),
                "n_eff": float(w.sum() ** 2 / (w**2).sum()),
                "n_polls": len(g),
                "last": g.end.max(),
                "d_eff": days_to_election + float((w * g.age).sum() / w.sum()),
            }
        )
    return pd.DataFrame(rows)
