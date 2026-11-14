#!/usr/bin/env python3
"""Merges scraped lyrics (data/lyrics_raw.json) with hand-written line-by-line meanings
(data/meanings/*.json) into the extension's song database (src/data/songs.json).

A meanings file maps a karnatik page id to {"summary": str, "m": [one meaning per sung line]}.
Songs without meanings are left out. Fails loudly if a song's meaning count doesn't match its lines.
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")

SECTION_NAMES = {
    "pallavi": "Pallavi",
    "anupallavi": "Anupallavi",
    "madhyamakala": "Madhyama kala",
    "madhyama kaalam": "Madhyama kala",
    "madhyama kalam": "Madhyama kala",
    "samaashti caranam": "Samashti charanam",
    "samashti caranam": "Samashti charanam",
    "anubandha": "Anubandha",
}


def section_name(raw):
    raw = raw.strip().lower()
    if raw in SECTION_NAMES:
        return SECTION_NAMES[raw]
    m = re.match(r"cara[nN]am\s*(\d*)", raw, re.I)
    if m:
        return "Charanam" + (" " + m.group(1) if m.group(1) else "")
    if "svaram" in raw or "swaram" in raw:
        return "Chittaswaram"
    return raw.capitalize()


def line_prefix(name):
    n = name.lower()
    if n == "pallavi":
        return "p"
    if n == "anupallavi":
        return "a"
    if n.startswith("charanam"):
        return "c"
    return "x"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


TALA_FIXES = {"rupaka": "rupakam", "t/eka": "tishra eka", "c/eka": "chatusra eka", "adi (1 beat rest)": "adi",
              "cowtal (hindustani) or rupakam": "rupakam", "tisram": "tishra eka", "no given tala": ""}
# Fallback language when karnatik.com doesn't list one, for composers who wrote (almost) only in one language.
COMPOSER_LANGUAGE = {"Tyagaraja": "Telugu", "Syama Sastri": "Telugu", "Dikshitar": "Sanskrit",
                     "Purandaradasa": "Kannada", "Annamacharya": "Telugu", "Sadasiva Brahmendra": "Sanskrit"}


def tala_name(s):
    s = s.lower().replace("aa", "a").replace("ee", "i").replace("oo", "u")
    s = re.sub(r"\bca?pu\b", "chapu", s)
    s = TALA_FIXES.get(s.strip(), s)
    return titlecase(s)


def titlecase(s):
    return " ".join(w[:1].upper() + w[1:] for w in s.split())


def main():
    raw = json.load(open(os.path.join(ROOT, "data", "lyrics_raw.json"), encoding="utf-8"))["songs"]
    meanings = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "meanings", "*.json"))):
        for page, v in json.load(open(path, encoding="utf-8")).items():
            if page in meanings:
                sys.exit(f"duplicate meanings for {page} in {path}")
            meanings[page] = v

    out, errors, seen_ids = [], [], set()
    for song in raw:
        page = song["source"].rsplit("/", 1)[1].replace(".shtml", "")
        if page not in meanings:
            continue
        info = meanings[page]
        lines = [(sec["name"], l) for sec in song["sections"] for l in sec["lines"]]
        if len(info["m"]) != len(lines):
            errors.append(f"{page} {song['title']}: {len(lines)} lines but {len(info['m'])} meanings")
            continue
        cur = song.get("curated") or {"title": song["title"], "raga": song["raga"], "composer": song["composer"]}
        sid = slug(cur["title"])
        if sid in seen_ids:
            sid = f"{sid}-{page}"
        seen_ids.add(sid)

        sections, counters, i = [], {}, 0
        for sec in song["sections"]:
            name = section_name(sec["name"])
            p = line_prefix(name)
            entry = {"name": name, "lines": []}
            for text in sec["lines"]:
                counters[p] = counters.get(p, 0) + 1
                entry["lines"].append({"id": f"{p}{counters[p]}", "text": text, "meaning": info["m"][i]})
                i += 1
            sections.append(entry)

        aliases = sorted({cur["title"], song["title"]} - {""})
        out.append({
            "id": sid,
            "title": song["title"],
            "aliases": aliases,
            "composer": cur["composer"] or song["composer"],
            "raga": titlecase(cur["raga"] or song["raga"]),
            "tala": tala_name(song.get("tala", "")),
            "language": (song.get("language") or COMPOSER_LANGUAGE.get(cur["composer"], "")).replace("KannaDa", "Kannada"),
            "summary": info.get("summary", ""),
            "lyricsSource": song["source"],
            "sections": sections,
        })

    if errors:
        print("\n".join(errors), file=sys.stderr)
        sys.exit(1)
    dest = os.path.join(ROOT, "src", "data", "songs.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump({"version": 2, "songs": out}, f, ensure_ascii=False, indent=1)
    missing = len(raw) - len(out)
    print(f"wrote {len(out)} songs to src/data/songs.json ({missing} scraped songs still without meanings)")


if __name__ == "__main__":
    main()
