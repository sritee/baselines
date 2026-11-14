// End-to-end check: loads the built extension in Chromium against a mock YouTube watch page
// (network-routed, so no real YouTube access is needed) and drives the sidebar.
import { createRequire } from "node:module";
// Playwright is resolved like CommonJS so a globally installed copy (NODE_PATH) also works.
const { chromium } = createRequire(import.meta.url)("playwright");
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = path.join(root, "dist");
const video = path.join(root, "test/fixtures/test.webm");
const shots = process.env.SCREENSHOT_DIR || path.join(root, "test/screenshots");
mkdirSync(shots, { recursive: true });
if (!existsSync(video)) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x332211:s=320x180:d=90",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "90", "-c:v", "libvpx", "-b:v", "50k", "-c:a", "libopus", "-shortest", video]);
}

const page = (title, dark) => `<!doctype html><html ${dark ? "dark" : ""}><head><title>${title} - YouTube</title>
<style>
  html{--yt-spec-text-primary:#0f0f0f;--yt-spec-text-secondary:#606060;--yt-spec-base-background:#fff}
  html[dark]{--yt-spec-text-primary:#f1f1f1;--yt-spec-text-secondary:#aaa;--yt-spec-base-background:#0f0f0f;--yt-spec-badge-chip-background:rgba(255,255,255,.1);--yt-spec-10-percent-layer:rgba(255,255,255,.1)}
  body{margin:0;font-family:Roboto,Arial;background:var(--yt-spec-base-background);color:var(--yt-spec-text-primary)}
  #columns{display:flex;gap:24px;padding:24px}#primary{flex:1}#secondary{width:402px}
  video{width:100%;background:#000;border-radius:12px}
  .fake{height:94px;border-radius:8px;background:rgba(128,128,128,.15);margin-bottom:8px}
</style></head><body>
<div id="columns"><div id="primary"><video class="html5-main-video" src="/test.webm" muted></video>
<h1 class="ytd-watch-metadata"><yt-formatted-string>${title}</yt-formatted-string></h1>
<div id="description-inline-expander">Raga: Hamsadhwani. Tala: Adi.</div></div>
<div id="secondary"><div id="secondary-inner"><div class="fake"></div><div class="fake"></div><div class="fake"></div></div></div></div>
</body></html>`;

const userDataDir = mkdtempSync(path.join(tmpdir(), "cm-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--autoplay-policy=no-user-gesture-required"],
});
let dark = false;
await context.route("https://www.youtube.com/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/test.webm") {
    // Media is only seekable when the server honours Range requests.
    const buf = readFileSync(video);
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] || "");
    const start = m ? +m[1] : 0, end = m && m[2] ? +m[2] : buf.length - 1;
    return route.fulfill({
      status: m ? 206 : 200,
      body: buf.subarray(start, end + 1),
      headers: { "content-type": "video/webm", "accept-ranges": "bytes", ...(m && { "content-range": `bytes ${start}-${end}/${buf.length}` }) },
    });
  }
  const titles = { V1: "Vaathapi Ganapathim | Hamsadhwani | Adi | Dikshitar", V2: "Some unknown Ragam Tanam Pallavi" };
  return route.fulfill({ contentType: "text/html", body: page(titles[url.searchParams.get("v")] || "Video", dark) });
});

const p = await context.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const seek = (t) => p.evaluate((t) => new Promise((r) => { const v = document.querySelector("video"); v.addEventListener("seeked", r, { once: true }); v.currentTime = t; }), t);
const time = () => p.evaluate(() => document.querySelector("video").currentTime);

await p.goto("https://www.youtube.com/watch?v=V1");
await p.waitForSelector("#secondary-inner > #cm-panel", { timeout: 10000 });
await p.evaluate(() => new Promise((r) => { const v = document.querySelector("video"); v.readyState >= 1 ? r() : v.addEventListener("loadedmetadata", r, { once: true }); }));
assert.match(await p.textContent(".cm-title"), /Vātāpi/);
assert.match(await p.textContent(".cm-sub"), /Dikshitar · Raga Hamsadhwani · Adi tala/);
assert.match(await p.textContent(".cm-status"), /Not timed yet/);
console.log("✓ auto-detected song from title and mounted in the right column");

// Time a few lines (video paused, so taps land exactly at the playhead).
await p.click(".cm-btn-primary");
await seek(2); await p.click(".cm-chip[title^='Alapana']");
await seek(10); await p.click(".cm-line[data-ref='p1']");
await seek(16); await p.click(".cm-line[data-ref='p2']");
await seek(24); await p.keyboard.press("n"); // next line → a1
await seek(30); await p.keyboard.press("r"); // repeat a1
await seek(34); await p.keyboard.press("n"); await p.keyboard.press("u"); // add a2 then undo it
await p.click(".cm-btn-primary"); // Done
assert.match(await p.textContent(".cm-status"), /^5 timing marks/);
console.log("✓ sync mode: clicks, marker chips and N/R/U keys record cues");

await seek(17);
await p.waitForSelector(".cm-line.cm-active[data-ref='p2']");
assert.match(await p.textContent(".cm-now-meaning"), /giver of boons/);
await seek(5);
await p.waitForFunction(() => /Alapana/.test(document.querySelector(".cm-now-section").textContent));
await seek(26);
await p.waitForSelector(".cm-line.cm-active[data-ref='a1']");
console.log("✓ highlight + now-playing card follow the playhead");

await p.click(".cm-line[data-ref='p1']");
assert.ok(Math.abs((await time()) - 10) < 0.1, "clicking a line seeks to it");
console.log("✓ clicking a timed line seeks the video");

// Play for real and check the highlight advances on its own.
await seek(14.5);
await p.evaluate(() => document.querySelector("video").play());
await p.waitForSelector(".cm-line.cm-active[data-ref='p2']", { timeout: 5000 });
await p.evaluate(() => document.querySelector("video").pause());
console.log("✓ highlight advances during playback");

await seek(17);
await p.waitForSelector(".cm-line.cm-active[data-ref='p2']");
await p.locator("#cm-panel").screenshot({ path: path.join(shots, "panel-light.png") });
await p.screenshot({ path: path.join(shots, "page-light.png") });

// Persistence across reloads.
await p.waitForTimeout(500);
await p.reload();
await p.waitForSelector("#cm-panel .cm-title");
assert.match(await p.textContent(".cm-status"), /^5 timing marks/);
console.log("✓ timings persist across reloads");

// SPA navigation to a video with no known song.
await p.evaluate(() => {
  history.pushState({}, "", "/watch?v=V2");
  document.querySelector("h1 yt-formatted-string").textContent = "Some unknown Ragam Tanam Pallavi";
  document.dispatchEvent(new Event("yt-navigate-finish"));
});
await p.waitForFunction(() => /No song matched/.test(document.querySelector("#cm-panel .cm-meta").textContent));
console.log("✓ SPA navigation re-detects; unknown song shows the picker");

// Manual pick is remembered per video.
await p.selectOption("#cm-panel .cm-select:not(.cm-more)", "bantu-reethi");
await p.waitForTimeout(500);
await p.reload();
await p.waitForFunction(() => /Bantu/.test(document.querySelector("#cm-panel .cm-title")?.textContent || ""));
console.log("✓ manually chosen song is remembered for the video");

// Ask Claude without a key gives a clear message.
await p.click("#cm-panel .cm-btn:not(.cm-btn-primary)");
await p.waitForFunction(() => /API key/.test(document.querySelector(".cm-status").textContent));
console.log("✓ 'Ask Claude' without a key explains what to do");

// Dark-mode screenshot.
dark = true;
await p.goto("https://www.youtube.com/watch?v=V1");
await p.waitForSelector("#cm-panel .cm-line");
await seek(25);
await p.waitForSelector(".cm-line.cm-active[data-ref='a1']");
await p.locator("#cm-panel").screenshot({ path: path.join(shots, "panel-dark.png") });

assert.deepEqual(errors, [], "page errors: " + errors.join("; "));
await context.close();
console.log("All e2e checks passed. Screenshots in", shots);
