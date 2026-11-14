#!/usr/bin/env python3
"""Prints songs [start, end) of data/lyrics_raw.json compactly, for writing meanings."""
import json, sys, os
here = os.path.dirname(os.path.abspath(__file__))
songs = json.load(open(os.path.join(here, "..", "data", "lyrics_raw.json")))["songs"]
start, end = int(sys.argv[1]), int(sys.argv[2])
for i, s in enumerate(songs[start:end], start):
    page = s["source"].rsplit("/", 1)[1].replace(".shtml", "")
    print(f"## {i} {page} | {s['title']} | {s['raga']} | {s['composer']} | {s['language']}")
    n = 0
    for sec in s["sections"]:
        for l in sec["lines"]:
            print(f"{n} [{sec['name'][:4]}] {l}")
            n += 1
