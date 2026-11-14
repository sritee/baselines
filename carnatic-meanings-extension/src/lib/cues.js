// Timing model. A performance is a list of cues {t, ref} sorted by time, where ref is a
// line id ("p1", "c3") or a section marker ("@alapana", "@niraval", "@swaram", "@tani").
// Lines can recur any number of times — sangatis and returns to the pallavi are normal.
(function (root) {
  const MARKERS = {
    "@alapana": "Alapana (raga improvisation)",
    "@tanam": "Tanam",
    "@niraval": "Niraval (melodic elaboration of a line)",
    "@swaram": "Kalpanaswaram (improvised solfa)",
    "@tani": "Tani avartanam (percussion solo)",
  };

  function sortCues(cues) {
    return [...cues].sort((a, b) => a.t - b.t);
  }

  // Index of the cue active at time t (last cue with cue.t <= t), or -1.
  function activeCueIndex(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].t <= t + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Time to seek to when a line is clicked: the next occurrence after `now`,
  // otherwise its first occurrence. null if the line has never been cued.
  function seekTimeForRef(cues, ref, now) {
    const hits = cues.filter((c) => c.ref === ref);
    if (!hits.length) return null;
    const next = hits.find((c) => c.t > now + 0.5);
    return (next || hits[0]).t;
  }

  function formatTime(t) {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
  }

  const api = { MARKERS, sortCues, activeCueIndex, seekTimeForRef, formatTime };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CarnaticCues = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
