// Song matching: turns a YouTube video title into the best-matching song id.
// Carnatic titles are transliterated many ways ("Vathapi Ganapathim", "Vaatapi
// Ganapatim", "vātāpi gaṇapatiṃ"), so both sides are reduced to a rough phonetic key.
(function (root) {
  function phoneticKey(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics: ā→a, ṇ→n, ṃ→m
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .replace(/([bcdgjkpt])h/g, "$1") // aspirates: bh→b, th→t, dh→d …
      .replace(/sh/g, "s")
      .replace(/zh/g, "l")
      .replace(/w/g, "v")
      .replace(/ee/g, "i")
      .replace(/oo/g, "u")
      .replace(/y/g, "i")
      .replace(/(.)\1+/g, "$1"); // collapse doubled letters: aa→a, tt→t
  }

  // Returns { song, score } for the best match or null. Longest matching alias wins,
  // so "nagumomu ganaleni" beats a shorter alias of some other song.
  function matchSong(title, songs) {
    const key = phoneticKey(title);
    if (!key) return null;
    let best = null;
    for (const song of songs) {
      const names = [song.title, ...(song.aliases || [])];
      for (const name of names) {
        const k = phoneticKey(name);
        if (k.length >= 5 && key.includes(k) && (!best || k.length > best.score)) {
          best = { song, score: k.length };
        }
      }
    }
    return best;
  }

  const api = { phoneticKey, matchSong };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CarnaticMatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
