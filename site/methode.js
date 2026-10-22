import { frDate, loadSummary } from "./common.js";

const [summary, bt] = await Promise.all([loadSummary(), fetch("data/backtest.json", { cache: "no-cache" }).then((r) => r.json())]);
const sc = summary.scenarios[summary.reference];
const allCands = Object.values(summary.scenarios).flatMap((x) => x.candidates);
const name = (id) => allCands.find((c) => c.id === id)?.name ?? id;
const pct = (x) => `${Math.round(100 * x)} %`;

document.getElementById("lineup").textContent = sc.candidates.map((c) => c.name).sort((a, b) => a.localeCompare(b, "fr")).join(", ");

document.getElementById("polls").innerHTML = `<thead><tr><th>Institut</th><th>Commanditaire</th><th>Terrain</th><th class="num">Échantillon</th><th>Notice</th></tr></thead><tbody>` +
  summary.polls_used.map((p) => `<tr><td>${p.pollster}</td><td>${p.sponsor ?? "voir la notice"}</td><td>du ${frDate(p.start)} au ${frDate(p.end)}</td>` +
    `<td class="num">${p.n ?? "non indiqué"}</td><td class="small">${String(p.ref).startsWith("http") ? `<a href="${p.ref}">notice</a>` : `n° ${String(p.ref).split("-")[0]}`}</td></tr>`).join("") + `</tbody>`;

const horizons = Object.entries(bt.mae_by_horizon);
document.getElementById("mae").innerHTML = `<thead><tr><th>Jours avant le 1er tour</th>${horizons.map(([d]) => `<th class="num">${d}</th>`).join("")}</tr></thead>` +
  `<tbody><tr><td>Erreur moyenne par candidat (points)</td>${horizons.map(([, v]) => `<td class="num">${v.toFixed(1)}</td>`).join("")}</tr></tbody>`;
document.getElementById("nu").textContent = bt.nu;

const hits = (x) => `${Math.round(100 * x)} fois sur 100`;
document.getElementById("coverage").innerHTML = [["50", "0.5"], ["80", "0.8"], ["95", "0.95"]].map(([lv, k]) =>
  `<li>Pour la fourchette à ${lv} chances sur 100, le vrai score y est tombé ${hits(bt.coverage_all[k])}, ` +
  `et ${hits(bt.coverage_late[k])} pour les prévisions faites dans les deux dernières semaines.</li>`).join("");

const b = summary.params.r2_rn_bias;
const toPts = (logit) => (100 * (1 / (1 + Math.exp(-logit)) - 0.5)).toFixed(1).replace(".", ",");
document.getElementById("rnbias").textContent = `${toPts(-b.mean)} points de moins pour le candidat du RN, à ${toPts(b.sd)} point près`;

document.getElementById("r2polled").innerHTML = `<thead><tr><th>Duel sondé</th><th class="num">Moyenne</th><th class="num">Sondages</th><th>Dernier</th></tr></thead><tbody>` +
  summary.r2_polled.map((r) => {
    const a = 100 / (1 + Math.exp(-r.logit_a));
    return `<tr><td>${name(r.a)} – ${name(r.b)}</td><td class="num">${a.toFixed(0)} – ${(100 - a).toFixed(0)}</td><td class="num">${r.n_polls}</td><td>${frDate(r.last)}</td></tr>`;
  }).join("") + `</tbody>`;
