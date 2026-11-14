import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The lib files are classic content scripts that attach to globalThis.
await import("../src/lib/match.js");
await import("../src/lib/cues.js");
const { matchSong, phoneticKey } = globalThis.CarnaticMatch;
const { activeCueIndex, seekTimeForRef, sortCues, formatTime } = globalThis.CarnaticCues;
const { songs } = JSON.parse(readFileSync(new URL("../src/data/songs.json", import.meta.url)));

test("transliteration variants share a key", () => {
  assert.equal(phoneticKey("Vathapi Ganapathim"), phoneticKey("vātāpi gaṇapatiṃ"));
  assert.equal(phoneticKey("Bantureethi"), phoneticKey("Bantu Rīti"));
});

test("matches real-world style titles", () => {
  const cases = {
    "Vaathapi Ganapathim | Hamsadhwani | M S Subbulakshmi": "vatapi-ganapatim",
    "Nagumomu Ganaleni - Abheri - Live concert 2019": "nagumomu-ganaleni",
    "BANTU REETHI KOLUVU | Hamsanadam | Tyagaraja": "bantu-reethi",
  };
  for (const [title, id] of Object.entries(cases)) assert.equal(matchSong(title, songs)?.song.id, id, title);
  assert.equal(matchSong("Lo-fi beats to study to", songs), null);
});

test("song data is well-formed", () => {
  for (const s of songs) {
    const ids = s.sections.flatMap((x) => x.lines.map((l) => l.id));
    assert.equal(new Set(ids).size, ids.length, `duplicate line id in ${s.id}`);
    for (const sec of s.sections) for (const l of sec.lines) assert.ok(l.text && l.meaning, `${s.id}/${l.id}`);
  }
});

test("cue lookup handles repeats", () => {
  const cues = sortCues([{ t: 30, ref: "a1" }, { t: 0, ref: "@alapana" }, { t: 10, ref: "p1" }, { t: 50, ref: "p1" }]);
  assert.equal(activeCueIndex(cues, 5), 0);
  assert.equal(cues[activeCueIndex(cues, 12)].ref, "p1");
  assert.equal(cues[activeCueIndex(cues, 55)].ref, "p1");
  assert.equal(activeCueIndex([], 5), -1);
  assert.equal(seekTimeForRef(cues, "p1", 20), 50);
  assert.equal(seekTimeForRef(cues, "p1", 60), 10);
  assert.equal(seekTimeForRef(cues, "c1", 0), null);
  assert.equal(formatTime(3725), "1:02:05");
});
