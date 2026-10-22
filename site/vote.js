import { caveat, getScenario, help, inBlackout, isEarly, loadSummary, scenarioTabs } from "./common.js";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, advise, decisiveChange, evaluate, makeData } from "./vote-logic.js";

const BLOC_SHARE = 0.02; // the group of voters « like you »: 2 % of registered voters ≈ « un million »
const SMALL_GAP = 0.01; // below 1 point out of 100, the advice says the gap with the planned vote is small
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
  document.getElementById("caveat").innerHTML = caveat(summary);
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
  // supported candidates are always options, however small; others only if they reach R2 sometimes
  const eligible = (c, i) => i === current || groups[i] === SUPPORT || (c.p_qualify >= MIN_QUALIFY_OPTION && groups[i] !== UNACCEPTABLE);
  const options = [...sc().candidates.map((c, i) => (eligible(c, i) ? i : null)).filter((i) => i !== null), ABSTAIN];
  if (!options.includes(current)) options.push(current);
  const delta = BLOC_SHARE / summary.electorate.expressed_r1; // the group as a fraction of R1 expressed votes
  const res = evaluate(data, groups, current, delta, options);
  out.innerHTML = verdict(res, groups, current, hasSupport, hasUnacc, data, delta) + table(res, current, hasSupport, hasUnacc);
}

const nameOf = (o) => (o === ABSTAIN ? "blanc ou l'abstention" : nameOfIdx(o));
const pct = (p, other) => {
  // whole numbers, unless rounding would make the two values look identical
  const d = Math.round(100 * p) === Math.round(100 * other) ? 1 : 0;
  return (100 * p).toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });
};

// Both displayed metrics go up when things improve: « éviter » is 1 − P(an unacceptable candidate wins).
const avoid = (m) => ({ p: 1 - m.p, diff: -m.diff, se: m.se });

// « de 23 à 31 sur 100 » in bold green with ▲ if it rises (better for the user), bold red with ▼ if it falls,
// plain if the change is within the noise. The arrow keeps the meaning readable without colour.
function change(m, b, suffix = " sur 100") {
  const text = `de ${pct(b.p, m.p)} à ${pct(m.p, b.p)}${suffix}`;
  if (Math.abs(m.diff) <= 2 * m.se) return text;
  const up = m.diff > 0;
  return `<strong class="${up ? "good" : "bad"}">${text} ${up ? "▲" : "▼"}</strong>`;
}

// « Les chances d'éviter un candidat que vous jugez inacceptable passeraient de 23 à 31 sur 100. »
function effects(row, base, hasSupport, hasUnacc) {
  const items = [];
  if (hasUnacc) items.push(`Les chances d'éviter un candidat que vous jugez inacceptable passeraient ${change(avoid(row.unacc), avoid(base.unacc))}.`);
  if (hasSupport) items.push(`Les chances qu'un candidat que vous soutenez gagne passeraient ${change(row.support, base.support)}.`);
  return `<p class="small">Si environ un million d'électeurs comme vous faisaient ce choix :</p><ul class="small">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
}

// small: the advised vote is only slightly better than the planned one, so the headline says so instead of ordering
function advice(option, current, why, rows, base, hasSupport, hasUnacc, small = false) {
  const head = option === current
    ? (current === ABSTAIN ? "Aucun vote ne change nettement les chances" : `Gardez votre vote : <strong>${nameOfIdx(current)}</strong>`)
    : small ? "Votre choix change peu de chose"
    : (option === ABSTAIN ? "Votez blanc ou abstenez-vous" : `Votez pour <strong>${nameOfIdx(option)}</strong>`);
  return `<div class="advice-block"><p class="advice">${head}</p>${why ? `<p>${why}</p>` : ""}` +
    (option === current ? "" : effects(rows(option), base, hasSupport, hasUnacc)) + `</div>`;
}

function verdict(res, groups, current, hasSupport, hasUnacc, data, delta) {
  if (groups.every((g) => g === groups[0])) return `<p class="verdict">Vous avez mis tous les candidats dans le même groupe. Aucun vote ne change donc le résultat pour vous.</p>`;
  const v = advise(res, current, hasSupport, hasUnacc, groups);
  const rows = (o) => res.find((r) => r.option === o);
  const base = rows(current);
  const now = isEarly(summary) ? "D'après les sondages d'aujourd'hui. " : "";
  // the gap with the planned vote, for the wording only (largest gain over the objectives the user set)
  const gap = (o) => Math.max(hasUnacc ? base.unacc.p - rows(o).unacc.p : -1, hasSupport ? rows(o).support.p - base.support.p : -1);
  const why = (o) => (o === current
    ? (current === ABSTAIN ? "Selon vos réponses, aucun vote ne fait mieux de façon mesurable." : "Aucun autre vote ne fait mieux de façon mesurable.")
    : gap(o) < SMALL_GAP ? `${o === ABSTAIN ? "Voter blanc" : `Voter pour <strong>${nameOfIdx(o)}</strong>`} ferait à peine mieux que votre choix actuel.` : "");
  const pourquoi = (o) => {
    if (o === current) return "";
    const ch = decisiveChange(data, current, o, delta);
    return ch ? help(`<p>Si un million d'électeurs comme vous faisaient ce choix, le second tour changerait dans ${fmt(ch.share)} simulations sur 100. ` +
      `Le plus souvent, ${nameOfIdx(ch.entered)} y accéderait à la place de ${nameOfIdx(ch.left)}.</p>`, "Pourquoi ?") : "";
  };
  const block = (o) => advice(o, current, why(o), rows, base, hasSupport, hasUnacc, o !== current && gap(o) < SMALL_GAP) + pourquoi(o);
  if (!hasSupport || !hasUnacc || v.forAvoid === v.forSupport) return (now ? `<p class="small muted">${now}</p>` : "") + block(v.forAvoid ?? v.forSupport);
  return (now ? `<p class="small muted">${now}</p>` : "") +
    `<h3>Pour éviter un candidat que vous jugez inacceptable</h3>${block(v.forAvoid)}` +
    `<h3>Pour faire gagner un candidat que vous soutenez</h3>${block(v.forSupport)}`;
}


function table(res, current, hasSupport, hasUnacc) {
  const base = res.find((r) => r.option === current);
  const sorted = [...res].sort((a, b) => (hasUnacc ? a.unacc.p - b.unacc.p : b.support.p - a.support.p));
  const cell = (m, b) => {
    const text = `${pct(b.p, m.p)} → ${pct(m.p, b.p)}`;
    if (Math.abs(m.diff) <= 2 * m.se) return text;
    return `<strong class="${m.diff > 0 ? "good" : "bad"}">${text} ${m.diff > 0 ? "▲" : "▼"}</strong>`;
  };
  const head = `<tr><th>Votre vote</th>${hasUnacc ? "<th class='num'>Éviter un candidat inacceptable</th>" : ""}${hasSupport ? "<th class='num'>Un candidat que vous soutenez gagne</th>" : ""}</tr>`;
  const body = sorted.map((r) => `<tr${r.option === current ? " class='better'" : ""}><td>${r.option === ABSTAIN ? "blanc / abstention" : sc().candidates[r.option].name}${r.option === current ? " (votre choix actuel)" : ""}</td>` +
    (hasUnacc ? `<td class="num">${r.option === current ? Math.round(100 * (1 - base.unacc.p)) : cell(avoid(r.unacc), avoid(base.unacc))}</td>` : "") +
    (hasSupport ? `<td class="num">${r.option === current ? Math.round(100 * base.support.p) : cell(r.support, base.support)}</td>` : "") + `</tr>`).join("");
  return `<details><summary>Voir toutes les options</summary><p class="small muted">Chances sur 100, aujourd'hui → si environ un million d'électeurs comme vous faisaient ce choix. ` +
    `▲ en vert : les chances augmentent. ▼ en rouge : elles baissent.</p>` +
    `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></details>`;
}

renderInputs();
update();
