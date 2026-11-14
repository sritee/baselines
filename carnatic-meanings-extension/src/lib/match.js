// Song matching: turns a YouTube video title into the best-matching song.
// Carnatic titles are transliterated many ways ("Vathapi Ganapathim", "Vaatapi
// Ganapatim", "vAtApi gaNapatim", "vātāpi gaṇapatiṃ"), so both sides are reduced to a
// rough phonetic key. Keep this in sync with key() in tools/scrape_karnatik.py.
(function (root) {
  function phoneticKey(s) {
    let k = String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics: ā→a, ṇ→n, ṃ→m
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .replace(/([bcdgjkpt])h/g, "$1"); // aspirates: bh→b, th→t, dh→d …
    const pairs = [["sh", "s"], ["zh", "l"], ["w", "v"], ["ee", "i"], ["oo", "u"], ["y", "i"],
      ["x", "ks"], ["g", "k"], ["d", "t"], ["b", "p"]]; // voiced/unvoiced vary between Tamil and Telugu spellings
    for (const [a, b] of pairs) k = k.split(a).join(b);
    return k.replace(/(.)\1+/g, "$1"); // collapse doubled letters: aa→a, tt→t
  }

  const MIN_ALIAS = 8; // shorter aliases ("ilalo", "uyyala") only count when the raga is also in the title
  const RAGA_BONUS = 20;

  // Returns { song, score } for the best match, or null.
  function matchSong(title, songs) {
    const key = phoneticKey(title);
    if (!key) return null;
    let best = null;
    for (const song of songs) {
      const ragaKey = phoneticKey(song.raga);
      const ragaInTitle = ragaKey.length >= 4 && key.includes(ragaKey);
      for (const name of [song.title, ...(song.aliases || [])]) {
        const k = phoneticKey(name);
        if (k.length < 5 || !key.includes(k)) continue;
        if (k.length < MIN_ALIAS && !ragaInTitle) continue;
        const score = k.length + (ragaInTitle ? RAGA_BONUS : 0);
        if (!best || score > best.score) best = { song, score };
      }
    }
    return best;
  }

  const api = { phoneticKey, matchSong };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CarnaticMatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
