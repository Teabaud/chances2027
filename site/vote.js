import { caveat, getScenario, inBlackout, isEarly, loadSummary, scenarioTabs } from "./common.js";
import { ABSTAIN, ACCEPTABLE, SUPPORT, UNACCEPTABLE, decide, decisiveChange, evaluate, makeData, recommend } from "./vote-logic.js";

const BLOC_SHARES = [0.01, 0.005, 0.02]; // of registered voters: computed on a group, checked at 3 sizes
const PER = 100_000; // the « clearly better » threshold is set per 100 000 voters
const SHOWN = 2; // index in BLOC_SHARES of the group whose numbers are shown: 2 % of registered ≈ « un million »
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
  const E = summary.electorate;
  const deltas = BLOC_SHARES.map((f) => f / E.expressed_r1); // bloc as a fraction of R1 expressed votes
  const runs = deltas.map((d) => evaluate(data, groups, current, d, options));
  const recs = runs.map((r) => recommend(r, groups));
  out.innerHTML = verdict(runs, recs, groups, current, hasSupport, hasUnacc, data, deltas[SHOWN]) + table(runs[SHOWN], current, hasSupport, hasUnacc);
}

const nameOf = (o) => (o === ABSTAIN ? "blanc ou l'abstention" : nameOfIdx(o));
const pct = (p, other) => {
  // whole numbers, unless rounding would make the two values look identical
  const d = Math.round(100 * p) === Math.round(100 * other) ? 1 : 0;
  return (100 * p).toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });
};

// « de 77 à 69 sur 100 », in bold green with « ▲ mieux » if the change helps the user, bold red with « ▼ moins bien »
// if it hurts, plain if it is within the noise. goodDir = −1 when a lower probability is better.
function change(m, b, goodDir, suffix = " sur 100") {
  const text = `de ${pct(b.p, m.p)} à ${pct(m.p, b.p)}${suffix}`;
  if (Math.abs(m.diff) <= 2 * m.se) return text;
  const good = goodDir * m.diff > 0;
  return `<strong class="${good ? "good" : "bad"}">${text} ${good ? "▲ mieux" : "▼ moins bien"}</strong>`;
}

// « Les chances qu'un candidat inacceptable gagne passeraient de 77 à 69 sur 100. »
function effects(row, base, hasSupport, hasUnacc) {
  const items = [];
  if (hasUnacc) items.push(`Les chances qu'un candidat que vous jugez inacceptable gagne passeraient ${change(row.unacc, base.unacc, -1)}.`);
  if (hasSupport) items.push(`Les chances qu'un candidat que vous soutenez gagne passeraient ${change(row.support, base.support, 1)}.`);
  return `<p class="small">Si environ un million d'électeurs comme vous faisaient ce choix :</p><ul class="small">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
}

function advice(option, current, why, rows, base, hasSupport, hasUnacc) {
  const head = option === current
    ? (current === ABSTAIN ? "Aucun vote ne change nettement les chances" : `Gardez votre vote : <strong>${nameOfIdx(current)}</strong>`)
    : (option === ABSTAIN ? "Votez blanc ou abstenez-vous" : `Votez pour <strong>${nameOfIdx(option)}</strong>`);
  return `<div class="advice-block"><p class="advice">${head}</p>${why ? `<p>${why}</p>` : ""}` +
    (option === current ? "" : effects(rows(option), base, hasSupport, hasUnacc)) + `</div>`;
}

function verdict(runs, recs, groups, current, hasSupport, hasUnacc, data, delta) {
  if (groups.every((g) => g === groups[0])) return `<p class="verdict">Vous avez mis tous les candidats dans le même groupe. Aucun vote ne change donc le résultat pour vous.</p>`;
  const d = decide(runs[0], recs[0], current, hasSupport, hasUnacc, perScale(), CLEAR_EFFECT, groups);
  const shown = runs[SHOWN];
  const rows = (o) => shown.find((r) => r.option === o);
  const base = rows(current);
  const now = isEarly(summary) ? "D'après les sondages d'aujourd'hui. " : "";
  let html = "";
  if (d.kind === "keep") {
    html += advice(current, current, current === ABSTAIN ? `${now}Selon vos réponses, aucun candidat ne fait nettement mieux qu'un autre.`
      : `${now}Selon vos réponses, aucun autre vote ne change nettement les chances.`, rows, base, hasSupport, hasUnacc);
  } else if (d.kind === "sincere") {
    html += advice(d.best, current, `${now}Selon vos réponses, aucun vote ne change nettement les chances. Autant voter pour ` +
      "un candidat que vous soutenez.", rows, base, hasSupport, hasUnacc);
  } else if (d.kind === "switch") {
    html += advice(d.best, current, `${now}C'est le vote qui sert le mieux vos préférences${current === ABSTAIN ? "" : `, mieux que ${nameOf(current)}`}.`, rows, base, hasSupport, hasUnacc);
    const ch = decisiveChange(data, current, d.best, delta);
    if (ch) html += `<p class="small muted">Pourquoi ? Si un million d'électeurs comme vous faisaient ce choix, le second tour changerait dans ${fmt(ch.share)} simulations sur 100. ` +
      `Le plus souvent, ${nameOfIdx(ch.entered)} y accéderait à la place de ${nameOfIdx(ch.left)}.</p>`;
  } else {
    html += `<p>${now}Le meilleur vote dépend de ce qui compte le plus pour vous.</p>` +
      advice(d.forAvoid, current, "Si vous voulez avant tout éviter qu'un candidat que vous jugez inacceptable gagne.", rows, base, hasSupport, hasUnacc) +
      advice(d.forSupport, current, "Si vous voulez avant tout qu'un candidat que vous soutenez gagne.", rows, base, hasSupport, hasUnacc);
  }
  const kinds = runs.map((r, n) => JSON.stringify(decide(r, recs[n], current, hasSupport, hasUnacc, perScale(), CLEAR_EFFECT, groups)));
  if (kinds.some((k) => k !== kinds[0])) html += `<p class="small box warn">Ce conseil change selon le nombre d'électeurs qui font le même choix. Il est donc fragile.</p>`;
  return html;
}

const perScale = () => PER / (BLOC_SHARES[0] * summary.electorate.registered);

function table(res, current, hasSupport, hasUnacc) {
  const base = res.find((r) => r.option === current);
  const sorted = [...res].sort((a, b) => (hasUnacc ? a.unacc.p - b.unacc.p : b.support.p - a.support.p));
  const cell = (m, b, goodDir) => {
    const text = `${pct(b.p, m.p)} → ${pct(m.p, b.p)}`;
    if (Math.abs(m.diff) <= 2 * m.se) return text;
    const good = goodDir * m.diff > 0;
    return `<strong class="${good ? "good" : "bad"}">${text} ${good ? "▲" : "▼"}</strong>`;
  };
  const head = `<tr><th>Votre vote</th>${hasUnacc ? "<th class='num'>Un candidat inacceptable gagne</th>" : ""}${hasSupport ? "<th class='num'>Un candidat que vous soutenez gagne</th>" : ""}</tr>`;
  const body = sorted.map((r) => `<tr${r.option === current ? " class='better'" : ""}><td>${r.option === ABSTAIN ? "blanc / abstention" : sc().candidates[r.option].name}${r.option === current ? " (votre choix actuel)" : ""}</td>` +
    (hasUnacc ? `<td class="num">${r.option === current ? Math.round(100 * base.unacc.p) : cell(r.unacc, base.unacc, -1)}</td>` : "") +
    (hasSupport ? `<td class="num">${r.option === current ? Math.round(100 * base.support.p) : cell(r.support, base.support, 1)}</td>` : "") + `</tr>`).join("");
  return `<details><summary>Voir toutes les options</summary><p class="small muted">Chances sur 100, aujourd'hui → si environ un million d'électeurs comme vous faisaient ce choix. ` +
    `▲ en vert : mieux pour vous. ▼ en rouge : moins bien.</p>` +
    `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></details>`;
}

renderInputs();
update();
