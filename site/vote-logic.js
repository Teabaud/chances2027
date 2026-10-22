// Pure decision logic for « Mon vote » (no DOM). Works on the exported simulations:
// r1: S×K first-round shares, r2: S×P second-round shares of the lower-indexed candidate of each pair.
// A bloc of N voters "like you" moves from their current intention to another option; second-round
// preferences are unchanged (same voters, already in the polls). Common random numbers throughout.

export const ABSTAIN = -1;
export const SUPPORT = 2, ACCEPTABLE = 1, UNACCEPTABLE = 0;

export function makeData(r1u16, r2u16, K, P, pairs) {
  const S = r1u16.length / K;
  const r1 = Float64Array.from(r1u16, (v) => v / 10000);
  const r2 = Float64Array.from(r2u16, (v) => v / 10000);
  const pairIndex = new Int32Array(K * K).fill(-1);
  pairs.forEach(([i, j], n) => { pairIndex[i * K + j] = n; pairIndex[j * K + i] = n; });
  return { S, K, P, r1, r2, pairs, pairIndex };
}

// Winner of each draw after moving `delta` (fraction of R1 expressed votes) from `from` to `to`.
export function winners(data, from, to, delta) {
  const { S, K, P, r1, r2, pairs, pairIndex } = data;
  const out = new Int8Array(S);
  const p = new Float64Array(K);
  for (let s = 0; s < S; s++) {
    for (let c = 0; c < K; c++) p[c] = r1[s * K + c];
    if (from !== to && delta > 0) {
      if (from === ABSTAIN) {
        p[to] += delta; // newcomers: renormalising is a common factor, irrelevant to the ranking
      } else {
        const moved = Math.min(delta, p[from]);
        p[from] -= moved;
        if (to !== ABSTAIN) p[to] += moved;
      }
    }
    let a = 0, b = -1;
    for (let c = 1; c < K; c++) {
      if (p[c] > p[a]) { b = a; a = c; } else if (b < 0 || p[c] > p[b]) b = c;
    }
    const n = pairIndex[a * K + b];
    const shareLow = r2[s * P + n];
    const low = pairs[n][0];
    out[s] = shareLow > 0.5 ? low : (low === a ? b : a);
  }
  return out;
}

export function finalists(data, from, to, delta) {
  // same perturbation as winners(), returns the two qualifiers per draw (for the explanation)
  const { S, K, r1 } = data;
  const out = new Int8Array(2 * S);
  const p = new Float64Array(K);
  for (let s = 0; s < S; s++) {
    for (let c = 0; c < K; c++) p[c] = r1[s * K + c];
    if (from !== to && delta > 0) {
      if (from === ABSTAIN) p[to] += delta;
      else { const m = Math.min(delta, p[from]); p[from] -= m; if (to !== ABSTAIN) p[to] += m; }
    }
    let a = 0, b = -1;
    for (let c = 1; c < K; c++) { if (p[c] > p[a]) { b = a; a = c; } else if (b < 0 || p[c] > p[b]) b = c; }
    out[2 * s] = a; out[2 * s + 1] = b;
  }
  return out;
}

// Paired comparison of an option's winners vs the baseline's, for one 0/1 utility.
function paired(winOpt, winBase, good) {
  const S = winOpt.length;
  let sum = 0, sumSq = 0, pOpt = 0;
  for (let s = 0; s < S; s++) {
    const d = good[winOpt[s]] - good[winBase[s]];
    sum += d; sumSq += d * d; pOpt += good[winOpt[s]];
  }
  const mean = sum / S;
  const se = Math.sqrt(Math.max(sumSq / S - mean * mean, 0) / S);
  return { p: pOpt / S, diff: mean, se };
}

// groups[c] ∈ {SUPPORT, ACCEPTABLE, UNACCEPTABLE}; current ∈ candidate index or ABSTAIN.
// Returns per option: P(a supported candidate wins), P(an unacceptable one wins), paired diffs vs current.
export function evaluate(data, groups, current, delta, options) {
  const supported = Int8Array.from(groups, (g) => (g === SUPPORT ? 1 : 0));
  const unacceptable = Int8Array.from(groups, (g) => (g === UNACCEPTABLE ? 1 : 0));
  const base = winners(data, current, current, 0);
  return options.map((opt) => {
    const w = opt === current ? base : winners(data, current, opt, delta);
    return { option: opt, support: paired(w, base, supported), unacc: paired(w, base, unacceptable) };
  });
}

// Best option under each cut-off: (1) maximise P(supported wins), (2) minimise P(unacceptable wins).
// Options within 2 paired s.e. of the leader are equivalent; among them, prefer the one the voter likes most
// (a sincere vote when strategy doesn't matter), abstention ranking just above unacceptable candidates.
export function recommend(results, groups) {
  const liking = (opt) => (opt === ABSTAIN ? 0.5 : groups[opt]);
  const by = (key, sign) => {
    const sorted = [...results].sort((x, y) => sign * (y[key].diff - x[key].diff));
    const lead = sorted[0];
    const equivalent = sorted.filter((r) => Math.abs(r[key].diff - lead[key].diff) <= 2 * Math.hypot(r[key].se, lead[key].se));
    const best = [...equivalent].sort((x, y) => liking(y.option) - liking(x.option) || sign * (y[key].diff - x[key].diff))[0];
    return { best: best.option, equivalent: equivalent.map((r) => r.option) };
  };
  const forSupport = by("support", 1);
  const forAvoid = by("unacc", -1);
  const common = forSupport.equivalent.filter((o) => forAvoid.equivalent.includes(o));
  return { forSupport, forAvoid, robust: common.length > 0 ? common : null };
}

// Which second-round change does the move cause most often? Returns {share, entered, left} or null.
export function decisiveChange(data, from, to, delta) {
  const before = finalists(data, from, from, 0), after = finalists(data, from, to, delta);
  const counts = new Map();
  let changed = 0;
  for (let s = 0; s < data.S; s++) {
    const b = [before[2 * s], before[2 * s + 1]], a = [after[2 * s], after[2 * s + 1]];
    const entered = a.find((x) => !b.includes(x)), left = b.find((x) => !a.includes(x));
    if (entered === undefined) continue;
    changed++;
    const key = `${entered}|${left}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!changed) return null;
  const [key] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  const [entered, left] = key.split("|").map(Number);
  return { share: changed / data.S, entered, left };
}

// Final verdict. An option is advised only if it beats the current choice beyond 2 paired s.e. AND by at least
// `clearEffect` per 100 000 voters (`perScale` converts the computed group's effect to that unit).
// Returns {kind: "keep"} | {kind: "switch", best} | {kind: "sincere", best} | {kind: "depends", forSupport, forAvoid}.
// "sincere": no vote changes the chances clearly, so vote for a candidate you support, provided it does not
// meaningfully hurt either objective (never "keep" a current choice you like less than a supported option).
export function decide(res, rec, current, hasSupport, hasUnacc, perScale, clearEffect, groups) {
  const row = (o) => res.find((r) => r.option === o);
  const clearlyBetter = (r, key) => {
    const gain = key === "unacc" ? -r[key].diff : r[key].diff;
    return gain > 2 * r[key].se && gain * perScale >= clearEffect;
  };
  const bestFor = (key) => {
    const best = key === "unacc" ? rec.forAvoid.best : rec.forSupport.best;
    return best !== current && row(best) && clearlyBetter(row(best), key) ? best : current;
  };
  const forSupport = hasSupport ? bestFor("support") : current;
  const forAvoid = hasUnacc ? bestFor("unacc") : current;
  if (forSupport === current && forAvoid === current) return sincere(res, current, hasSupport, hasUnacc, perScale, clearEffect, groups);
  if (!hasUnacc) return { kind: "switch", best: forSupport };
  if (!hasSupport) return { kind: "switch", best: forAvoid };
  if (forSupport === forAvoid) return { kind: "switch", best: forSupport };
  // one objective says switch, the other says keep: switching is fine if it does not measurably hurt the other
  const hurts = (opt, key) => {
    const m = row(opt)[key];
    return (key === "unacc" ? m.diff : -m.diff) > 2 * m.se;
  };
  if (forAvoid === current && !hurts(forSupport, "unacc")) return { kind: "switch", best: forSupport };
  if (forSupport === current && !hurts(forAvoid, "support")) return { kind: "switch", best: forAvoid };
  return { kind: "depends", forSupport, forAvoid };
}

function sincere(res, current, hasSupport, hasUnacc, perScale, clearEffect, groups) {
  const liking = (o) => (o === ABSTAIN ? 0.5 : groups ? groups[o] : 0);
  const meaningfulHurt = (m, badSign) => badSign * m.diff > 2 * m.se && Math.abs(m.diff) * perScale >= clearEffect;
  const harmless = (r) => !(hasUnacc && meaningfulHurt(r.unacc, 1)) && !(hasSupport && meaningfulHurt(r.support, -1));
  // only towards a candidate you support: among merely acceptable ones, any pick would be arbitrary
  const better = res.filter((r) => r.option !== ABSTAIN && groups?.[r.option] === SUPPORT && liking(r.option) > liking(current) && harmless(r))
    .sort((a, b) => liking(b.option) - liking(a.option) || (b.support.p - a.support.p) || (a.unacc.p - b.unacc.p));
  return better.length ? { kind: "sincere", best: better[0].option } : { kind: "keep" };
}

// Advice that holds at every group size tested (runs[0] is the reference size). If the group sizes disagree,
// fall back to the cautious answer: a sincere vote if one of the sizes gives it, otherwise keep the current vote.
export function decideStable(runs, recs, current, hasSupport, hasUnacc, perScale, clearEffect, groups) {
  const all = runs.map((r, n) => decide(r, recs[n], current, hasSupport, hasUnacc, perScale, clearEffect, groups));
  if (all.every((x) => JSON.stringify(x) === JSON.stringify(all[0])) || ["keep", "sincere"].includes(all[0].kind)) return all[0];
  return all.find((x) => x.kind === "sincere") ?? { kind: "keep" };
}

// Final advice, stable across group sizes. runs[n] = evaluate() for group size n (runs[0] is the reference),
// scales[n] converts that size's effect to « per 100 000 voters ». Compared with the planned vote `current`:
// - "switch" to the option that improves at least one objective clearly and hurts none measurably, at every size
//   (most liked first, then largest gains); optional altAvoid / altSupport: an option that does even better on one
//   objective at the cost of the other, consistently across sizes;
// - "depends" when the two objectives point to different options consistently and no option improves both;
// - otherwise the sincere vote (a supported candidate) or "keep".
// Returns {kind, best?, forSupport?, forAvoid?, altAvoid?, altSupport?}.
export function advise(runs, current, hasSupport, hasUnacc, scales, clearEffect, groups) {
  const keys = [hasUnacc && "unacc", hasSupport && "support"].filter(Boolean);
  const gain = (m, key) => (key === "unacc" ? -m.diff : m.diff);
  const improves = (r, key, n) => gain(r[key], key) > 2 * r[key].se && gain(r[key], key) * scales[n] >= clearEffect;
  const hurts = (r, key) => -gain(r[key], key) > 2 * r[key].se;
  const others = (res) => res.filter((r) => r.option !== current);
  const liking = (o) => (o === ABSTAIN ? 0.5 : groups[o]);
  const intersect = (sets) => sets.reduce((a, b) => a.filter((x) => b.includes(x)));
  // options that make things better without making anything worse, at every size
  const pareto = intersect(runs.map((res, n) => others(res)
    .filter((r) => keys.some((k) => improves(r, k, n)) && !keys.some((k) => hurts(r, k))).map((r) => r.option)));
  // best option for one objective, if it is the same and clearly better at every size
  const bestFor = (key) => {
    const per = runs.map((res, n) => {
      const top = others(res).filter((r) => improves(r, key, n)).sort((a, b) => gain(b[key], key) - gain(a[key], key))[0];
      return top ? top.option : current;
    });
    return per.every((o) => o === per[0]) ? per[0] : null;
  };
  const ref = runs[0];
  const row = (o) => ref.find((r) => r.option === o);
  if (pareto.length) {
    const score = (o) => keys.reduce((t, k) => t + gain(row(o)[k], k), 0);
    const best = [...pareto].sort((a, b) => liking(b) - liking(a) || score(b) - score(a))[0];
    const out = { kind: "switch", best };
    for (const [k, name] of [["unacc", "altAvoid"], ["support", "altSupport"]]) {
      if (!keys.includes(k)) continue;
      const alt = bestFor(k);
      if (alt !== null && alt !== best && alt !== current && gain(row(alt)[k], k) - gain(row(best)[k], k) > 2 * Math.hypot(row(alt)[k].se, row(best)[k].se)) out[name] = alt;
    }
    return out;
  }
  const fa = hasUnacc ? bestFor("unacc") : current, fs = hasSupport ? bestFor("support") : current;
  if (fa !== null && fs !== null && (fa !== current || fs !== current)) {
    if (fa === fs) return { kind: "switch", best: fa };
    if (!hasUnacc) return { kind: "switch", best: fs };
    if (!hasSupport) return { kind: "switch", best: fa };
    return { kind: "depends", forSupport: fs, forAvoid: fa };
  }
  return sincere(ref, current, hasSupport, hasUnacc, scales[0], clearEffect, groups);
}
