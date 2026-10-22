import { chances, frDate, getScenario, loadSummary, scenarioTabs } from "./common.js";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, decisiveChange, evaluate, makeData, recommend } from "./vote-logic.js";

const BLOC_SHARES = [0.01, 0.005, 0.02]; // of registered voters: computed on a group, checked at 3 sizes
const PER = 100_000; // effects are shown per 100 000 voters (they scale linearly with the group size)
const CLEAR_EFFECT = 0.002; // ≥ 0.2 point per 100 000 voters counts as « nettement »
const MIN_QUALIFY_OPTION = 0.005;
const GROUP_LABELS = [[SUPPORT, "Je soutiens"], [ACCEPTABLE, "Acceptable"], [UNACCEPTABLE, "Inacceptable"]];

const summary = await loadSummary();
const dataCache = {};
const state = readHash();
let scen = [state.scen, getScenario()].find((k) => summary.scenarios[k]) || "lepen";

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const groups = {};
  for (const item of (h.get("g") || "").split(",").filter(Boolean)) {
    const [id, g] = item.split(":");
    groups[id] = Number(g);
  }
  return { groups, current: h.get("a") || "", scen: h.get("s") || "" };
}

function writeHash() {
  const g = Object.entries(state.groups).filter(([, v]) => v !== ACCEPTABLE).map(([k, v]) => `${k}:${v}`).join(",");
  const h = new URLSearchParams();
  if (g) h.set("g", g);
  if (state.current) h.set("a", state.current);
  if (g || state.current) h.set("s", scen);
  history.replaceState(null, "", h.toString() ? `#${h}` : location.pathname);
}

async function loadData(key) {
  if (dataCache[key]) return dataCache[key];
  const sc = summary.scenarios[key];
  const [b1, b2] = await Promise.all(["r1", "r2"].map((r) => fetch(`data/${r}_${key}.bin`, { cache: "no-cache" }).then((x) => x.arrayBuffer())));
  dataCache[key] = makeData(new Uint16Array(b1), new Uint16Array(b2), sc.candidates.length, sc.pairs.length, sc.pairs);
  return dataCache[key];
}

const sc = () => summary.scenarios[scen];
const alpha = () => [...sc().candidates].sort((a, b) => a.id.localeCompare(b.id, "fr"));
const groupOf = (id) => state.groups[id] ?? ACCEPTABLE;
const nameOfIdx = (i) => (i === ABSTAIN ? "voter blanc ou vous abstenir" : sc().candidates[i].name);
const fmt = (p) => (100 * p).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function renderInputs() {
  scenarioTabs(document.getElementById("scenarios"), summary, scen, (s) => { scen = s; renderInputs(); update(); });
  document.getElementById("asof").textContent = `Sondages au ${frDate(summary.asof)}.`;
  const box = document.getElementById("cands");
  box.innerHTML = "";
  for (const c of alpha()) {
    const row = document.createElement("div");
    row.className = "cand-row";
    row.innerHTML = `<span>${c.name}</span>`;
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", c.name);
    for (const [g, label] of GROUP_LABELS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("aria-pressed", String(groupOf(c.id) === g));
      b.onclick = () => { state.groups[c.id] = g; renderInputs(); update(); };
      seg.append(b);
    }
    row.append(seg);
    box.append(row);
  }
  const cur = document.getElementById("current");
  cur.innerHTML = "";
  cur.add(new Option("Je ne sais pas / blanc / abstention", "abstain"));
  for (const c of alpha()) cur.add(new Option(c.name, c.id));
  cur.value = currentId();
  cur.onchange = () => { state.current = cur.value; update(); };
}

function currentId() {
  if (state.current && (state.current === "abstain" || sc().candidates.some((c) => c.id === state.current))) return state.current;
  const fav = alpha().find((c) => groupOf(c.id) === SUPPORT);
  return fav ? fav.id : "abstain";
}

async function update() {
  writeHash();
  const out = document.getElementById("result");
  const ids = sc().candidates.map((c) => c.id);
  const groups = ids.map(groupOf);
  const hasSupport = groups.includes(SUPPORT), hasUnacc = groups.includes(UNACCEPTABLE);
  if (!hasSupport && !hasUnacc) {
    out.innerHTML = `<p class="muted">Indiquez au moins un candidat que vous soutenez ou que vous jugez inacceptable.</p>`;
    return;
  }
  document.getElementById("current").value = currentId();
  out.innerHTML = `<p class="muted">Calcul en cours…</p>`;
  const data = await loadData(scen);
  const current = currentId() === "abstain" ? ABSTAIN : ids.indexOf(currentId());
  // never propose a vote for a candidate the user finds unacceptable (unless it is their current choice)
  const eligible = (c, i) => i === current || (c.p_qualify >= MIN_QUALIFY_OPTION && groups[i] !== UNACCEPTABLE);
  const options = [...sc().candidates.map((c, i) => (eligible(c, i) ? i : null)).filter((i) => i !== null), ABSTAIN];
  if (!options.includes(current)) options.push(current);
  const E = summary.electorate;
  const deltas = BLOC_SHARES.map((f) => f / E.expressed_r1); // bloc as a fraction of R1 expressed votes
  const runs = deltas.map((d) => evaluate(data, groups, current, d, options));
  const recs = runs.map((r) => recommend(r, groups));
  out.innerHTML = verdict(runs[0], recs, groups, current, hasSupport, hasUnacc, data, deltas[0]) + table(runs[0], current, hasSupport, hasUnacc);
}

function pickRec(rec, hasSupport, hasUnacc, groups) {
  if (hasSupport && !hasUnacc) return { best: rec.forSupport.best, robust: true };
  if (hasUnacc && !hasSupport) return { best: rec.forAvoid.best, robust: true };
  if (rec.robust) {
    const liking = (o) => (o === ABSTAIN ? 0.5 : groups[o]);
    return { best: [...rec.robust].sort((a, b) => liking(b) - liking(a))[0], robust: true };
  }
  return { best: null, robust: false };
}

function verdict(res, recs, groups, current, hasSupport, hasUnacc, data, delta) {
  const rec = recs[0];
  const pick = pickRec(rec, hasSupport, hasUnacc, groups);
  const row = (o) => res.find((r) => r.option === o);
  const base = row(current);
  let html = "";
  if (groups.every((g) => g === groups[0])) return `<p class="verdict">Vous avez mis tous les candidats dans le même groupe : aucun vote ne change le résultat pour vous.</p>`;
  if (pick.robust) {
    const best = pick.best;
    if (best === current) {
      html += `<p class="verdict">D'après vos réponses, <strong>${current === ABSTAIN ? "aucun vote" : `voter ${nameOfIdx(current)}`}</strong> ` +
        `${current === ABSTAIN ? "ne change nettement le résultat pour vous" : "est déjà votre choix le plus efficace"}.</p>`;
    } else {
      html += `<p class="verdict">D'après vos réponses, <strong class="better">${best === ABSTAIN ? "voter blanc ou vous abstenir" : `voter ${nameOfIdx(best)}`}</strong> ` +
        `${current === ABSTAIN ? "plutôt que ne pas choisir" : `plutôt que ${nameOfIdx(current)}`} est votre meilleure option${hasSupport && hasUnacc ? ", quel que soit le poids exact que vous donnez à vos préférences" : ""}.</p>`;
      html += effectSentence(row(best), base, hasSupport, hasUnacc);
      const ch = decisiveChange(data, current, best, delta);
      if (ch) html += `<p>Pourquoi ? Ce changement modifie le second tour dans ${fmt(ch.share)} simulations sur 100 : le plus souvent, <strong>${nameOfIdx(ch.entered)}</strong> y accède à la place de ${nameOfIdx(ch.left)}.</p>`;
    }
  } else {
    html += `<p class="verdict">Cela dépend de ce qui compte le plus pour vous :</p><ul>` +
      `<li>si vous visez avant tout la victoire d'un candidat que vous soutenez : <strong>${nameOfIdx(rec.forSupport.best)}</strong> ;</li>` +
      `<li>si vous voulez avant tout éviter un candidat inacceptable : <strong>${nameOfIdx(rec.forAvoid.best)}</strong>.</li></ul>`;
  }
  const bests = recs.map((r) => pickRec(r, hasSupport, hasUnacc, groups).best);
  if (bests.some((b) => b !== bests[0])) html += `<p class="small box warn">La meilleure option change selon le nombre d'électeurs qui font ce choix (de quelques centaines de milliers à un million) : la réponse est fragile.</p>`;
  const daysLeft = Math.round((Date.parse(summary.r1_date) - Date.parse(summary.asof)) / 864e5);
  if (daysLeft > 60) html += `<p class="small muted">À ${daysLeft} jours du vote, les sondages bougeront encore beaucoup : ces conseils aussi. Revenez dans les dernières semaines.</p>`;
  return html;
}

const perScale = () => PER / (BLOC_SHARES[0] * summary.electorate.registered);
const pts = (d) => (100 * Math.abs(d) * perScale()).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tier(diff, se) {
  if (Math.abs(diff) <= 2 * se) return "équivalent : l'écart est dans le bruit du calcul";
  return Math.abs(diff) * perScale() >= CLEAR_EFFECT ? "nettement" : "un peu";
}

// One clause per metric: « baisse de 0,12 point (un peu mieux) »; good = the direction the user wants.
function effectClause(m, good) {
  if (Math.abs(m.diff) <= 2 * m.se) return `ne change pas vraiment (${tier(m.diff, m.se)})`;
  const better = good === "down" ? m.diff < 0 : m.diff > 0;
  return `${m.diff < 0 ? "baisse" : "monte"} de ${pts(m.diff)} point (${tier(m.diff, m.se)} ${better ? "mieux" : "moins bien"})`;
}

function effectSentence(opt, base, hasSupport, hasUnacc) {
  const parts = [];
  if (hasUnacc) parts.push(`la probabilité qu'un candidat que vous jugez inacceptable gagne ${effectClause(opt.unacc, "down")}`);
  if (hasSupport) parts.push(`celle qu'un candidat que vous soutenez gagne ${effectClause(opt.support, "up")}`);
  const now = [hasUnacc ? `${chances(base.unacc.p)} qu'un candidat inacceptable pour vous gagne` : "",
    hasSupport ? `${chances(base.support.p)} qu'un candidat que vous soutenez gagne` : ""].filter(Boolean).join(", et ");
  return `<p>Aujourd'hui : ${now}. Pour chaque tranche de 100 000 électeurs qui feraient ce choix, ${parts.join(" ; ")}.</p>`;
}

function signed(m, isCurrent) {
  if (isCurrent) return "—";
  if (Math.abs(m.diff) <= 2 * m.se) return "≈ 0";
  return `${m.diff < 0 ? "−" : "+"}${pts(m.diff)}`;
}

function table(res, current, hasSupport, hasUnacc) {
  const sorted = [...res].sort((a, b) => (hasUnacc ? a.unacc.diff - b.unacc.diff : b.support.diff - a.support.diff));
  const head = `<tr><th>Voter pour…</th>${hasSupport ? "<th class='num'>Un candidat que vous soutenez gagne</th>" : ""}${hasUnacc ? "<th class='num'>Un candidat inacceptable gagne</th>" : ""}</tr>`;
  const body = sorted.map((r) => `<tr${r.option === current ? " class='better'" : ""}><td>${r.option === ABSTAIN ? "blanc / abstention" : sc().candidates[r.option].name}${r.option === current ? " (votre choix actuel)" : ""}</td>` +
    (hasSupport ? `<td class="num">${signed(r.support, r.option === current)}</td>` : "") + (hasUnacc ? `<td class="num">${signed(r.unacc, r.option === current)}</td>` : "") + `</tr>`).join("");
  return `<h3>Toutes les options</h3><p class="small muted">Changement de probabilité, en points, pour 100 000 électeurs qui passeraient de votre choix actuel à cette option. ` +
    `« ≈ 0 » : pas de différence mesurable.</p>` +
    `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

renderInputs();
update();
