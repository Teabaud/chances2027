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
