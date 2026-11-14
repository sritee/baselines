// Service worker: serves the song list and, if the user has set an Anthropic API key,
// asks Claude for the lyrics and meaning of songs that aren't in the bundled database.
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-5-5";

async function getBundledSongs() {
  const res = await fetch(chrome.runtime.getURL("data/songs.json"));
  return (await res.json()).songs.map((s) => ({ ...s, source: "bundled" }));
}

async function getAllSongs() {
  const [bundled, { customSongs = {} }] = await Promise.all([
    getBundledSongs(),
    chrome.storage.local.get("customSongs"),
  ]);
  // A custom song with the same id overrides the bundled one (lets users correct entries).
  const byId = new Map(bundled.map((s) => [s.id, s]));
  for (const s of Object.values(customSongs)) byId.set(s.id, s);
  return [...byId.values()];
}

// ---------- Claude generation ----------

const SONG_TOOL = {
  name: "submit_song",
  description:
    "Submit the identified song with its lyrics split into lines, each with an English meaning.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["identified", "title", "aliases", "composer", "raga", "tala", "language", "summary", "notes", "sections"],
    properties: {
      identified: {
        type: "boolean",
        description: "false if you cannot tell which composition this video is, or are unsure of its lyrics.",
      },
      title: { type: "string", description: "Standard title of the composition, transliterated (IAST preferred)." },
      aliases: {
        type: "array",
        items: { type: "string" },
        description: "Common English spellings of the title as they appear in YouTube titles.",
      },
      composer: { type: "string" },
      raga: { type: "string" },
      tala: { type: "string" },
      language: { type: "string" },
      summary: { type: "string", description: "Two or three sentences on what the song is about." },
      notes: {
        type: "string",
        description: "Caveats: lines you are unsure of, known variant readings. Empty string if none.",
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "lines"],
          properties: {
            name: { type: "string", description: "Pallavi, Anupallavi, Charanam, Charanam 2, Chittaswaram, …" },
            lines: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "meaning", "words"],
                properties: {
                  text: { type: "string", description: "One sung line, transliterated." },
                  meaning: { type: "string", description: "Plain-English meaning of the line." },
                  words: {
                    type: "array",
                    description: "Word-by-word glosses for the line.",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["word", "gloss"],
                      properties: { word: { type: "string" }, gloss: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You help listeners of Carnatic music follow the meaning of the song they are hearing.
You are given a YouTube video's title and description. Identify the composition (kriti, varnam, keertanam, javali, tillana, etc.) and call the submit_song tool once with its full lyrics, split into the lines a singer phrases as units, each with a faithful plain-English meaning. Write lyrics in IAST transliteration of the original language.
Accuracy matters more than completeness: listeners will read along with a live performance. If you do not know the composition's lyrics reliably, set identified to false and leave sections empty rather than reconstructing them. Mention any uncertain lines or variant readings in notes. The video description often names the raga, tala and composer, and sometimes contains the lyrics; prefer it when present.`;

function slug(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function toSong(input, model) {
  if (!input || !Array.isArray(input.sections) || typeof input.title !== "string") {
    throw new Error("Claude returned an unexpected response shape.");
  }
  const prefix = { pallavi: "p", anupallavi: "a", charanam: "c", chittaswaram: "s" };
  const counters = {};
  const sections = input.sections.map((sec, si) => {
    const p = prefix[String(sec.name).toLowerCase().split(/[\s(]/)[0]] || `s${si}_`;
    return {
      name: sec.name,
      lines: (sec.lines || []).map((l) => {
        counters[p] = (counters[p] || 0) + 1;
        return { id: `${p}${counters[p]}`, text: l.text, meaning: l.meaning, words: l.words || [] };
      }),
    };
  });
  return {
    id: "ai-" + slug(input.title),
    title: input.title,
    aliases: input.aliases || [],
    composer: input.composer,
    raga: input.raga,
    tala: input.tala,
    language: input.language,
    summary: input.summary,
    notes: input.notes,
    sections,
    source: "claude",
    model,
    createdAt: new Date().toISOString(),
  };
}

async function generateSong({ title, description }) {
  const { apiKey, model = DEFAULT_MODEL } = await chrome.storage.local.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("Add your Anthropic API key in the extension settings first.");

  // The key belongs to the user and lives only in this browser's extension storage;
  // requests go straight from the extension to api.anthropic.com.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // on a policy decline, retry on a fallback model in the same call
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    tools: [SONG_TOOL],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: `YouTube title:\n${title}\n\nYouTube description:\n${description || "(none)"}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined this request" + (response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."));
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The response was cut off before it finished. Try again.");
  }
  const call = response.content.find((b) => b.type === "tool_use" && b.name === "submit_song");
  if (!call) {
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    throw new Error(text || "Claude did not return a song.");
  }
  if (!call.input.identified || !call.input.sections.length) {
    throw new Error(
      "Claude could not identify this song reliably." + (call.input.notes ? ` ${call.input.notes}` : "")
    );
  }

  const song = toSong(call.input, response.model);
  const { customSongs = {} } = await chrome.storage.local.get("customSongs");
  customSongs[song.id] = song;
  await chrome.storage.local.set({ customSongs });
  return song;
}

function errorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected. Check it in the settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key doesn't have access to that model.";
  if (err instanceof Anthropic.NotFoundError) return "Unknown model. Check the model name in the settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again in a minute.";
  // APIConnectionError is a subclass of APIError, so check it first.
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "?"}): ${err.message}`;
  return err?.message || String(err);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    getSongs: () => getAllSongs(),
    generate: () => generateSong(msg),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
  return true; // keep the channel open for the async response
});
