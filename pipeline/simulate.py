"""Error model and Monte Carlo draws. Shared by the backtest (fitting/validation) and the live model.

R1: l_c = log p̂_c + c·σ(D)·s_c·z_c / √W,  W ~ χ²_ν/ν shared within a draw, p = softmax(l).
    σ²(D) = σ_f² + (σ_∞² − σ_f²)·D/(D + D_h),  s_c = (p̂_c / 0.2)^(k − 1).
R2: logit r_AB = μ_AB + (v_A − v_B + w_AB + m_AB) / √W₂, Var(v) = σ²/4, Var(w) = σ²/2 (50/50 split, judgement).
"""

from dataclasses import asdict, dataclass

import numpy as np

REF_SHARE = 0.2  # size scaling is relative to a 20% candidate
MIN_SCALED_SHARE = 0.03


@dataclass
class ErrorParams:
    sigma_final: float  # log-share sd at D = 0 for a 20% candidate
    sigma_inf: float  # asymptote far from the election
    d_half: float  # days at which variance is halfway
    k: float  # size exponent (1 = pure log-space error)
    nu: float  # Student-t degrees of freedom
    scale: float = 1.0  # calibration multiplier, set by leave-one-election-out coverage

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


def sigma(d: np.ndarray | float, p: ErrorParams) -> np.ndarray:
    d = np.asarray(d, dtype=float)
    var = p.sigma_final**2 + (p.sigma_inf**2 - p.sigma_final**2) * d / (d + p.d_half)
    return np.sqrt(var)


def size_scaling(share: np.ndarray, k: float) -> np.ndarray:
    # clipped at MIN_SCALED_SHARE: the fit only saw candidates ≥ 2%, extrapolating below explodes the error
    return (np.maximum(np.asarray(share), MIN_SCALED_SHARE) / REF_SHARE) ** (k - 1)


def mixing(rng: np.random.Generator, nu: float, n: int) -> np.ndarray:
    """1/√W per draw; shared by all candidates of a draw (fat tails + 'bad polling year')."""
    return 1 / np.sqrt(rng.chisquare(nu, n) / nu)


def draw_r1(share: np.ndarray, d: float, p: ErrorParams, rng: np.random.Generator, n: int) -> np.ndarray:
    """share: K fractions summing to 1. Returns n×K simulated vote shares (rows sum to 1)."""
    sd = p.scale * sigma(d, p) * size_scaling(share, p.k)
    logits = np.log(share) + sd * rng.standard_normal((n, len(share))) * mixing(rng, p.nu, n)[:, None]
    logits -= logits.max(axis=1, keepdims=True)
    e = np.exp(logits)
    return e / e.sum(axis=1, keepdims=True)


def draw_r2(
    mu: np.ndarray,
    pairs: np.ndarray,
    model_sd: np.ndarray,
    sd_total: float,
    nu: float,
    n_cands: int,
    rng: np.random.Generator,
    n: int,
    bias: np.ndarray | None = None,
    bias_sd: np.ndarray | None = None,
) -> np.ndarray:
    """mu: P logit shares of pairs[:, 0] vs pairs[:, 1]; returns n×P simulated shares of pairs[:, 0]."""
    # bias / bias_sd: per-candidate logit shift (e.g. RN over-polled in run-offs) and its uncertainty
    v = rng.standard_normal((n, n_cands)) * sd_total / 2  # candidate shock, Var = σ²/4 each
    w = rng.standard_normal((n, len(mu))) * sd_total / np.sqrt(2)
    m = rng.standard_normal((n, len(mu))) * model_sd
    if bias is not None:
        v = v + bias + rng.standard_normal((n, 1)) * bias_sd  # one party-level draw per simulation
    shock = (v[:, pairs[:, 0]] - v[:, pairs[:, 1]] + w + m) * mixing(rng, nu, n)[:, None]
    return 1 / (1 + np.exp(-(mu + shock)))


def outcomes(
    r1: np.ndarray, r2: np.ndarray, pair_index: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """r1: n×K shares, r2: n×P shares of the lower-indexed candidate; pair_index: K×K → column in r2.
    Returns (first, second, winner) candidate indices per draw."""
    top2 = np.argsort(-r1, axis=1)[:, :2]
    a, b = top2.min(axis=1), top2.max(axis=1)
    share_a = r2[np.arange(len(r1)), pair_index[a, b]]
    winner = np.where(share_a > 0.5, a, b)
    return top2[:, 0], top2[:, 1], winner


def demo() -> None:
    rng = np.random.default_rng(0)
    p = ErrorParams(0.1, 0.3, 60, 0.7, 6)
    r1 = draw_r1(np.array([0.4, 0.3, 0.2, 0.1]), 30, p, rng, 20000)
    assert np.allclose(r1.sum(axis=1), 1)
    assert abs(r1.mean(axis=0)[0] - 0.4) < 0.02
    pairs = np.array([(i, j) for i in range(4) for j in range(i + 1, 4)])
    pair_index = np.zeros((4, 4), dtype=int)
    pair_index[pairs[:, 0], pairs[:, 1]] = np.arange(len(pairs))
    r2 = draw_r2(np.zeros(len(pairs)), pairs, np.zeros(len(pairs)), 0.1, 6, 4, rng, 20000)
    first, second, winner = outcomes(r1, r2, pair_index)
    assert ((winner == first) | (winner == second)).all()
    assert abs((winner == 0).mean() / ((first == 0) | (second == 0)).mean() - 0.5) < 0.03  # even duels
    print("simulate.py self-check ok")


if __name__ == "__main__":
    demo()
