import { attachTip, chances, earlyBanner, frDate, getScenario, hbar, loadSummary, nameOf, pctShort, scenarioTabs, svg } from "./common.js";

const NEAR_CERTAIN = 0.85; // above this P(qualify), the headline is about who faces them
const MIN_QUALIFY_ROW = 0.01;
const UNRELIABLE_QUALIFY = 0.05;
const HISTORY_MIN = 0.1; // a challenger appears in the history chart if they reached this at some point
const HISTORY_MAX = 3;

const summary = await loadSummary();
let scen = summary.scenarios[getScenario()] ? getScenario() : "lepen";
let history = await fetch("data/history.csv", { cache: "no-cache" }).then((r) => r.text()).then(parseCsv);

function parseCsv(text) {
  const [head, ...lines] = text.trim().split("\n");
  const keys = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], isNaN(+v) ? v : +v])));
}

function render() {
  const sc = summary.scenarios[scen];
  const cands = [...sc.candidates].sort((a, b) => b.p_qualify - a.p_qualify);
  scenarioTabs(document.getElementById("scenarios"), summary, scen, (s) => { scen = s; render(); });
  document.getElementById("asof").textContent =
    `Mis à jour le ${frDate(summary.asof)} · 1er tour le ${frDate(summary.r1_date)}, second tour le ${frDate(summary.r2_date)}`;
  document.getElementById("early").innerHTML = earlyBanner(summary);
  headline(cands);
  challengers(cands);
  winTable(cands);
  finalsTable(sc);
  sharesChart(cands);
  historyChart(cands);
  duelsTable(sc);
}

function headline(cands) {
  const top = cands[0];
  const el = document.getElementById("headline");
  if (top.p_qualify >= NEAR_CERTAIN) {
    el.innerHTML = `${top.name} a ${chances(top.p_qualify)} d'être au second tour, et ${chances(top.p_win)} de remporter l'élection. ` +
      `Reste à savoir qui lui fera face.`;
    document.getElementById("challengers-title").textContent = `Qui pourrait être au second tour face à ${top.name} ?`;
  } else {
    const byWin = [...cands].sort((a, b) => b.p_win - a.p_win);
    el.innerHTML = `Le mieux placé aujourd'hui est ${byWin[0].name}, avec ${chances(byWin[0].p_win)} de gagner, ` +
      `devant ${byWin[1].name}, avec ${chances(byWin[1].p_win)}. Rien n'est joué.`;
    document.getElementById("challengers-title").textContent = "Qui pourrait être au second tour, et le gagner ?";
  }
}

function challengers(cands) {
  const top = cands[0];
  const shown = (c) => c.p_qualify >= UNRELIABLE_QUALIFY && !(c === top && top.p_qualify >= NEAR_CERTAIN);
  const rows = cands.filter(shown);
  const others = cands.filter((c) => !shown(c) && c !== top);
  const W = 700, labelW = 170, rowH = 46, barH = 14, barW = W - labelW - 50;
  const root = svg("svg", { viewBox: `0 0 ${W} ${rows.length * rowH + 24}`, class: "chart", role: "img",
    "aria-label": "Chance d'être au second tour et chance de gagner s'il y est, par candidat" });
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const x = labelW + t * barW;
    root.append(svg("line", { x1: x, x2: x, y1: 0, y2: rows.length * rowH, class: "grid" }));
    root.append(svg("text", { x, y: rows.length * rowH + 16, "text-anchor": "middle" }, `${t * 100}`));
  }
  rows.forEach((c, i) => {
    const y = i * rowH + 6;
    root.append(svg("text", { x: 0, y: y + barH + 4, class: "label" }, c.name));
    const g = svg("g");
    g.append(hbar(labelW, y, c.p_qualify * barW, barH, "var(--series-1)"));
    root.append(svg("text", { x: labelW + c.p_qualify * barW + 6, y: y + barH - 2, class: "value" }, pctShort(c.p_qualify)));
    const reliable = c.p_qualify >= UNRELIABLE_QUALIFY && c.p_win_if_qualified !== null;
    if (reliable) {
      g.append(hbar(labelW, y + barH + 2, c.p_win_if_qualified * barW, barH, "var(--series-2)"));
      root.append(svg("text", { x: labelW + c.p_win_if_qualified * barW + 6, y: y + 2 * barH, class: "value" }, pctShort(c.p_win_if_qualified)));
    } else {
      root.append(svg("text", { x: labelW, y: y + 2 * barH, class: "value" }, "trop rarement qualifié pour estimer"));
    }
    g.append(svg("rect", { x: 0, y: y - 4, width: W, height: rowH - 4, fill: "transparent" }));
    attachTip(g, `<strong>${c.name}</strong><br>Au second tour : ${chances(c.p_qualify)}<br>` +
      (reliable ? `Gagne en cas de qualification : ${chances(c.p_win_if_qualified)}<br>` : "") + `Victoire : ${chances(c.p_win)}`);
    root.append(g);
  });
  const el = document.getElementById("challengers");
  el.innerHTML = "";
  el.append(root);
  document.getElementById("challengers-note").textContent =
    "Les chiffres sont en chances sur 100. La chance de gagner en cas de qualification dépend de l'adversaire probable. " +
    (others.length ? `Candidats à moins de 5 chances sur 100 d'être au second tour : ${others.map((c) => c.name).join(", ")}.` : "");
}

function winTable(cands) {
  const rows = [...cands].sort((a, b) => b.p_win - a.p_win || b.p_qualify - a.p_qualify);
  document.getElementById("table-win").innerHTML =
    `<thead><tr><th>Candidat</th><th class="num">Victoire</th><th class="num">Au 2nd tour</th><th class="num">Score au 1er tour</th></tr></thead><tbody>` +
    rows.map((c) => `<tr><td>${c.name}</td><td class="num">${pctShort(c.p_win)}</td><td class="num">${pctShort(c.p_qualify)}</td>` +
      `<td class="num">${c.share_q["0.5"].toFixed(0)} %, entre ${c.share_q["0.1"].toFixed(0)} et ${c.share_q["0.9"].toFixed(0)}</td></tr>`).join("") +
    `</tbody>`;
}

function finalsTable(sc) {
  document.getElementById("table-finals").innerHTML =
    `<thead><tr><th>Second tour</th><th class="num">Chance que ce duel ait lieu</th><th>Qui gagnerait ce duel</th></tr></thead><tbody>` +
    sc.finals.slice(0, 6).map((f) => {
      const [fav, pFav] = f.p_a_wins >= 0.5 ? [f.a, f.p_a_wins] : [f.b, 1 - f.p_a_wins];
      return `<tr><td>${nameOf(summary, scen, f.a)} – ${nameOf(summary, scen, f.b)}</td><td class="num">${pctShort(f.p)} sur 100</td>` +
        `<td>${nameOf(summary, scen, fav)}, ${chances(pFav)}${f.polled ? "" : " <span class='muted'>(estimé)</span>"}</td></tr>`;
    }).join("") + `</tbody>`;
}

function sharesChart(cands) {
  const rows = [...cands].sort((a, b) => b.poll_avg - a.poll_avg);
  const W = 700, labelW = 170, rowH = 30, max = Math.max(...rows.map((c) => c.share_q["0.95"])) * 1.05;
  const x = (v) => labelW + (v / max) * (W - labelW - 40);
  const root = svg("svg", { viewBox: `0 0 ${W} ${rows.length * rowH + 24}`, class: "chart", role: "img",
    "aria-label": "Moyenne des sondages et fourchette du modèle par candidat" });
  for (let t = 0; t <= max; t += 10) {
    root.append(svg("line", { x1: x(t), x2: x(t), y1: 0, y2: rows.length * rowH, class: "grid" }));
    root.append(svg("text", { x: x(t), y: rows.length * rowH + 16, "text-anchor": "middle" }, `${t} %`));
  }
  rows.forEach((c, i) => {
    const y = i * rowH + 8;
    const g = svg("g");
    root.append(svg("text", { x: 0, y: y + 11, class: "label" }, c.name));
    g.append(svg("rect", { x: x(c.share_q["0.1"]), y, width: x(c.share_q["0.9"]) - x(c.share_q["0.1"]), height: 14, rx: 4, fill: "var(--series-1)", opacity: 0.45 }));
    g.append(svg("rect", { x: x(c.poll_avg) - 1.5, y: y - 3, width: 3, height: 20, fill: "var(--text)" }));
    g.append(svg("rect", { x: 0, y: y - 6, width: W, height: rowH, fill: "transparent" }));
    attachTip(g, `<strong>${c.name}</strong><br>Moyenne des sondages : ${c.poll_avg.toFixed(1)} %<br>` +
      `80 chances sur 100 entre ${c.share_q["0.1"].toFixed(1)} et ${c.share_q["0.9"].toFixed(1)} %`);
    root.append(g);
  });
  const el = document.getElementById("shares");
  el.innerHTML = "";
  el.append(root);
}

function historyChart(cands) {
  const el = document.getElementById("history");
  if (summary.scenarios[scen].kind === "lineup") { el.innerHTML = "<p class='muted small'>L'historique est disponible pour la liste de référence.</p>"; return; }
  const rows = history.filter((r) => r.scenario === scen);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  if (dates.length < 2) { el.innerHTML = "<p class='muted small'>L'historique s'affichera après quelques jours de mises à jour.</p>"; return; }
  const top = cands[0].p_qualify >= NEAR_CERTAIN ? cands[0].id : null;
  // every challenger who reached HISTORY_MIN at some point in the period, by peak value, at most HISTORY_MAX lines
  const peak = (id) => Math.max(...rows.filter((r) => r.candidate === id).map((r) => r.p_qualify));
  const ids = cands.map((c) => c.id).filter((id) => id !== top && peak(id) >= HISTORY_MIN)
    .sort((a, b) => peak(b) - peak(a)).slice(0, HISTORY_MAX);
  const colors = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
  const W = 700, H = 220, L = 34, R = 150, T = 10, B = 26;
  const t0 = Date.parse(dates[0]), t1 = Date.parse(dates.at(-1));
  const x = (d) => L + ((Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
  const y = (p) => T + (1 - p) * (H - T - B);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Chance d'être au second tour dans le temps" });
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    root.append(svg("line", { x1: L, x2: W - R, y1: y(p), y2: y(p), class: "grid" }));
    root.append(svg("text", { x: L - 6, y: y(p) + 4, "text-anchor": "end" }, `${p * 100}`));
  }
  root.append(svg("text", { x: L, y: H - 6 }, frDate(dates[0])));
  root.append(svg("text", { x: W - R, y: H - 6, "text-anchor": "end" }, frDate(dates.at(-1))));
  const labels = [];
  ids.forEach((id, k) => {
    const pts = rows.filter((r) => r.candidate === id).sort((a, b) => a.date.localeCompare(b.date));
    root.append(svg("polyline", { points: pts.map((r) => `${x(r.date)},${y(r.p_qualify)}`).join(" "), fill: "none", stroke: colors[k], "stroke-width": 2 }));
    const last = pts.at(-1);
    labels.push({ y: y(last.p_qualify) + 4, text: `${nameOf(summary, scen, id)} ${pctShort(last.p_qualify)}`, color: colors[k] });
  });
  // keep end labels at least 16px apart so close lines stay readable
  labels.sort((a, b) => a.y - b.y).forEach((l, i, all) => { if (i && l.y - all[i - 1].y < 16) l.y = all[i - 1].y + 16; });
  for (const l of labels) {
    root.append(svg("rect", { x: W - R + 8, y: l.y - 9, width: 10, height: 10, rx: 2, fill: l.color }));
    root.append(svg("text", { x: W - R + 22, y: l.y, class: "label" }, l.text));
  }
  el.innerHTML = `<p class='small muted'>Chance d'être qualifié pour le second tour, sur 100. Le graphique montre les ${HISTORY_MAX} candidats au plus ` +
    `qui ont dépassé ${HISTORY_MIN * 100} chances sur 100 sur la période` + (top ? `, en plus de ${nameOf(summary, scen, top)}` : "") + `. ` +
    `Être qualifié ne veut pas dire gagner : la chance de gagner en cas de qualification est indiquée plus haut.</p>`;
  el.append(root);
}

function duelsTable(sc) {
  const duels = sc.duels.filter((d) => {
    const pa = sc.candidates.find((c) => c.id === d.a).p_qualify, pb = sc.candidates.find((c) => c.id === d.b).p_qualify;
    return pa >= MIN_QUALIFY_ROW && pb >= MIN_QUALIFY_ROW;
  });
  document.getElementById("table-duels").innerHTML =
    `<thead><tr><th>Duel</th><th class="num">Score prévu</th><th>Chances de gagner, sur 100</th><th>Source</th></tr></thead><tbody>` +
    duels.map((d) => `<tr><td>${nameOf(summary, scen, d.a)} contre ${nameOf(summary, scen, d.b)}</td>` +
      `<td class="num">${(100 * d.share_a).toFixed(0)} à ${(100 - 100 * d.share_a).toFixed(0)}</td>` +
      `<td>${pctShort(d.p_a)} contre ${pctShort(1 - d.p_a)}</td><td>${d.polled ? "sondé" : "estimé par le modèle"}</td></tr>`).join("") +
    `</tbody>`;
}

render();
