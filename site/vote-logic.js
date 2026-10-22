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

// Advice for each objective, compared with the planned vote `current`, stable across group sizes.
// runs[n] = evaluate() for group size n (runs[0] is the reference size); scales[n] converts that size's effect
// to « per 100 000 voters », so the « clearly better » threshold (clearEffect) means the same at every size.
// For each objective: among the options that beat the current vote clearly at EVERY size, the one with the largest
// gain at the reference size (then the most liked); the current vote if none does.
// If both answers are « keep » and the current vote is not a supported candidate, fall back to the sincere vote:
// a supported candidate that does not meaningfully hurt either objective.
// Returns { forAvoid, forSupport, sincere } (option indices; null for an objective the user did not set).
export function advise(runs, current, hasSupport, hasUnacc, scales, clearEffect, groups) {
  const gain = (m, key) => (key === "unacc" ? -m.diff : m.diff);
  const improves = (r, key, n) => gain(r[key], key) > 2 * r[key].se && gain(r[key], key) * scales[n] >= clearEffect;
  const liking = (o) => (o === ABSTAIN ? 0.5 : groups[o]);
  const ref = runs[0];
  const row = (o) => ref.find((r) => r.option === o);
  const bestFor = (key) => {
    const sets = runs.map((res, n) => res.filter((r) => r.option !== current && improves(r, key, n)).map((r) => r.option));
    const common = sets.reduce((a, b) => a.filter((x) => b.includes(x)));
    if (!common.length) return current;
    return [...common].sort((a, b) => gain(row(b)[key], key) - gain(row(a)[key], key) || liking(b) - liking(a))[0];
  };
  const forAvoid = hasUnacc ? bestFor("unacc") : null;
  const forSupport = hasSupport ? bestFor("support") : null;
  if ([forAvoid, forSupport].every((x) => x === null || x === current)) {
    const s = sincere(ref, current, hasSupport, hasUnacc, scales[0], clearEffect, groups);
    if (s !== null) return { forAvoid: hasUnacc ? s : null, forSupport: hasSupport ? s : null, sincere: true };
  }
  return { forAvoid, forSupport, sincere: false };
}

// Sincere fallback: the most supported option (never an arbitrary acceptable one) that does not meaningfully hurt
// either objective, if the current vote is liked less. Returns an option index or null.
function sincere(res, current, hasSupport, hasUnacc, perScale, clearEffect, groups) {
  const liking = (o) => (o === ABSTAIN ? 0.5 : groups[o]);
  const meaningfulHurt = (m, badSign) => badSign * m.diff > 2 * m.se && Math.abs(m.diff) * perScale >= clearEffect;
  const harmless = (r) => !(hasUnacc && meaningfulHurt(r.unacc, 1)) && !(hasSupport && meaningfulHurt(r.support, -1));
  const better = res.filter((r) => r.option !== ABSTAIN && groups[r.option] === SUPPORT && liking(r.option) > liking(current) && harmless(r))
    .sort((a, b) => b.support.p - a.support.p || a.unacc.p - b.unacc.p);
  return better.length ? better[0].option : null;
}
