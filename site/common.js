// Shared helpers: data loading, wording of probabilities, scenario choice, tiny SVG helpers.

export const SCENARIO_KEY = "scenario";

export async function loadSummary() {
  const res = await fetch("data/summary.json", { cache: "no-cache" });
  return res.json();
}

// « 33 chances sur 100 », never 0 or 100.
export function chances(p) {
  const pct = 100 * p;
  if (pct < 1) return "moins de 1 chance sur 100";
  if (pct > 99) return "plus de 99 chances sur 100";
  const n = Math.round(pct);
  return `${n} chance${n > 1 ? "s" : ""} sur 100`;
}

export function pctShort(p) {
  const pct = 100 * p;
  if (pct < 1) return "<1";
  if (pct > 99) return ">99";
  return String(Math.round(pct));
}

export function frDate(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

export function getScenario() {
  try { return localStorage.getItem(SCENARIO_KEY) || "lepen"; } catch { return "lepen"; }
}

export function setScenario(s) {
  try { localStorage.setItem(SCENARIO_KEY, s); } catch { /* private mode: not remembered */ }
}

// Two rows: who is the RN candidate, and which line-up (only line-ups tested by ≥3 pollsters are offered).
export function scenarioTabs(el, summary, current, onChange) {
  el.innerHTML = "";
  const sc = summary.scenarios;
  const rnRow = [["lepen", "Marine Le Pen"], ["bardella", "Jordan Bardella"]].filter(([k]) => sc[k]);
  const lineupRow = [["lepen", "Tous les candidats déclarés (référence)"],
    ...Object.entries(sc).filter(([, v]) => v.kind === "lineup").map(([k, v]) => [k, v.label])];
  const row = (title, items, isActive, disabled) => {
    const wrap = document.createElement("div");
    wrap.className = "tabs";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", title);
    const t = document.createElement("span");
    t.className = "small muted";
    t.textContent = title + " :";
    wrap.append(t);
    for (const [key, label] of items) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("aria-pressed", String(isActive(key)));
      b.disabled = disabled(key);
      if (b.disabled) b.title = "Combinaison pas assez testée par les instituts";
      b.onclick = () => { if (b.getAttribute("aria-pressed") === "true") return; setScenario(key); onChange(key); };
      wrap.append(b);
    }
    el.append(wrap);
  };
  row("Candidat du RN", rnRow, (k) => k === current || (k === "lepen" && sc[current]?.kind === "lineup"),
    (k) => k === "bardella" && sc[current]?.kind === "lineup");
  row("Liste des candidats", lineupRow, (k) => k === current || (k === "lepen" && current === "bardella"),
    (k) => current === "bardella" && k !== "lepen");
  const n = sc[current]?.n_pollsters;
  if (n) {
    const note = document.createElement("p");
    note.className = "small muted";
    note.textContent = `Ce scénario repose sur ${n} instituts qui ont testé exactement cette liste ces 45 derniers jours.`;
    el.append(note);
  }
}

export function svg(tag, attrs = {}, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

// Horizontal bar with a 4px rounded end at the value side, square at the baseline.
export function hbar(x0, y, w, h, fill) {
  const r = Math.min(4, w / 2, h / 2);
  if (w <= 0.5) return svg("rect", { x: x0, y, width: 0.5, height: h, fill });
  const d = `M${x0},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z`;
  return svg("path", { d, fill });
}

const tip = document.createElement("div");
tip.className = "tooltip";
tip.setAttribute("role", "status");
document.addEventListener("DOMContentLoaded", () => document.body.append(tip));

export function attachTip(node, html) {
  const show = (e) => {
    tip.innerHTML = html;
    tip.style.display = "block";
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 14}px`;
  };
  node.addEventListener("pointermove", show);
  node.addEventListener("pointerleave", () => { tip.style.display = "none"; });
}

export function nameOf(summary, scen, id) {
  const c = summary.scenarios[scen].candidates.find((x) => x.id === id);
  return c ? c.name : id;
}
