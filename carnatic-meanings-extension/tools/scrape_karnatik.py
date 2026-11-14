#!/usr/bin/env python3
"""Builds the raw lyrics dataset from karnatik.com for the songs listed in top_songs.tsv.

Steps (each cached under --cache, so re-runs don't re-download):
  1. download karnatik.com's composition index (lyrics.shtml)
  2. match every row of top_songs.tsv to an index entry (title + raga, fuzzy)
  3. download each matched song page (politely, one request per second)
  4. parse metadata and sung lines into data/lyrics_raw.json

Line-by-line English meanings are NOT taken from karnatik (its meanings are prose
summaries written by the site); they are written separately in data/meanings/.

Usage: python3 tools/scrape_karnatik.py [--cache DIR] [--out PATH]
"""
import argparse
import difflib
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

BASE = "https://www.karnatik.com/"
UA = "Mozilla/5.0 (compatible; carnatic-meanings-dataset/0.1)"
HERE = os.path.dirname(os.path.abspath(__file__))


def key(s):
    """Rough phonetic key so 'shrI vAtApi gaNapatim' == 'Sri Vathapi Ganapathim'."""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z]", "", s)
    s = re.sub(r"([bcdgjkpt])h", r"\1", s)
    for a, b in (("sh", "s"), ("zh", "l"), ("w", "v"), ("ee", "i"), ("oo", "u"), ("y", "i"),
                 ("x", "ks"), ("g", "k"), ("d", "t"), ("b", "p")):
        s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)


def fetch(url, path):
    if os.path.exists(path):
        return open(path, encoding="utf-8", errors="ignore").read()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode("utf-8", errors="ignore")
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    time.sleep(1.0)
    return body


def load_index(cache):
    page = fetch(BASE + "lyrics.shtml", os.path.join(cache, "lyrics.shtml"))
    rows = []
    for href, text in re.findall(r'<OPTION VALUE="(c\d+\.shtml)">([^<\n]+)', page):
        parts = [p.strip() for p in html.unescape(text).split(" - ")]
        rows.append({
            "page": href,
            "title": parts[0],
            "raga": parts[1] if len(parts) > 1 else "",
            "composer": " - ".join(parts[2:]),
        })
    return rows


def match(want_title, want_raga, index):
    """Best index entry whose title starts like want_title and whose raga is close to want_raga."""
    wt, wr = key(want_title), key(want_raga)
    best, best_score = None, 0.0
    for row in index:
        rt = key(row["title"])
        n = min(len(rt), len(wt))
        if n < 4:
            continue
        t_score = difflib.SequenceMatcher(None, rt[: len(wt)], wt).ratio()
        if not (rt.startswith(wt) or wt.startswith(rt) or t_score >= 0.8):
            continue
        r_score = difflib.SequenceMatcher(None, key(row["raga"]), wr).ratio()
        if r_score < 0.6:
            continue
        score = t_score + r_score
        if score > best_score:
            best, best_score = row, score
    return best, best_score


SECTION_RE = re.compile(
    r"^(pallavi|anupallavi|caraNam\s*\d*|charaNam\s*\d*|caranam\s*\d*|samaShTi caraNam|"
    r"madhyamakAla sAhityam|madhyama kAla sAhityam|cittasvara sAhityam|svara sAhityam|"
    r"muktAyi svaram|cittasvaram|ciTTasvaram|caraNa svaram|ettugaDa svaram|"
    r"ciTTa[i]? ?s[vw]aram|citta[i]? ?s[vw]aram|s[vw]ara|madhyama ?kAla|madhyama ?kaa?lam|antara \d+|anubandha|"
    r"samaa?S?h?Ti caraNam)\s*:?$",
    re.I,
)
STOP_RE = re.compile(r"^(Meaning|Notation|Other information|Variations|first \|)", re.I)


SOLFA = {"sa", "ri", "ga", "ma", "pa", "da", "dha", "ni", "s", "r", "g", "m", "p", "d", "n",
         # jati (rhythm) syllables
         "ta", "tha", "ka", "ki", "ja", "jam", "nu", "thom", "tom", "thari", "tari", "dhi", "mi", "jhem"}


def clean_line(l):
    """Strip notation/metadata from a sung line; returns '' if nothing sung is left."""
    l = re.split(r"\((?:ciTTa|citta|cITTa)?\s*svara[^)]*\)|\((?:ciTTa|citta)swara[^)]*\)", l, flags=re.I)[0]
    l = re.sub(r"\((madhyama ?kAla|madhyamakaala|mk)\)", "", l, flags=re.I)
    l = re.sub(r"\(\d+\)|#", "", l)  # footnote markers
    l = re.sub(r"^(cara[nN]am\s*\d+|pallavi|anupallavi)\s+", "", l)  # stray section label at the start of a line
    l = l.replace("|", " ").replace(",", " ")
    l = re.sub(r"(\w)- +(\w)", r"\1\2", l)  # 'kaamaa- kshee' (syllables split for tala) -> 'kaamaakshee'
    l = re.sub(r"\s+", " ", l).strip(" ;.")
    if re.match(r"^(Aa|Av|Arohanam|Avarohanam)\s*:", l, re.I) or re.match(r"^\d+\s+\S+\s+janya", l, re.I):
        return ""
    words = re.findall(r"[A-Za-z*]+", l)
    if words and sum(w.strip("*").lower() in SOLFA for w in words) / len(words) > 0.6:
        return ""  # svara passage
    toks = [t for t in re.split(r"[\s-]+", l) if t]
    jati = re.compile(r"^[srgmpdnSRGMPDN.*]+$|dhim|tak|kiT|jham|tari|tom|kuku|ginat", re.I)
    if toks and sum(bool(jati.search(t)) for t in toks) / len(toks) > 0.5:
        return ""  # svara / jati (solkattu) passage
    if re.fullmatch(r"[aeiou.\s]+", l, re.I):
        return ""  # bare vowel 'aa ... aa'
    if re.fullmatch(r"[srgmpdnSRGMPDN*;.\s-]+", l):
        return ""  # compact svara notation like 'srgsr mpdpd'
    return l


def parse_song(page_html, row):
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", page_html)
    # Raw newlines in karnatik's HTML are just source wrapping; <br>/<p> are the real line breaks.
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|<p\b[^>]*>|</p>|</div>|</tr>|</h\d>", "\n", text)
    text = html.unescape(re.sub(r"<[^>]+>", "", text)).replace("\xa0", " ")
    lines = [l.strip() for l in text.split("\n")]
    lines = [l for l in lines if l]

    meta = {}
    for l in lines:
        m = re.match(r"^(raagam|taaLam|Composer|Language)\s*:\s*(.+)$", l, re.I)
        if m and m.group(1).lower() not in meta:
            meta[m.group(1).lower()] = m.group(2).strip()

    sections, cur = [], None
    for l in lines:
        if STOP_RE.match(l):
            if sections:
                break
            continue
        if SECTION_RE.match(l):
            cur = {"name": l.rstrip(":").strip().lower().replace("caranam", "caraNam"), "lines": []}
            sections.append(cur)
            continue
        if cur is None:
            continue
        # Lyrics lines end with '|' or '||'; '(banTu)' style lines just cue a return to the pallavi.
        if re.fullmatch(r"\(.*\)", l):
            continue
        t = re.sub(r"\s*\|+\s*(\(.*\))?\s*$", "", l).strip()  # drop '||' and '(banTu)' cues
        t = clean_line(t)
        if t:
            cur["lines"].append(t)
    sections = [s for s in sections if s["lines"]]
    return {
        "source": BASE + row["page"],
        "title": row["title"],
        "raga": meta.get("raagam", row["raga"]),
        "tala": meta.get("taalam", ""),
        "composer": meta.get("composer", row["composer"]),
        "language": meta.get("language", ""),
        "sections": sections,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(HERE, ".cache"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "data", "lyrics_raw.json"))
    ap.add_argument("--match-only", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    index = load_index(args.cache)
    wanted = []
    for line in open(os.path.join(HERE, "top_songs.tsv"), encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        t, r, c, page, maxlines = (line.rstrip("\n").split("\t") + ["", "", "", ""])[:5]
        wanted.append((t, r, c, page, int(maxlines or 0)))

    by_page = {row["page"]: row for row in index}
    matched, missing = [], []
    for t, r, c, page, maxlines in wanted:
        row, score = (by_page.get(page), 9.0) if page else match(t, r, index)
        if row:
            matched.append((t, r, c, row, maxlines))
            print(f"{score:4.2f}  {t:28s} -> {row['title']} | {row['raga']} | {row['composer']} ({row['page']})")
        else:
            missing.append((t, r, c, page, maxlines))
    for m in missing:
        print("MISSING", m, file=sys.stderr)
    print(f"{len(matched)} matched, {len(missing)} missing", file=sys.stderr)
    if args.match_only:
        return

    songs, seen = [], set()
    for t, r, c, row, maxlines in matched:
        if row["page"] in seen:
            continue
        seen.add(row["page"])
        page = fetch(BASE + row["page"], os.path.join(args.cache, row["page"]))
        song = parse_song(page, row)
        song["curated"] = {"title": t, "raga": r, "composer": c}
        if maxlines:  # the page repeats the lyrics in a second transliteration; keep the first copy
            left = maxlines
            for sec in song["sections"]:
                sec["lines"] = sec["lines"][:max(left, 0)]
                left -= len(sec["lines"])
            song["sections"] = [s for s in song["sections"] if s["lines"]]
        first = song["sections"][0]["lines"][0] if song["sections"] else ""
        if key(first)[:5] != key(row["title"])[:5]:
            print(f"CHECK {row['page']}: index title {row['title']!r} but lyrics start {first[:40]!r}", file=sys.stderr)
        if not song["sections"]:
            print("NO LYRICS", row["page"], row["title"], file=sys.stderr)
            continue
        songs.append(song)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"source": "karnatik.com", "songs": songs}, f, ensure_ascii=False, indent=1)
    print(f"wrote {len(songs)} songs to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
