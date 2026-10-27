// Run: node tests/vote-logic.test.mjs  (checks the « Mon vote » logic on a toy case and on the real simulations)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, advise, decisiveChange, evaluate, makeData } from "../site/vote-logic.js";

const SHARE = 0.02; // group of voters « like you », as in site/vote.js

// Toy: A=0 leads; B=1 and C=2 tie for 2nd. B beats A in R2, C loses to A. Moving to B helps both objectives.
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
  const res = evaluate(d, groups, 2, 0.02, [1, 2, ABSTAIN]);
  const v = advise(res, 2, true, true, groups);
  assert.equal(v.forAvoid, 1);
  assert.equal(v.forSupport, 1);
  assert.equal(res.find((r) => r.option === 2).support.diff, 0, "zero move is the identity");
  const ch = decisiveChange(d, 2, 1, 0.02);
  assert.equal(ch.entered, 1); assert.equal(ch.left, 2); assert.ok(Math.abs(ch.share - 0.5) < 1e-9);
  // indifferent voter: everything acceptable → no objective set, nothing to advise
  const flat = advise(res, 2, false, false, [1, 1, 1]);
  assert.equal(flat.forAvoid, null); assert.equal(flat.forSupport, null);
}

// Toy: user plans A (unacceptable), supports B, accepts C. B and C swap 2nd place half the time.
function planningA(r2) {
  const S = 1000, K = 3, pairs = [[0, 1], [0, 2], [1, 2]];
  const r1 = new Uint16Array(S * K), r2u = new Uint16Array(S * 3);
  for (let s = 0; s < S; s++) {
    const tilt = (s % 2 ? 1 : -1) * 50;
    r1.set([4000, 3000 + tilt, 3000 - tilt], s * K);
    r2u.set(r2, s * 3);
  }
  const groups = [UNACCEPTABLE, SUPPORT, ACCEPTABLE];
  return advise(evaluate(makeData(r1, r2u, K, 3, pairs), groups, 0, 0.02, [1, 2, ABSTAIN]), 0, true, true, groups);
}
// A loses to both B and C: every option stops A equally → the tie goes to the supported candidate.
assert.equal(planningA([4000, 4000, 5000]).forAvoid, 1, "tie within noise → supported candidate");
// A beats B but loses to C: only C stops A → the acceptable candidate, although B is supported.
assert.equal(planningA([6000, 4000, 5000]).forAvoid, 2, "measurably better → acceptable candidate over supported");

// "lepen" = the reference scenario; any other name = the Le Pen line-up with that label (e.g. "sans Attal")
function scenarioKey(summary, name) {
  if (name === "lepen") return summary.reference;
  const key = Object.keys(summary.scenarios).find((k) => summary.scenarios[k].rn === "lepen" && summary.scenarios[k].label === name);
  assert.ok(key, `no scenario labelled ${name}`);
  return key;
}

function load(name) {
  const summary = JSON.parse(readFileSync("site/data/summary.json"));
  const key = scenarioKey(summary, name);
  const sc = summary.scenarios[key];
  const d = makeData(new Uint16Array(readFileSync(`site/data/r1_${key}.bin`).buffer.slice(0)),
    new Uint16Array(readFileSync(`site/data/r2_${key}.bin`).buffer.slice(0)), sc.candidates.length, sc.pairs.length, sc.pairs);
  const ids = sc.candidates.map((c) => c.id);
  return { summary, sc, d, ids, I: (x) => ids.indexOf(x) };
}

// The same option set and group sizes as the page.
function run(key, g, curId) {
  const { summary, sc, d, ids, I } = load(key);
  const groups = ids.map((id) => g[id] ?? ACCEPTABLE);
  const cur = curId === "abstain" ? ABSTAIN : I(curId);
  const opts = [...ids.keys()].filter((i) => i === cur || groups[i] === SUPPORT || (sc.candidates[i].p_qualify >= 0.005 && groups[i] !== UNACCEPTABLE)).concat(ABSTAIN);
  const res = evaluate(d, groups, cur, SHARE / summary.electorate.expressed_r1, opts);
  const v = advise(res, cur, groups.includes(SUPPORT), groups.includes(UNACCEPTABLE), groups);
  const N = (o) => (o === null ? "—" : o === ABSTAIN ? "blanc" : ids[o]);
  return { v, res, groups, cur, ids, I, N, sc };
}

// Real simulations: the unperturbed baseline matches the published P(win).
{
  const { v, res, I, sc } = run("lepen", { "le-pen": UNACCEPTABLE }, "glucksmann");
  const base = res.find((r) => r.option === I("glucksmann"));
  assert.ok(Math.abs(base.unacc.p - sc.candidates[I("le-pen")].p_win) < 0.01, "baseline matches published P(win)");
  assert.equal(v.forSupport, null);
}

// Personas across the spectrum: never an unacceptable candidate; each advised switch beats the current vote
// clearly at every group size; sincere picks are supported candidates; no arbitrary pick for an abstainer.
for (const [label, key, g, curId] of [
  ["abstainer rejecting Mélenchon", "lepen", { melenchon: UNACCEPTABLE }, "abstain"],
  ["LFI", "lepen", { melenchon: SUPPORT, "le-pen": UNACCEPTABLE }, "melenchon"],
  ["PS", "lepen", { glucksmann: SUPPORT, "le-pen": UNACCEPTABLE, zemmour: UNACCEPTABLE }, "glucksmann"],
  ["Renaissance", "lepen", { attal: SUPPORT, philippe: SUPPORT, "le-pen": UNACCEPTABLE, melenchon: UNACCEPTABLE }, "attal"],
  ["LR", "lepen", { retailleau: SUPPORT, melenchon: UNACCEPTABLE }, "retailleau"],
  ["RN", "lepen", { "le-pen": SUPPORT, melenchon: UNACCEPTABLE }, "le-pen"],
  ["Reconquête", "lepen", { zemmour: SUPPORT, melenchon: UNACCEPTABLE, glucksmann: UNACCEPTABLE }, "zemmour"],
  ["Arthaud fan voting Philippe", "lepen", { arthaud: SUPPORT }, "philippe"],
  ["planning to vote for an unacceptable candidate (Le Pen)", "lepen", { glucksmann: SUPPORT, "le-pen": UNACCEPTABLE }, "le-pen"],
  ["planning Le Pen, rejecting her, nothing supported", "lepen", { "le-pen": UNACCEPTABLE }, "le-pen"],
  ["reported 1: left voter planning Tondelier (sans Attal)", "sans Attal",
    { arthaud: SUPPORT, melenchon: SUPPORT, glucksmann: SUPPORT, tondelier: SUPPORT, roussel: SUPPORT, "le-pen": UNACCEPTABLE, zemmour: UNACCEPTABLE }, "tondelier"],
  ["reported 2: left voter planning Tondelier", "lepen",
    { glucksmann: SUPPORT, melenchon: SUPPORT, roussel: SUPPORT, tondelier: SUPPORT, "dupont-aignan": UNACCEPTABLE, "le-pen": UNACCEPTABLE, retailleau: UNACCEPTABLE, zemmour: UNACCEPTABLE }, "tondelier"],
]) {
  const { v, res, groups, cur, N, I } = run(key, g, curId);
  const row = (o) => res.find((r) => r.option === o);
  for (const [o, k] of [[v.forAvoid, "unacc"], [v.forSupport, "support"]]) {
    if (o === null) continue;
    if (o !== ABSTAIN) assert.notEqual(groups[o], UNACCEPTABLE, `${label}: advised an unacceptable candidate (or kept one)`);
    // the answer is the best result, or equal to it within noise
    const value = (r) => (k === "unacc" ? 1 - r.unacc.p : r.support.p);
    const best = Math.max(...res.filter((r) => r.option === ABSTAIN || groups[r.option] !== UNACCEPTABLE || r.option !== cur).map(value));
    assert.ok(best - value(row(o)) < 0.02, `${label}: ${N(o)} is far from the best result`);
  }
  // leaving the planned vote only when the result is measurably better (otherwise the planned vote wins the tie)
  for (const o of [v.forAvoid, v.forSupport]) if (o !== null && o !== cur && groups[cur] !== UNACCEPTABLE && groups[o] !== SUPPORT) {
    const r = row(o);
    assert.ok((v.forAvoid === o && -r.unacc.diff > 2 * r.unacc.se) || (v.forSupport === o && r.support.diff > 2 * r.support.se), `${label}: left the planned vote within noise`);
  }
  // ponytail: no expected names here, the real simulations change daily; fixed outcomes live in the toy cases above
  console.log(`  ${label}: éviter → ${N(v.forAvoid)}, faire gagner → ${N(v.forSupport)}`);
}
console.log("vote-logic tests ok");
