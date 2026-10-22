import { chances, earlyBanner, frDate, getScenario, inBlackout, isEarly, loadSummary, scenarioTabs } from "./common.js";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, decide, decisiveChange, evaluate, makeData, recommend } from "./vote-logic.js";

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
  document.getElementById("early").innerHTML = earlyBanner(summary, true);
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
  if (inBlackout()) {
    out.innerHTML = `<p class="box warn">L'outil est suspendu la veille et le jour du vote, comme le prévoit la loi n° 77-808. Il revient le dimanche à 20 h.</p>`;
    return;
  }
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
  out.innerHTML = verdict(runs[0], recs, runs, groups, current, hasSupport, hasUnacc, data, deltas[0]) + table(runs[0], current, hasSupport, hasUnacc);
}

const voteFor = (o) => (o === ABSTAIN ? "voter blanc ou vous abstenir" : `voter pour ${nameOfIdx(o)}`);
const currentLabel = (o) => (o === ABSTAIN ? "ne pas choisir de candidat" : `votre choix actuel, ${nameOfIdx(o)}`);

function verdict(res, recs, runs, groups, current, hasSupport, hasUnacc, data, delta) {
  if (groups.every((g) => g === groups[0])) return `<p class="verdict">Vous avez mis tous les candidats dans le même groupe. Aucun vote ne change donc le résultat pour vous.</p>`;
  const d = decide(res, recs[0], current, hasSupport, hasUnacc, perScale(), CLEAR_EFFECT);
  const row = (o) => res.find((r) => r.option === o);
  const base = row(current);
  const today = isEarly(summary) ? "aujourd'hui " : "";
  let html = "";
  if (d.kind === "keep") {
    html += `<p class="verdict">D'après vos réponses, aucune option ne fait ${today}nettement mieux que ${currentLabel(current)}.</p>`;
    html += effectSentence(null, base, hasSupport, hasUnacc);
  } else if (d.kind === "switch") {
    html += `<p class="verdict">D'après vos réponses, <strong class="better">${voteFor(d.best)}</strong> ${isEarly(summary) ? "serait aujourd'hui" : "est"} plus efficace que ${currentLabel(current)}.</p>`;
    html += effectSentence(row(d.best), base, hasSupport, hasUnacc);
    const ch = decisiveChange(data, current, d.best, delta);
    if (ch) html += `<p>Si environ 500 000 électeurs comme vous faisaient ce choix, le second tour changerait dans ${fmt(ch.share)} simulations sur 100. ` +
      `Le plus souvent, ${nameOfIdx(ch.entered)} y accéderait à la place de ${nameOfIdx(ch.left)}.</p>`;
  } else {
    html += `<p class="verdict">Cela dépend de ce qui compte le plus pour vous.</p><ul>` +
      `<li>Si vous voulez avant tout qu'un candidat que vous soutenez gagne, le plus efficace est de ${voteFor(d.forSupport)}.</li>` +
      `<li>Si vous voulez avant tout éviter qu'un candidat inacceptable gagne, le plus efficace est de ${voteFor(d.forAvoid)}.</li></ul>`;
  }
  const kinds = runs.map((r, n) => JSON.stringify(decide(r, recs[n], current, hasSupport, hasUnacc, perScale(), CLEAR_EFFECT)));
  if (kinds.some((k) => k !== kinds[0])) html += `<p class="small box warn">La réponse change selon le nombre d'électeurs qui font ce choix, de quelques centaines de milliers à un million. Elle est donc fragile.</p>`;
  return html;
}

const perScale = () => PER / (BLOC_SHARES[0] * summary.electorate.registered);
const pts = (d) => (100 * Math.abs(d) * perScale()).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tier(diff, se) {
  if (Math.abs(diff) <= 2 * se) return "pas de différence mesurable";
  return Math.abs(diff) * perScale() >= CLEAR_EFFECT ? "nettement" : "un peu";
}

// « baisse de 0,12 point, un peu mieux pour vous »; good = the direction the user wants.
function effectClause(m, good) {
  if (Math.abs(m.diff) <= 2 * m.se) return "ne change pas de façon mesurable";
  const better = good === "down" ? m.diff < 0 : m.diff > 0;
  return `${m.diff < 0 ? "baisse" : "augmente"} de ${pts(m.diff)} point, ${tier(m.diff, m.se)} ${better ? "mieux" : "moins bien"} pour vous`;
}

function effectSentence(opt, base, hasSupport, hasUnacc) {
  const now = [hasUnacc ? `${chances(base.unacc.p)} qu'un candidat que vous jugez inacceptable gagne` : "",
    hasSupport ? `${chances(base.support.p)} qu'un candidat que vous soutenez gagne` : ""].filter(Boolean).join(", et ");
  let html = `<p>Aujourd'hui, il y a ${now}.`;
  if (opt) {
    const parts = [];
    if (hasUnacc) parts.push(`la probabilité qu'un candidat inacceptable gagne ${effectClause(opt.unacc, "down")}`);
    if (hasSupport) parts.push(`la probabilité qu'un candidat que vous soutenez gagne ${effectClause(opt.support, "up")}`);
    html += ` Pour chaque groupe de 100 000 électeurs qui feraient ce choix, ${parts.join(", et ")}.`;
  }
  return html + `</p>`;
}

// sign = +1 when a higher probability is better for the user, −1 when lower is better: "+" always means better
function signed(m, isCurrent, sign) {
  if (isCurrent) return "—";
  if (Math.abs(m.diff) <= 2 * m.se) return "≈ 0";
  return `${sign * m.diff < 0 ? "−" : "+"}${pts(m.diff)}`;
}

function table(res, current, hasSupport, hasUnacc) {
  const sorted = [...res].sort((a, b) => (hasUnacc ? a.unacc.diff - b.unacc.diff : b.support.diff - a.support.diff));
  const head = `<tr><th>Voter pour…</th>${hasSupport ? "<th class='num'>Faire gagner un candidat que vous soutenez</th>" : ""}${hasUnacc ? "<th class='num'>Éviter un candidat inacceptable</th>" : ""}</tr>`;
  const body = sorted.map((r) => `<tr${r.option === current ? " class='better'" : ""}><td>${r.option === ABSTAIN ? "blanc / abstention" : sc().candidates[r.option].name}${r.option === current ? " (votre choix actuel)" : ""}</td>` +
    (hasSupport ? `<td class="num">${signed(r.support, r.option === current, 1)}</td>` : "") + (hasUnacc ? `<td class="num">${signed(r.unacc, r.option === current, -1)}</td>` : "") + `</tr>`).join("");
  return `<h3>Toutes les options</h3><p class="small muted">Effet, en points de probabilité, si 100 000 électeurs passaient de votre choix actuel à cette option. ` +
    `Un nombre positif signifie que l'option fait mieux que votre choix actuel. « ≈ 0 » signifie qu'il n'y a pas de différence mesurable.</p>` +
    `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

renderInputs();
update();
