// Run: node tests/vote-logic.test.mjs  (checks the « Mon vote » logic on a toy case and on the real simulations)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, advise, decisiveChange, evaluate, makeData } from "../site/vote-logic.js";

const SHARES = [0.01, 0.005, 0.02]; // group sizes, as in site/vote.js
const CLEAR = 0.002; // « clearly better » threshold per 100 000 voters, as in site/vote.js

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
  const runs = [0.02, 0.01, 0.04].map((dl) => evaluate(d, groups, 2, dl, [1, 2, ABSTAIN]));
  const v = advise(runs, 2, true, true, [1, 1, 1], CLEAR, groups);
  assert.equal(v.forAvoid, 1);
  assert.equal(v.forSupport, 1);
  assert.equal(runs[0].find((r) => r.option === 2).support.diff, 0, "zero move is the identity");
  const ch = decisiveChange(d, 2, 1, 0.02);
  assert.equal(ch.entered, 1); assert.equal(ch.left, 2); assert.ok(Math.abs(ch.share - 0.5) < 1e-9);
  // indifferent voter: everything acceptable → no objective set, nothing to advise
  const flat = advise(runs, 2, false, false, [1, 1, 1], CLEAR, [1, 1, 1]);
  assert.equal(flat.forAvoid, null); assert.equal(flat.forSupport, null);
}

function load(key) {
  const summary = JSON.parse(readFileSync("site/data/summary.json"));
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
  const runs = SHARES.map((f) => evaluate(d, groups, cur, f / summary.electorate.expressed_r1, opts));
  const scales = SHARES.map((f) => 100000 / (f * summary.electorate.registered));
  const v = advise(runs, cur, groups.includes(SUPPORT), groups.includes(UNACCEPTABLE), scales, CLEAR, groups);
  const N = (o) => (o === null ? "—" : o === ABSTAIN ? "blanc" : ids[o]);
  return { v, runs, groups, cur, scales, ids, I, N, sc };
}

// Real simulations: the unperturbed baseline matches the published P(win).
{
  const { v, runs, I, sc } = run("lepen", { "le-pen": UNACCEPTABLE }, "glucksmann");
  const base = runs[0].find((r) => r.option === I("glucksmann"));
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
  ["reported 1: left voter planning Tondelier (sans Attal)", "lu-sans-attal",
    { arthaud: SUPPORT, melenchon: SUPPORT, glucksmann: SUPPORT, tondelier: SUPPORT, roussel: SUPPORT, "le-pen": UNACCEPTABLE, zemmour: UNACCEPTABLE }, "tondelier"],
  ["reported 2: left voter planning Tondelier", "lepen",
    { glucksmann: SUPPORT, melenchon: SUPPORT, roussel: SUPPORT, tondelier: SUPPORT, "dupont-aignan": UNACCEPTABLE, "le-pen": UNACCEPTABLE, retailleau: UNACCEPTABLE, zemmour: UNACCEPTABLE }, "tondelier"],
]) {
  const { v, runs, groups, cur, scales, N, I } = run(key, g, curId);
  for (const [o, k] of [[v.forAvoid, "unacc"], [v.forSupport, "support"]]) {
    if (o === null || o === cur) continue;
    if (o !== ABSTAIN) assert.notEqual(groups[o], UNACCEPTABLE, `${label}: advised an unacceptable candidate`);
    if (v.sincere) { assert.equal(groups[o], SUPPORT, `${label}: sincere pick must be supported`); continue; }
    runs.forEach((res, n) => {
      const r = res.find((x) => x.option === o), gain = k === "unacc" ? -r[k].diff : r[k].diff;
      assert.ok(gain > 2 * r[k].se && gain * scales[n] >= CLEAR, `${label}: ${N(o)} not clearly better at size ${n}`);
    });
  }
  if (label.startsWith("abstainer")) assert.equal(v.forAvoid, ABSTAIN, "abstainer with no supported candidate: no arbitrary pick");
  if (label.startsWith("Arthaud")) assert.deepEqual([v.forSupport, v.sincere], [I("arthaud"), true], "sincere fallback to Arthaud");
  if (label.startsWith("reported")) {
    assert.equal(N(v.forSupport), "glucksmann", `${label}: to make a supported candidate win, Glucksmann`);
    assert.equal(N(v.forAvoid), "philippe", `${label}: to avoid an unacceptable candidate, Philippe`);
  }
  console.log(`  ${label}: éviter → ${N(v.forAvoid)}, faire gagner → ${N(v.forSupport)}${v.sincere ? " (vote sincère)" : ""}`);
}
console.log("vote-logic tests ok");
