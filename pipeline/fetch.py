"""Download 2027 poll compilations and merge them into one tidy table: data/polls.csv.

Sources (in precedence order): MieuxVoter/presidentielle2027 (MIT), Sondax (CC-BY-SA).
A poll is identified by (pollster, fieldwork end date); Sondax polls already in MieuxVoter are dropped.
"""

import re
import unicodedata
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "polls.csv"
MV_URL = "https://raw.githubusercontent.com/MieuxVoter/presidentielle2027/main/presidentielle2027.csv"
SONDAX_URL = "https://sondax.fr/donnees/sondages-presidentielle-2027.csv"
USER_AGENT = "elections2027-forecast/0.1 (open-source poll aggregator)"
NOTICES_URL = "https://www.commission-des-sondages.fr/notices/medias/fichiers/bytag/14/2027-Presidentielle"
NOTICE_BASE = "https://www.commission-des-sondages.fr"
COLUMNS = [
    "source",
    "pollster",
    "start",
    "end",
    "n",
    "round",
    "hyp",
    "candidate",
    "share",
    "ref",
    "name",
    "sponsor",
]
# ponytail: FR Wikipedia parser skipped — Sondax is itself scraped from it; add if Sondax goes stale.


def download(url: str, dest: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())
    return dest


def slug(name: str) -> str:
    """'Marine Le Pen' / 'Le Pen' -> 'le-pen'; 'Dominique de Villepin' -> 'villepin'."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return ascii_name.lower().strip().removeprefix("de ").replace(" ", "-")


def pollster_id(name: str) -> str:
    return name.lower().split()[0]  # 'Harris Interactive' -> 'harris', 'Ipsos BVA' -> 'ipsos'


def load_mieuxvoter(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    return pd.DataFrame(
        {
            "source": "mieuxvoter",
            "pollster": df.nom_institut.map(pollster_id),
            "start": df.debut_enquete,
            "end": df.fin_enquete,
            "n": df.echantillon,
            "round": df.tour.map({"1er Tour": 1, "2nd Tour": 2}),
            "hyp": df.poll_id,
            "candidate": df.surname.map(slug),
            "share": df.intentions,
            "ref": df.filename,
            "name": df.complete_name,
            "sponsor": df.commanditaire,
        }
    )


def load_sondax(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    return pd.DataFrame(
        {
            "source": "sondax",
            "pollster": df.institut.map(pollster_id),
            "start": df.terrain_debut,
            "end": df.terrain_fin,
            "n": df.echantillon,
            "round": df.tour,
            "hyp": df.sondage_id + "_" + df.tour.astype(str) + "_" + df.configuration.astype(str),
            "candidate": df.candidat_id,
            "share": df.score,
            "ref": df.url_source,
            "name": df.candidat,
            "sponsor": None,
        }
    )


def notice_links(html: str) -> dict[str, str]:
    """Notice number ('10262') -> URL of its PDF on the Commission des sondages site."""
    pairs = re.findall(r'href="(/notices/medias/fichiers/add/\d+)"[^>]*>(\d+) ', html)
    return {num: NOTICE_BASE + href for href, num in pairs}


def link_refs(polls: pd.DataFrame, links: dict[str, str]) -> pd.DataFrame:
    """Replace MieuxVoter notice filenames ('10262-pres-….pdf') by the notice URL when known."""
    num = polls.ref.astype(str).str.extract(r"^(\d+)-")[0]
    url = num.map(links)
    return polls.assign(ref=url.fillna(polls.ref))


def merge(mv: pd.DataFrame, sx: pd.DataFrame) -> pd.DataFrame:
    known = set(zip(mv.pollster, mv.end))
    sx_new = sx[[(p, e) not in known for p, e in zip(sx.pollster, sx.end)]]
    polls = pd.concat([mv, sx_new], ignore_index=True)[COLUMNS]
    polls = polls.dropna(subset=["share"])
    # renormalise each hypothesis to 100 (rounding makes them sum to 98–102)
    polls["share"] = 100 * polls.share / polls.groupby("hyp").share.transform("sum")
    return polls.sort_values(["end", "pollster", "hyp", "share"], ascending=[True, True, True, False])


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    mv = load_mieuxvoter(download(MV_URL, RAW / "mv_presidentielle2027.csv"))
    sx = load_sondax(download(SONDAX_URL, RAW / "sondax.csv"))
    polls = merge(mv, sx)
    try:
        links = notice_links(download(NOTICES_URL, RAW / "notices.html").read_text(errors="ignore"))
    except OSError as err:  # the Commission site being down must not stop the daily update
        print(f"notices list unavailable ({err}); keeping filenames")
        links = {}
    polls = link_refs(polls, links)
    assert polls.groupby("hyp").share.sum().sub(100).abs().max() < 1e-6
    assert not polls.duplicated(["hyp", "candidate"]).any(), "candidate twice in one hypothesis"
    polls.to_csv(OUT, index=False)
    by_source = polls.drop_duplicates(["pollster", "end"]).source.value_counts().to_dict()
    print(f"{polls.hyp.nunique()} hypotheses, polls per source {by_source}, last fieldwork {polls.end.max()}")


if __name__ == "__main__":
    main()
