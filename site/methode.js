import { frDate, loadSummary } from "./common.js";

const [summary, bt] = await Promise.all([loadSummary(), fetch("data/backtest.json", { cache: "no-cache" }).then((r) => r.json())]);
const sc = summary.scenarios.lepen;
const allCands = Object.values(summary.scenarios).flatMap((x) => x.candidates);
const name = (id) => allCands.find((c) => c.id === id)?.name ?? id;
const pct = (x) => `${Math.round(100 * x)} %`;

document.getElementById("lineup").textContent = sc.candidates.map((c) => c.name).sort((a, b) => a.localeCompare(b, "fr")).join(", ");
document.getElementById("excluded").textContent = summary.pollsters_excluded.length
  ? `Instituts écartés aujourd'hui car ils ne testent pas cette liste : ${summary.pollsters_excluded.join(", ")}.` : "";

document.getElementById("polls").innerHTML = `<thead><tr><th>Institut</th><th>Terrain</th><th class="num">Échantillon</th><th class="num">Poids</th><th>Source</th></tr></thead><tbody>` +
  summary.polls_used.map((p) => `<tr><td>${p.pollster}</td><td>${frDate(p.start)} – ${frDate(p.end)}</td><td class="num">${p.n ?? "—"}</td>` +
    `<td class="num">${p.weight.toFixed(2)}</td><td class="small">${String(p.ref).startsWith("http") ? `<a href="${p.ref}">document</a>` : `notice ${p.ref}`}</td></tr>`).join("") + `</tbody>`;

const horizons = Object.entries(bt.mae_by_horizon);
document.getElementById("mae").innerHTML = `<thead><tr><th>Jours avant le 1er tour</th>${horizons.map(([d]) => `<th class="num">${d}</th>`).join("")}</tr></thead>` +
  `<tbody><tr><td>Erreur moyenne par candidat (points)</td>${horizons.map(([, v]) => `<td class="num">${v.toFixed(1)}</td>`).join("")}</tr></tbody>`;
document.getElementById("nu").textContent = bt.nu;

const hits = (x) => `${Math.round(100 * x)} fois sur 100`;
document.getElementById("coverage").innerHTML = [["50", "0.5"], ["80", "0.8"], ["95", "0.95"]].map(([lv, k]) =>
  `<li>Fourchette à ${lv} chances sur 100 : le vrai score y est tombé <strong>${hits(bt.coverage_all[k])}</strong> ` +
  `(${hits(bt.coverage_late[k])} pour les prévisions faites dans les deux dernières semaines).</li>`).join("");

const b = summary.params.r2_rn_bias;
const toPts = (logit) => (100 * (1 / (1 + Math.exp(-logit)) - 0.5)).toFixed(1).replace(".", ",");
document.getElementById("rnbias").textContent = `environ ${toPts(-b.mean)} point(s) retiré(s) au candidat RN dans un duel serré (± ${toPts(b.sd)})`;

document.getElementById("r2polled").innerHTML = `<thead><tr><th>Duel sondé</th><th class="num">Moyenne</th><th class="num">Sondages</th><th>Dernier</th></tr></thead><tbody>` +
  summary.r2_polled.map((r) => {
    const a = 100 / (1 + Math.exp(-r.logit_a));
    return `<tr><td>${name(r.a)} – ${name(r.b)}</td><td class="num">${a.toFixed(0)} – ${(100 - a).toFixed(0)}</td><td class="num">${r.n_polls}</td><td>${frDate(r.last)}</td></tr>`;
  }).join("") + `</tbody>`;
