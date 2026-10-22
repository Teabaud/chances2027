"""Run: uv run python tests/test_model.py — checks of the scenario layer found by the design audit (2026-10-22)."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import model

POLLS = pd.read_csv(model.POLLS)
REF = model.reference_lineup()
NAMES = model.candidate_names(POLLS)
ASOF = pd.Timestamp("2026-10-21")


def by_key(scenarios: list[dict]) -> dict[str, dict]:
    return {s["key"]: s for s in scenarios}


def test_bardella_uses_le_pen_duel_polls() -> None:
    """Bardella duels come from the Le Pen duel polls shifted by the measured gap, not from the strength model."""
    sc = by_key(model.build_scenarios(POLLS, REF, ASOF, NAMES))
    lp, bd = sc[model.lineup_id(REF)], sc["bd-" + model.lineup_id(REF)]
    pairs = model.r2_inputs(bd["polled"], list(bd["avg"].shares.index))
    cands = list(bd["avg"].shares.index)
    rows = pairs[(pairs.i == cands.index("bardella")) | (pairs.j == cands.index("bardella"))]
    opponents_polled_with_le_pen = set(
        lp["polled"].query("a == 'le-pen' or b == 'le-pen'")[["a", "b"]].stack()
    ) - {"le-pen"}
    derived = rows[
        [
            cands[i if cands[j] == "bardella" else j] in opponents_polled_with_le_pen
            for i, j in zip(rows.i, rows.j)
        ]
    ]
    assert len(derived) >= 4, "expected the Le Pen duels to carry over to Bardella"
    assert (derived.model_sd < model.MODEL_SD_FLOOR).all(), (
        "derived duels must not fall back to the strength-model error"
    )


def test_no_look_ahead() -> None:
    """A past date sees only polls published by then: adding future polls must not change anything."""
    past = pd.Timestamp("2026-09-01")
    future = POLLS[pd.to_datetime(POLLS.end) > past]
    only_past = POLLS[pd.to_datetime(POLLS.end) <= past]
    a = by_key(model.build_scenarios(only_past, REF, past, NAMES))
    b = by_key(model.build_scenarios(pd.concat([only_past, future]), REF, past, NAMES))
    assert a.keys() == b.keys(), "the offered line-ups depend on future polls"
    for k in a:
        assert np.allclose(a[k]["avg"].shares, b[k]["avg"].shares), f"{k}: shares depend on future polls"


def test_lineup_id_ignores_the_reference() -> None:
    lineup = [c for c in REF if c != "attal"]
    assert model.lineup_id(lineup) == model.lineup_id(list(reversed(lineup)))
    sc = by_key(model.build_scenarios(POLLS, REF, ASOF, NAMES))
    other_ref = [c for c in REF if c != "philippe"]
    sc2 = by_key(model.build_scenarios(POLLS, other_ref, ASOF, NAMES))
    shared = set(sc) & set(sc2) - {k for k in sc if k.startswith("bd-")}
    assert shared, "the same line-up must keep the same id when the reference changes"


def test_pollster_counts_are_honest() -> None:
    sc = model.build_scenarios(POLLS, REF, ASOF, NAMES)
    for s in sc:
        if s["rn"] == "bardella":
            assert s["n_pollsters"] is None and s["delta_polls"] >= 3, (
                "Bardella is derived, not 'tested by N pollsters'"
            )
        else:
            assert s["n_pollsters"] == model.pollsters_testing(POLLS, s["lineup"], ASOF), s["key"]


def test_missing_bardella_pairs_fail_loudly() -> None:
    try:
        model.bardella_r2_delta(POLLS[(POLLS["round"] == 2) & (POLLS.candidate != "bardella")])
    except ValueError:
        return
    raise AssertionError("no Bardella pair must raise, not return NaN")


def test_append_history_accepts_an_empty_batch() -> None:
    model.append_history("2026-07-15", {})  # must not crash (backfill date before a line-up was tested)


if __name__ == "__main__":
    for name, fn in [(n, f) for n, f in globals().items() if n.startswith("test_")]:
        fn()
        print(f"ok  {name}")
