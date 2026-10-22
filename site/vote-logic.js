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

// The two qualifiers of each draw after moving `delta` (fraction of R1 expressed votes) from `from` to `to`
// (to/from ABSTAIN: voters joining or leaving). Returns [a0, b0, a1, b1, …].
export function finalists(data, from, to, delta) {
  const { S, K, r1 } = data;
  const out = new Int8Array(2 * S);
  const p = new Float64Array(K);
  for (let s = 0; s < S; s++) {
    for (let c = 0; c < K; c++) p[c] = r1[s * K + c];
    if (from !== to && delta > 0) {
      if (from === ABSTAIN) p[to] += delta; // newcomers: renormalising is a common factor, irrelevant to the ranking
      else { const moved = Math.min(delta, p[from]); p[from] -= moved; if (to !== ABSTAIN) p[to] += moved; }
    }
    let a = 0, b = -1;
    for (let c = 1; c < K; c++) { if (p[c] > p[a]) { b = a; a = c; } else if (b < 0 || p[c] > p[b]) b = c; }
    out[2 * s] = a; out[2 * s + 1] = b;
  }
  return out;
}

// Winner of each draw for the same move: the qualifier who wins that draw's simulated second round.
export function winners(data, from, to, delta) {
  const { S, K, P, r2, pairs, pairIndex } = data;
  const top2 = finalists(data, from, to, delta);
  const out = new Int8Array(S);
  for (let s = 0; s < S; s++) {
    const a = top2[2 * s], b = top2[2 * s + 1], n = pairIndex[a * K + b], low = pairs[n][0];
    out[s] = r2[s * P + n] > 0.5 ? low : (low === a ? b : a);
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
    // winners kept so two options can be compared draw by draw (same simulations: much less noise)
    return { option: opt, support: paired(w, base, supported), unacc: paired(w, base, unacceptable), winners: w };
  });
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

// Advice for each objective, from one simulated group of voters « like you » (res = evaluate(...)).
// For each objective, the option with the best result. Options whose gap to that best result is within the simulation
// noise (compared draw by draw on the same simulations) count as equally good; among them, the one the user likes
// most: a supported candidate, then the planned vote, then an acceptable candidate, then blank/abstention.
// The planned vote is never advised if the user marked it unacceptable. Size of the gap is for the wording, not here.
// Returns { forAvoid, forSupport } (option indices; null for an objective the user did not set).
export function advise(res, current, hasSupport, hasUnacc, groups) {
  const good = { unacc: Int8Array.from(groups, (g) => (g === UNACCEPTABLE ? 1 : 0)), support: Int8Array.from(groups, (g) => (g === SUPPORT ? 1 : 0)) };
  const value = (r, key) => (key === "unacc" ? 1 - r.unacc.p : r.support.p); // higher is better for both
  const rank = (o) => (o === current ? (o !== ABSTAIN && groups[o] === UNACCEPTABLE ? -1 : o !== ABSTAIN && groups[o] === SUPPORT ? 3 : 1.5)
    : o === ABSTAIN ? 0.5 : groups[o] === SUPPORT ? 2 : groups[o]);
  const allowed = res.filter((r) => rank(r.option) >= 0);
  const bestFor = (key) => {
    const top = allowed.reduce((a, b) => (value(b, key) > value(a, key) ? b : a));
    const sign = key === "unacc" ? -1 : 1; // paired() counts « good » outcomes; for unacc, fewer is better
    const equal = allowed.filter((r) => {
      if (r === top) return true;
      const d = paired(top.winners, r.winners, good[key]);
      return Math.abs(sign * d.diff) <= 2 * d.se;
    });
    return equal.sort((a, b) => rank(b.option) - rank(a.option) || value(b, key) - value(a, key))[0].option;
  };
  return { forAvoid: hasUnacc ? bestFor("unacc") : null, forSupport: hasSupport ? bestFor("support") : null };
}
