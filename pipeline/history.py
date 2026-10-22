"""Historical French presidential polls (1995–2022) and official results (1965–2022).

Outputs:
- data/hist_polls.csv: individual polls, same schema as data/polls.csv plus `year`.
  2002–2017 from EN Wikipedia "Opinion polling for the {y} French presidential election",
  1995 from FR Wikipedia "Élection présidentielle française de 1995" (Sondages section),
  2022 from NSPPolls (data/raw/hist/nsppolls_2022.csv).
- data/results_history.csv: official national results, % of expressed votes, both rounds.
  Figures are the Conseil constitutionnel's, taken from the results table of each EN Wikipedia
  "{y} French presidential election" article (share recomputed from vote counts).

Raw pages are cached in data/raw/hist/ and only fetched when missing.
"""

import io
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
from lxml import html as lxml_html

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "hist"
POLLS_OUT = ROOT / "data" / "hist_polls.csv"
RESULTS_OUT = ROOT / "data" / "results_history.csv"
USER_AGENT = "elections2027-forecast/0.1 (research)"
COLUMNS = ["source", "pollster", "start", "end", "n", "round", "hyp", "candidate", "share", "ref", "year"]
WIKI_POLL_YEARS = [2002, 2007, 2012, 2017]
ELECTIONS = {  # year: (first round, second round)
    1965: ("1965-12-05", "1965-12-19"),
    1969: ("1969-06-01", "1969-06-15"),
    1974: ("1974-05-05", "1974-05-19"),
    1981: ("1981-04-26", "1981-05-10"),
    1988: ("1988-04-24", "1988-05-08"),
    1995: ("1995-04-23", "1995-05-07"),
    2002: ("2002-04-21", "2002-05-05"),
    2007: ("2007-04-22", "2007-05-06"),
    2012: ("2012-04-22", "2012-05-06"),
    2017: ("2017-04-23", "2017-05-07"),
    2022: ("2022-04-10", "2022-04-24"),
}
WINNERS = {
    1965: "gaulle", 1969: "pompidou", 1974: "giscard-destaing", 1981: "mitterrand", 1988: "mitterrand",
    1995: "chirac", 2002: "chirac", 2007: "sarkozy", 2012: "hollande", 2017: "macron", 2022: "macron",
}  # fmt: skip
MONTHS = {
    "jan": 1, "feb": 2, "fev": 2, "mar": 3, "apr": 4, "avr": 4, "may": 5, "mai": 5, "jun": 6, "jul": 7,
    "aug": 8, "aou": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12, "juin": 6, "juil": 7,
}  # fmt: skip
POLLSTER_ALIASES = {
    "tns": "kantar",
    "sofres": "kantar",
    "louis": "lh2",
    "opinion": "opinionway",
    "le": "leterrain",
}
META_COLS = {"Polling firm", "Fieldwork date", "Sample size", "Abs.", "Sondeur", "Date"}
JUNK_FIRMS = r"election|Sondeur|Résultats"


def fetch_page(page: str, dest: Path, lang: str = "en") -> str:
    if not dest.exists():
        query = {
            "action": "parse",
            "page": page,
            "prop": "text",
            "formatversion": 2,
            "format": "json",
            "redirects": 1,
        }
        url = f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            dest.write_bytes(resp.read())
        time.sleep(3.5)  # Wikipedia answers 429 to faster crawls
    return json.loads(dest.read_text())["parse"]["text"]


def ascii_fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def slug(surname: str) -> str:
    """'Le Pen' -> 'le-pen', 'de Villiers' -> 'villiers', "Giscard d'Estaing" -> 'giscard-destaing'."""
    s = ascii_fold(surname).lower().strip().replace("- ", "-").removeprefix("de ").replace("'", "")
    return s.replace(" ", "-")


def surname(full_name: str) -> str:
    """'Jean-Marie Le Pen (FN)' -> 'Le Pen'; given names are always a single (maybe hyphenated) token."""
    name = re.sub(r"\(.*", "", full_name).strip()
    return name.split(" ", 1)[1]


def pollster_id(firm: str) -> str:
    """'Ifop-Fiducial Archived 5 May 2017 at the Wayback Machine*' -> 'ifop'."""
    clean = re.split(r" Archived|\[|\*", firm)[0]
    first = clean.lower().split()[0].split("-")[0]
    return POLLSTER_ALIASES.get(first, first)


def month(token: str) -> int:
    t = ascii_fold(token).lower()
    return MONTHS.get(t[:4]) or MONTHS[t[:3]]


def parse_dates(text: str, default_year: int) -> tuple[date, date]:
    """'29 Mar – 2 Apr 2012', '30–31 Mar 2017', '4 May 2007', 'du 8 au 10 avril', '1er mars 1995'."""
    t = re.sub(r"(\d)er\b", r"\1", text.lower())
    t = re.sub(r"^du (.+?) au ", r"\1–", t).replace(" et ", "–")
    parts = [p.split() for p in re.split(r"\s*[–-]\s*", t)]
    end_tok, start_tok = parts[-1], parts[0]
    end_year = int(end_tok[2]) if len(end_tok) > 2 else default_year
    end = date(end_year, month(end_tok[1]), int(end_tok[0]))
    s_month = month(start_tok[1]) if len(start_tok) > 1 else end.month
    s_year = int(start_tok[2]) if len(start_tok) > 2 else end_year - (s_month > end.month)
    return date(s_year, s_month, int(start_tok[0])), end


def parse_share(cell: object) -> float:
    s = str(cell).replace(",", ".")
    if s.startswith("<"):
        return 0.25  # '<0.5%'
    m = re.search(r"\d+(\.\d+)?", s)
    return float(m.group()) if m else float("nan")  # '–' = not tested


def parse_n(cell: object) -> float:
    digits = re.sub(r"\D", "", str(cell))
    return float(digits) if digits else float("nan")


def heading_before(table: lxml_html.HtmlElement) -> str:
    h = table.xpath("preceding::*[self::h2 or self::h3 or self::h4][1]")
    return h[0].text_content().strip() if h else ""


def wiki_tables(html: str) -> list[tuple[int, pd.DataFrame]]:
    """National voting-intention tables (sub-national 'By region/department/...' tables skipped)."""
    out = []
    for i, table in enumerate(lxml_html.fromstring(html).xpath("//table[contains(@class,'wikitable')]")):
        if heading_before(table).startswith("By "):
            continue
        df = pd.read_html(io.StringIO(lxml_html.tostring(table, encoding=str)))[0]
        df.columns = [
            c[-1] if c[0].startswith("Unnamed") else c[0] for c in df.columns
        ]  # FR names on level 1
        if {"Polling firm", "Sondeur"} & set(df.columns) and {"Fieldwork date", "Date"} & set(df.columns):
            out.append((i, df))
    return out


def tidy_table(df: pd.DataFrame, year: int, tidx: int, source: str, name_to_slug) -> pd.DataFrame:
    firm_col, date_col = df.columns[0], df.columns[1]
    # ponytail: month-only dates ('octobre 1994', FR Chirac–Delors table) dropped rather than guessed.
    dated = df[date_col].astype(str).str.match(r"(du )?\d")
    df = df[dated & ~df[firm_col].astype(str).str.contains(JUNK_FIRMS)].reset_index(drop=True)
    cands = [c for c in df.columns if c not in META_COLS]
    rnd = 2 if len(cands) == 2 else 1
    rows = []
    for r, row in df.iterrows():
        start, end = parse_dates(str(row[date_col]), year)
        for c in cands:
            share = parse_share(row[c])
            if pd.notna(share):  # NaN = not tested
                rows.append(
                    {
                        "source": source,
                        "pollster": pollster_id(str(row[firm_col])),
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "n": parse_n(row.get("Sample size", "")),
                        "round": rnd,
                        "hyp": f"{year}_{rnd}_{tidx}_{r}",
                        "candidate": name_to_slug(c),
                        "share": share,
                        "ref": source,
                        "year": year,
                    }
                )
    return pd.DataFrame(rows)


def header_slug(col: str) -> str:
    """EN headers are 'Surname PARTY': 'Le Pen FN' -> 'le-pen'."""
    return slug(col.rsplit(" ", 1)[0].replace("(nominee)", "npa-nominee"))


def load_wiki_en(year: int) -> pd.DataFrame:
    html = fetch_page(
        f"Opinion polling for the {year} French presidential election", RAW / f"wiki_en_{year}.json"
    )
    return pd.concat([tidy_table(df, year, i, "wikipedia_en", header_slug) for i, df in wiki_tables(html)])


def load_wiki_fr_1995() -> pd.DataFrame:
    html = fetch_page("Élection présidentielle française de 1995", RAW / "wiki_fr_1995.json", lang="fr")
    # ponytail: 1993–94 tables ('Dernier jour du sondage' layout) skipped; only 1995-campaign tables kept.
    return pd.concat(
        [tidy_table(df, 1995, i, "wikipedia_fr", lambda c: slug(surname(c))) for i, df in wiki_tables(html)]
    )


def load_nsppolls_2022() -> pd.DataFrame:
    df = pd.read_csv(RAW / "nsppolls_2022.csv")
    df = df[df.candidat != "autre"]
    rnd = df.tour.map({"Premier tour": 1, "Deuxième tour": 2})
    group = df.groupby(["id", "tour", df.hypothese.fillna("")]).ngroup()
    return pd.DataFrame(
        {
            "source": "nsppolls",
            "pollster": df.nom_institut.map(pollster_id),
            "start": df.debut_enquete,
            "end": df.fin_enquete,
            "n": df.echantillon.astype(float),
            "round": rnd,
            "hyp": "2022_" + rnd.astype(str) + "_" + group.astype(str),
            "candidate": df.candidat.map(lambda c: slug(surname(c))),
            "share": df.intentions,
            "ref": "nsppolls",
            "year": 2022,
        }
    )


def build_polls() -> pd.DataFrame:
    polls = pd.concat(
        [load_wiki_fr_1995(), *(load_wiki_en(y) for y in WIKI_POLL_YEARS), load_nsppolls_2022()],
        ignore_index=True,
    )
    raw_sum = polls.groupby("hyp").share.transform("sum")
    odd = (
        polls[(raw_sum < 90) | (raw_sum > 110)]
        .groupby("hyp")
        .agg(pollster=("pollster", "first"), end=("end", "first"), total=("share", "sum"))
    )
    if len(odd):
        print(f"WARNING dropping {len(odd)} hypotheses with raw sum outside [90,110]:\n{odd}")
    polls = polls[~polls.hyp.isin(odd.index)]
    polls["share"] = 100 * polls.share / polls.groupby("hyp").share.transform("sum")
    polls["n"] = polls.n.astype("Int64")
    return polls[COLUMNS].sort_values(["year", "round", "end", "pollster", "hyp", "share"], ignore_index=True)


def load_results(year: int) -> pd.DataFrame:
    html = fetch_page(f"{year} French presidential election", RAW / f"wiki_en_result_{year}.json")
    table = next(
        t for t in lxml_html.fromstring(html).xpath("//table")
        if "Valid votes" in t.text_content() and "Second round" in t.text_content()
    )  # fmt: skip
    df = pd.read_html(io.StringIO(lxml_html.tostring(table, encoding=str)))[0]
    df = df.iloc[: df.index[df.iloc[:, 1] == "Total"][0]]
    names = df.iloc[:, 1].str.replace(r"\s*\(.*", "", regex=True)
    out = []
    for rnd, col in [(1, 3), (2, 5)]:
        votes = pd.to_numeric(df.iloc[:, col], errors="coerce")
        keep = votes.notna()
        published = pd.to_numeric(df.iloc[:, col + 1], errors="coerce")[keep]
        assert (100 * votes[keep] / votes[keep].sum() - published).abs().max() < 0.01, (
            f"{year} R{rnd} % mismatch"
        )
        out.append(
            pd.DataFrame(
                {
                    "year": year,
                    "round": rnd,
                    "candidate": names[keep].map(lambda n: slug(surname(n))),
                    "share": 100 * votes[keep] / votes[keep].sum(),
                    "election_date": ELECTIONS[year][rnd - 1],
                }
            )
        )
    return pd.concat(out)


def report(polls: pd.DataFrame, results: pd.DataFrame) -> None:
    for (year, rnd), g in polls.groupby(["year", "round"]):
        n_polls = len(g.drop_duplicates(["pollster", "end"]))
        print(f"{year} R{rnd}: {n_polls} polls, {g.hyp.nunique()} hyps, {g.start.min()}..{g.end.max()}")
        print("   ", " ".join(sorted(g.candidate.unique())))
    print("\nLast-7-days poll average vs result (R1 all candidates; R2 actual finalists only)")
    for year in sorted(polls.year.unique()):
        for rnd in (1, 2):
            e_day = date.fromisoformat(ELECTIONS[year][rnd - 1])
            res = results[(results.year == year) & (results["round"] == rnd)].set_index("candidate").share
            g = polls[(polls.year == year) & (polls["round"] == rnd)]
            g = g[(g.end >= (e_day - timedelta(7)).isoformat()) & (g.end < e_day.isoformat())]
            if rnd == 2:
                finalists = set(res.index)
                g = g[g.groupby("hyp").candidate.transform(lambda c, f=finalists: set(c) == f)]
            avg = g.groupby("candidate").share.mean()
            cmp = pd.DataFrame({"poll": avg, "result": res}).dropna().sort_values("result", ascending=False)
            cmp["err"] = cmp.poll - cmp.result
            print(f"\n{year} R{rnd} ({g.hyp.nunique()} hyps)\n{cmp.round(2).to_string()}")


def main() -> None:
    polls = build_polls()
    results = pd.concat([load_results(y) for y in ELECTIONS], ignore_index=True)

    assert polls.groupby("hyp").share.sum().sub(100).abs().max() < 1e-6
    assert not polls.duplicated(["hyp", "candidate"]).any(), "candidate twice in one hypothesis"
    assert (polls.start <= polls.end).all()
    for year in polls.year.unique():
        assert set(polls[polls.year == year]["round"]) == {1, 2}, f"{year} lacks a round"
    assert results.groupby(["year", "round"]).share.sum().sub(100).abs().max() < 1e-6
    r2 = results[results["round"] == 2]
    winners = r2.loc[r2.groupby("year").share.idxmax()].set_index("year").candidate.to_dict()
    assert winners == WINNERS, winners

    polls.to_csv(POLLS_OUT, index=False)
    results.round({"share": 4}).to_csv(RESULTS_OUT, index=False)
    report(polls, results)


if __name__ == "__main__":
    main()
