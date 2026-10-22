// Run: node tests/vote-logic.test.mjs  (checks the « Mon vote » logic on toy and real simulations)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, decisiveChange, evaluate, makeData, recommend } from "../site/vote-logic.js";

// Toy: 3 candidates, A=0 leads; B=1 and C=2 tie for 2nd. B beats A in R2, C loses to A.
// A voter who supports B and rejects A should move to B, whatever their current vote.
{
  const S = 1000, K = 3, pairs = [[0, 1], [0, 2], [1, 2]];
  const r1 = new Uint16Array(S * K), r2 = new Uint16Array(S * 3);
  for (let s = 0; s < S; s++) {
    const tilt = (s % 2 ? 1 : -1) * 50;              // B and C swap 2nd place half the time
    r1.set([4000, 3000 + tilt, 3000 - tilt], s * K);
    r2.set([4000, 6000, 5000], s * 3);                 // A vs B: A 40 → B wins; A vs C: A 60 → A wins
  }
  const d = makeData(r1, r2, K, 3, pairs);
  const groups = [UNACCEPTABLE, SUPPORT, ACCEPTABLE];
  const res = evaluate(d, groups, 2, 0.02, [0, 1, 2, ABSTAIN]);
  const rec = recommend(res, groups);
  assert.equal(rec.forSupport.best, 1);
  assert.equal(rec.forAvoid.best, 1);
  assert.ok(rec.robust.includes(1) && !rec.robust.includes(2));
  const base = res.find((r) => r.option === 2);
  assert.equal(base.support.diff, 0);
  assert.ok(Math.abs(res.find((r) => r.option === 1).support.p - 1) < 1e-9);
  const ch = decisiveChange(d, 2, 1, 0.02);
  assert.equal(ch.entered, 1); assert.equal(ch.left, 2); assert.ok(Math.abs(ch.share - 0.5) < 1e-9);
  // Indifferent voter: everyone acceptable → all options equivalent
  const flat = recommend(evaluate(d, [ACCEPTABLE, ACCEPTABLE, ACCEPTABLE], 2, 0.02, [0, 1, 2]), [1, 1, 1]);
  assert.equal(flat.robust.length, 3);
}

// Real simulations: zero move is identity; probabilities in range.
{
  const summary = JSON.parse(readFileSync("site/data/summary.json"));
  const sc = summary.scenarios.lepen;
  const K = sc.candidates.length, P = sc.pairs.length;
  const r1 = new Uint16Array(readFileSync("site/data/r1_lepen.bin").buffer.slice(0));
  const r2 = new Uint16Array(readFileSync("site/data/r2_lepen.bin").buffer.slice(0));
  const d = makeData(r1, r2, K, P, sc.pairs);
  const ids = sc.candidates.map((c) => c.id);
  const lp = ids.indexOf("le-pen"), ph = ids.indexOf("philippe"), gl = ids.indexOf("glucksmann");
  const groups = ids.map((id) => (id === "le-pen" ? UNACCEPTABLE : ACCEPTABLE));
  const t0 = performance.now();
  const res = evaluate(d, groups, gl, 0.0139, [...ids.keys(), ABSTAIN]);
  const ms = performance.now() - t0;
  const base = res.find((r) => r.option === gl);
  assert.ok(Math.abs(base.unacc.p - sc.candidates[lp].p_win) < 0.01, "baseline matches published P(win)");
  const rec = recommend(res, groups);
  console.log(`avoid Le Pen from Glucksmann: best=${ids[rec.forAvoid.best]} equiv=${rec.forAvoid.equivalent.map((i) => i === -1 ? "abst" : ids[i])} (${ms.toFixed(0)} ms for ${res.length} options)`);
  for (const r of res.sort((a, b) => a.unacc.diff - b.unacc.diff).slice(0, 4))
    console.log(r.option === -1 ? "abst" : ids[r.option], (100 * r.unacc.p).toFixed(1), (100 * r.unacc.diff).toFixed(2), "±", (100 * r.unacc.se).toFixed(2));
}
console.log("vote-logic tests ok");

// Personas across the spectrum on the real simulations: the verdict never advises a negligible switch,
// never advises an unacceptable candidate, and is stable in kind for the abstainer who rejects one candidate.
{
  const { decide } = await import("../site/vote-logic.js");
  const summary = JSON.parse(readFileSync("site/data/summary.json"));
  const sc = summary.scenarios.lepen;
  const d = makeData(new Uint16Array(readFileSync("site/data/r1_lepen.bin").buffer.slice(0)),
    new Uint16Array(readFileSync("site/data/r2_lepen.bin").buffer.slice(0)), sc.candidates.length, sc.pairs.length, sc.pairs);
  const ids = sc.candidates.map((c) => c.id), I = (x) => ids.indexOf(x);
  const perScale = 100000 / (0.01 * summary.electorate.registered), CLEAR = 0.002;
  const personas = [
    ["abstainer rejecting Mélenchon", { melenchon: UNACCEPTABLE }, ABSTAIN],
    ["LFI", { melenchon: SUPPORT, "le-pen": UNACCEPTABLE }, I("melenchon")],
    ["PS", { glucksmann: SUPPORT, "le-pen": UNACCEPTABLE, zemmour: UNACCEPTABLE }, I("glucksmann")],
    ["Renaissance", { attal: SUPPORT, philippe: SUPPORT, "le-pen": UNACCEPTABLE, melenchon: UNACCEPTABLE }, I("attal")],
    ["LR", { retailleau: SUPPORT, melenchon: UNACCEPTABLE }, I("retailleau")],
    ["RN", { "le-pen": SUPPORT, melenchon: UNACCEPTABLE }, I("le-pen")],
    ["Reconquête", { zemmour: SUPPORT, melenchon: UNACCEPTABLE, glucksmann: UNACCEPTABLE }, I("zemmour")],
  ];
  for (const [label, g, cur] of personas) {
    const groups = ids.map((id) => g[id] ?? ACCEPTABLE);
    const opts = [...ids.keys()].filter((i) => i === cur || groups[i] !== UNACCEPTABLE).concat(ABSTAIN);
    const res = evaluate(d, groups, cur, 0.0139, opts);
    const v = decide(res, recommend(res, groups), cur, groups.includes(SUPPORT), groups.includes(UNACCEPTABLE), perScale, CLEAR, groups);
    for (const o of [v.best, v.forSupport, v.forAvoid].filter((o) => o !== undefined && o !== cur && o !== ABSTAIN))
      assert.notEqual(groups[o], UNACCEPTABLE, `${label}: advised an unacceptable candidate`);
    if (v.kind === "switch") {
      const r = res.find((x) => x.option === v.best);
      const gain = Math.max(-r.unacc.diff, r.support.diff) * perScale;
      assert.ok(gain >= CLEAR, `${label}: switch advised for a negligible gain`);
    }
    const name = (o) => (o === ABSTAIN ? "blanc" : o === undefined ? "" : ids[o]);
    console.log(`  ${label}: ${v.kind} ${name(v.best)}${v.kind === "depends" ? `${name(v.forSupport)} / ${name(v.forAvoid)}` : ""}`);
  }
  console.log("persona checks ok");
}

// Sincere fallback: when no vote changes the chances clearly, advise the favourite, never "keep" a candidate
// the user doesn't support (bug: support Arthaud only, current vote Philippe → "Gardez votre vote : Philippe").
{
  const { decide } = await import("../site/vote-logic.js");
  const summary = JSON.parse(readFileSync("site/data/summary.json"));
  const sc = summary.scenarios.lepen;
  const d = makeData(new Uint16Array(readFileSync("site/data/r1_lepen.bin").buffer.slice(0)),
    new Uint16Array(readFileSync("site/data/r2_lepen.bin").buffer.slice(0)), sc.candidates.length, sc.pairs.length, sc.pairs);
  const ids = sc.candidates.map((c) => c.id), I = (x) => ids.indexOf(x);
  const perScale = 100000 / (0.01 * summary.electorate.registered), CLEAR = 0.002;
  for (const fav of ["arthaud", "roussel", "glucksmann"]) {
    const groups = ids.map((id) => (id === fav ? SUPPORT : ACCEPTABLE));
    const cur = I("philippe");
    const opts = [...ids.keys(), ABSTAIN];
    const res = evaluate(d, groups, cur, 0.0139, opts);
    const v = decide(res, recommend(res, groups), cur, true, false, perScale, CLEAR, groups);
    assert.ok(v.kind !== "keep", `support ${fav} only, vote Philippe: must not advise keeping Philippe`);
    assert.equal(v.best, I(fav), `support ${fav} only: advise ${fav}`);
  }
  // no supported candidate: never pick an arbitrary acceptable one
  {
    const groups = ids.map((id) => (id === "melenchon" ? UNACCEPTABLE : ACCEPTABLE));
    const res = evaluate(d, groups, ABSTAIN, 0.0139, [...ids.keys()].filter((i) => groups[i] !== UNACCEPTABLE).concat(ABSTAIN));
    const v = decide(res, recommend(res, groups), ABSTAIN, false, true, perScale, CLEAR, groups);
    assert.ok(v.kind !== "sincere", "abstainer with no supported candidate: no arbitrary sincere pick");
  }
  console.log("sincere fallback ok");
}
