// Content script for youtube.com: injects the meanings sidebar on watch pages and keeps
// the highlighted line in step with the video.
// DOM is built with createElement only — YouTube enforces Trusted Types, so innerHTML throws.
(() => {
  const { matchSong } = globalThis.CarnaticMatch;
  const { MARKERS, sortCues, activeCueIndex, seekTimeForRef, formatTime } = globalThis.CarnaticCues;

  const REACTION_OFFSET = 0.4; // seconds subtracted from a tap, to allow for reaction time

  const state = {
    videoId: null,
    title: "",
    songs: [],
    song: null,
    autoMatched: false,
    cues: [],
    syncing: false,
    showWords: false,
    collapsed: false,
    activeIdx: -2,
    lastActiveLineRef: null,
    message: "",
  };
  let ui = null;
  let navToken = 0;

  // ---------- helpers ----------

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // replaceChildren() that, like h(), flattens arrays and skips null/false.
  function fill(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  }

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
        });
      } catch (e) {
        resolve({ ok: false, error: "Extension was reloaded — refresh this page." });
      }
    });

  const store = {
    get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
    set: (k, v) => chrome.storage.local.set({ [k]: v }),
  };

  const getVideo = () => document.querySelector("video.html5-main-video") || document.querySelector("video");
  const currentVideoId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);

  function readTitle() {
    const el = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, #title h1");
    const t = el?.textContent?.trim();
    return t || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/, "").trim();
  }

  function readDescription() {
    const el = document.querySelector("#description-inline-expander, ytd-text-inline-expander, #description");
    return el?.innerText?.trim() || "";
  }

  function allLines(song) {
    return song ? song.sections.flatMap((s) => s.lines.map((l) => ({ ...l, section: s.name }))) : [];
  }

  function lineByRef(ref) {
    return allLines(state.song).find((l) => l.id === ref) || null;
  }

  // ---------- persistence ----------

  let saveTimer = null;
  function saveVideo() {
    clearTimeout(saveTimer);
    const videoId = state.videoId;
    const record = {
      songId: state.song && !state.autoMatched ? state.song.id : null,
      cues: state.cues,
      updatedAt: Date.now(),
    };
    saveTimer = setTimeout(() => store.set("video:" + videoId, record), 300);
  }

  // ---------- lifecycle ----------

  async function onNavigate() {
    const videoId = currentVideoId();
    if (videoId === state.videoId && ui?.root.isConnected) return;
    const token = ++navToken;
    state.videoId = videoId;
    state.syncing = false;
    state.song = null; // don't show the previous video's song while the new one loads
    state.cues = [];
    state.loading = true;
    render();
    if (!videoId) {
      ui?.root.remove();
      ui = null;
      return;
    }

    // Wait for YouTube to render the new title (SPA navigation updates it late).
    const prevTitle = state.title;
    for (let i = 0; i < 40; i++) {
      const t = readTitle();
      if (t && t !== prevTitle && t !== "YouTube") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (token !== navToken) return;
    state.title = readTitle();

    const [songsRes, record, prefs] = await Promise.all([
      send({ type: "getSongs" }),
      store.get("video:" + videoId),
      store.get("prefs"),
    ]);
    if (token !== navToken) return;
    state.songs = songsRes?.ok ? songsRes.data : [];
    state.showWords = !!prefs?.showWords;
    state.collapsed = !!prefs?.collapsed;
    state.cues = sortCues(record?.cues || []);
    const manual = record?.songId ? state.songs.find((s) => s.id === record.songId) : null;
    if (manual) {
      state.song = manual;
      state.autoMatched = false;
    } else {
      state.song = matchSong(state.title, state.songs)?.song || null;
      state.autoMatched = !!state.song;
    }
    state.message = songsRes?.ok ? "" : songsRes?.error || "";
    state.loading = false;
    mount();
    render();
  }

  function mount() {
    if (ui?.root.isConnected) return;
    ui = buildPanel();
    placePanel();
  }

  function placePanel() {
    if (!ui) return;
    const host = document.querySelector("#secondary-inner") || document.querySelector("#secondary");
    if (host && host.offsetParent !== null) {
      ui.root.classList.remove("cm-floating");
      if (host.firstChild !== ui.root) host.prepend(ui.root);
    } else if (!ui.root.isConnected || ui.root.parentElement !== document.body) {
      ui.root.classList.add("cm-floating"); // no right column (e.g. narrow window)
      document.body.append(ui.root);
    }
  }

  // ---------- UI ----------

  function buildPanel() {
    const root = h("section", { class: "cm-panel", id: "cm-panel", "aria-label": "Carnatic song meanings" });
    const refs = { root };

    refs.toggle = h("button", { class: "cm-icon-btn", title: "Collapse / expand", onClick: () => {
      state.collapsed = !state.collapsed;
      store.set("prefs", { showWords: state.showWords, collapsed: state.collapsed });
      render();
    } });
    root.append(h("header", { class: "cm-header" }, h("span", { class: "cm-logo" }, "♪"), h("span", { class: "cm-brand" }, "Carnatic Meanings"), refs.toggle));

    refs.body = h("div", { class: "cm-body" });
    root.append(refs.body);

    refs.meta = h("div", { class: "cm-meta" });
    refs.select = h("select", { class: "cm-select", title: "Choose the song for this video", onChange: (e) => {
      const id = e.target.value;
      state.song = state.songs.find((s) => s.id === id) || null;
      state.autoMatched = false;
      state.lastActiveLineRef = null;
      saveVideo();
      render();
    } });
    refs.generate = h("button", { class: "cm-btn", title: "Ask Claude for this song's lyrics and meaning", onClick: generate }, "Ask Claude");
    refs.sync = h("button", { class: "cm-btn cm-btn-primary", onClick: toggleSync });
    refs.more = h("select", { class: "cm-select cm-more", title: "More", onChange: (e) => { const v = e.target.value; e.target.value = ""; moreAction(v); } },
      h("option", { value: "" }, "More…"),
      h("option", { value: "words" }, "Toggle word meanings"),
      h("option", { value: "export" }, "Export timings + song (JSON)"),
      h("option", { value: "import" }, "Import JSON…"),
      h("option", { value: "clear" }, "Clear timings for this video"));
    refs.file = h("input", { type: "file", accept: "application/json,.json", hidden: true, onChange: importFile });
    refs.controls = h("div", { class: "cm-controls" }, refs.select, refs.generate, refs.sync, refs.more, refs.file);

    refs.status = h("div", { class: "cm-status", role: "status" });

    refs.syncBar = h("div", { class: "cm-syncbar" },
      h("div", { class: "cm-sync-help" }, "Click each line as it begins (or press ", h("kbd", {}, "N"), " next line, ", h("kbd", {}, "R"), " repeat line, ", h("kbd", {}, "U"), " undo)."),
      h("div", { class: "cm-markers" },
        Object.entries(MARKERS).map(([ref, label]) =>
          h("button", { class: "cm-chip", title: label, onClick: () => addCue(ref) }, label.split(" (")[0])),
        h("button", { class: "cm-chip", onClick: undoCue }, "Undo")));

    refs.now = h("div", { class: "cm-now", "aria-live": "polite" });
    refs.lyrics = h("div", { class: "cm-lyrics" });

    refs.body.append(refs.meta, refs.controls, refs.status, refs.syncBar, refs.now, refs.lyrics);
    return refs;
  }

  function render() {
    if (!ui) return;
    const { song } = state;
    ui.root.classList.toggle("cm-collapsed", state.collapsed);
    ui.root.classList.toggle("cm-syncing", state.syncing);
    ui.toggle.textContent = state.collapsed ? "▾" : "▴";

    // Meta
    fill(ui.meta,
      song
        ? h("div", {},
            h("div", { class: "cm-title" }, song.title),
            h("div", { class: "cm-sub" }, [song.composer, song.raga && "Raga " + song.raga, song.tala && song.tala + " tala", song.language].filter(Boolean).join(" · ")),
            song.summary && h("p", { class: "cm-summary" }, song.summary),
            song.lyricsSource && h("p", { class: "cm-credit" }, "Lyrics: ",
              h("a", { href: song.lyricsSource, target: "_blank", rel: "noopener" }, new URL(song.lyricsSource).hostname.replace(/^www\./, "")),
              " · English meanings are line-by-line drafts"),
            song.source === "claude" && h("p", { class: "cm-note" }, "Generated by Claude — may contain errors." + (song.notes ? " " + song.notes : "")))
        : h("div", { class: "cm-sub" }, state.loading ? "Loading…" : "No song matched this video. Pick one below, import one, or ask Claude."));

    // Song picker
    fill(ui.select,
      h("option", { value: "" }, "— choose song —"),
      [...state.songs].sort((a, b) => a.title.localeCompare(b.title)).map((s) =>
        h("option", { value: s.id, selected: song?.id === s.id }, s.title + (s.source === "claude" ? " (AI)" : ""))));
    ui.select.value = song?.id || "";

    ui.sync.textContent = state.syncing ? "Done" : state.cues.length ? "Re-sync" : "Sync";
    ui.sync.disabled = !song;
    ui.generate.disabled = false;

    // Status
    let status = state.message;
    if (!status && song) {
      status = state.cues.length
        ? `${state.cues.length} timing marks · click a line to jump to it`
        : "Optional: press Sync and click each line as it's sung to highlight along with the video.";
      if (state.autoMatched) status += " · auto-detected from title";
    }
    ui.status.textContent = status;

    // Lyrics
    fill(ui.lyrics,
      ...(song?.sections || []).map((sec) =>
        h("div", { class: "cm-section" },
          h("div", { class: "cm-section-name" }, sec.name),
          sec.lines.map((line) =>
            h("div", { class: "cm-line", dataset: { ref: line.id }, tabIndex: 0, onClick: () => onLineClick(line.id),
                onKeydown: (e) => { if (e.key === "Enter") onLineClick(line.id); } },
              h("div", { class: "cm-text" }, line.text),
              h("div", { class: "cm-meaning" }, line.meaning),
              state.showWords && line.words?.length &&
                h("div", { class: "cm-words" }, line.words.map((w) => h("span", { class: "cm-word" }, h("b", {}, w.word), " ", w.gloss))))))));

    state.activeIdx = -2; // force the next tick to repaint highlight
    tick();
  }

  function renderNow(cue) {
    if (!state.song) return fill(ui.now);
    if (!cue) {
      // Without timings the panel is just the lyrics and meanings; the now-playing card stays hidden.
      return state.cues.length ? fill(ui.now, h("div", { class: "cm-now-empty" }, "Waiting for the song to begin…")) : fill(ui.now);
    }
    if (cue.ref.startsWith("@")) {
      const last = state.lastActiveLineRef && cue.ref === "@niraval" ? lineByRef(state.lastActiveLineRef) : null;
      return fill(ui.now,
        h("div", { class: "cm-now-section" }, MARKERS[cue.ref] || cue.ref),
        last && h("div", { class: "cm-now-text" }, last.text),
        last && h("div", { class: "cm-now-meaning" }, last.meaning));
    }
    const line = lineByRef(cue.ref);
    if (!line) return fill(ui.now);
    fill(ui.now,
      h("div", { class: "cm-now-section" }, line.section, " · ", formatTime(cue.t)),
      h("div", { class: "cm-now-text" }, line.text),
      h("div", { class: "cm-now-meaning" }, line.meaning));
  }

  // ---------- playback sync ----------

  function tick() {
    if (!ui || !state.song) return;
    const video = getVideo();
    const t = video ? video.currentTime : 0;
    const idx = activeCueIndex(state.cues, t);
    if (idx === state.activeIdx) return;
    state.activeIdx = idx;
    const cue = idx >= 0 ? state.cues[idx] : null;
    if (cue && !cue.ref.startsWith("@")) state.lastActiveLineRef = cue.ref;
    renderNow(cue);

    // During niraval keep the line being elaborated highlighted.
    const ref = cue ? (cue.ref.startsWith("@") ? (cue.ref === "@niraval" ? state.lastActiveLineRef : null) : cue.ref) : null;
    let activeEl = null;
    for (const el of ui.lyrics.querySelectorAll(".cm-line")) {
      const on = el.dataset.ref === ref;
      el.classList.toggle("cm-active", on);
      if (on) activeEl = el;
    }
    if (activeEl && !state.collapsed) {
      // Scroll only the lyrics box, never the page.
      const box = ui.lyrics;
      const top = activeEl.offsetTop - box.offsetTop - box.clientHeight / 3;
      box.scrollTo({ top, behavior: "smooth" });
    }
  }

  // ---------- actions ----------

  function onLineClick(ref) {
    if (state.syncing) return addCue(ref);
    const video = getVideo();
    if (!video) return;
    const t = seekTimeForRef(state.cues, ref, video.currentTime);
    if (t == null) {
      flash(state.song ? "That line isn't timed yet — press Sync to time it." : "");
      return;
    }
    video.currentTime = t;
    tick();
  }

  function addCue(ref) {
    const video = getVideo();
    if (!video || !state.song) return;
    const t = Math.max(0, +(video.currentTime - (video.paused ? 0 : REACTION_OFFSET)).toFixed(2));
    // Re-tapping right where a cue already is replaces it instead of stacking duplicates.
    state.cues = sortCues([...state.cues.filter((c) => Math.abs(c.t - t) > 0.75), { t, ref }]);
    saveVideo();
    state.activeIdx = -2;
    tick();
    ui.status.textContent = `${state.cues.length} timing marks · last: ${ref.startsWith("@") ? MARKERS[ref].split(" (")[0] : ref} at ${formatTime(t)}`;
  }

  function undoCue() {
    const video = getVideo();
    if (!state.cues.length) return;
    // Remove the cue closest before the playhead (the one most recently tapped while playing).
    const idx = Math.max(0, activeCueIndex(state.cues, video ? video.currentTime : Infinity));
    state.cues = state.cues.filter((_, i) => i !== idx);
    saveVideo();
    state.activeIdx = -2;
    tick();
    ui.status.textContent = `${state.cues.length} timing marks`;
  }

  function nextRef(step) {
    const lines = allLines(state.song);
    if (!lines.length) return null;
    const cur = lines.findIndex((l) => l.id === state.lastActiveLineRef);
    if (step === 0) return cur >= 0 ? lines[cur].id : lines[0].id;
    return lines[Math.min(lines.length - 1, cur + 1)].id;
  }

  function toggleSync() {
    if (!state.song) return;
    if (!state.syncing && state.cues.length && !confirm("Start re-timing? Existing marks stay; new taps are added and replace marks at the same moment. Use More → Clear timings to start from scratch.")) return;
    state.syncing = !state.syncing;
    state.message = "";
    render();
  }

  function flash(text) {
    if (!ui || !text) return;
    ui.status.textContent = text;
  }

  async function generate() {
    ui.generate.disabled = true;
    ui.generate.textContent = "Asking Claude…";
    ui.status.textContent = "Identifying the song and writing out its meaning — this can take a minute.";
    const res = await send({ type: "generate", title: state.title, description: readDescription(), videoId: state.videoId });
    ui.generate.textContent = "Ask Claude";
    if (!res?.ok) {
      state.message = res?.error || "Something went wrong.";
      render();
      state.message = "";
      return;
    }
    state.songs = [...state.songs.filter((s) => s.id !== res.data.id), res.data];
    state.song = res.data;
    state.autoMatched = false;
    saveVideo();
    render();
  }

  function moreAction(action) {
    if (action === "words") {
      state.showWords = !state.showWords;
      store.set("prefs", { showWords: state.showWords, collapsed: state.collapsed });
      render();
    } else if (action === "export") {
      const data = {
        format: "carnatic-meanings/v1",
        videoId: state.videoId,
        videoTitle: state.title,
        songId: state.song?.id || null,
        cues: state.cues,
        song: state.song && state.song.source !== "bundled" ? state.song : undefined,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = h("a", { href: url, download: `carnatic-${state.song?.id || "song"}-${state.videoId}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else if (action === "import") {
      ui.file.value = "";
      ui.file.click();
    } else if (action === "clear") {
      if (!state.cues.length || confirm("Delete all timing marks for this video?")) {
        state.cues = [];
        saveVideo();
        render();
      }
    }
  }

  function isSong(x) {
    return x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.sections);
  }

  async function importFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const song = isSong(data) ? data : isSong(data.song) ? data.song : null;
      if (song) {
        const imported = { ...song, source: song.source === "claude" ? "claude" : "imported" };
        const customSongs = (await store.get("customSongs")) || {};
        customSongs[imported.id] = imported;
        await store.set("customSongs", customSongs);
        state.songs = [...state.songs.filter((s) => s.id !== imported.id), imported];
      }
      const songId = song?.id || data.songId;
      const picked = songId && state.songs.find((s) => s.id === songId);
      if (picked) { state.song = picked; state.autoMatched = false; }
      if (Array.isArray(data.cues)) {
        state.cues = sortCues(data.cues.filter((c) => typeof c.t === "number" && typeof c.ref === "string"));
      }
      saveVideo();
      state.message = data.videoId && data.videoId !== state.videoId
        ? "Imported. Note: these timings were made for a different video, so they may not line up."
        : "Imported.";
      render();
      state.message = "";
    } catch (err) {
      flash("Couldn't read that file: " + err.message);
    }
  }

  // Keyboard shortcuts while syncing. Captured before YouTube's own handlers.
  window.addEventListener("keydown", (e) => {
    if (!state.syncing || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === "n") addCue(nextRef(1) || "p1");
    else if (key === "r") addCue(nextRef(0));
    else if (key === "u") undoCue();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ---------- boot ----------

  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; onNavigate(); }
    if (ui) { placePanel(); tick(); }
  }, 250);
  onNavigate();
})();
