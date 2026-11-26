require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ELEVENLABS_API_KEY;
const API_BASE = "https://api.elevenlabs.io";
const GENERATED_DIR = path.join(__dirname, "generated");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(GENERATED_DIR));

fs.mkdirSync(GENERATED_DIR, { recursive: true });

let voiceCache = { expires: 0, voices: [] };
let job = {
  id: null,
  active: false,
  progress: 0,
  total: 0,
  message: "Ready",
  downloadUrl: null,
  error: null
};

function requireApiKey(res) {
  if (!API_KEY) {
    res.status(503).json({
      error: "The server is missing ELEVENLABS_API_KEY. Add it to your private .env file and restart."
    });
    return false;
  }
  return true;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "xi-api-key": API_KEY,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error("Voice provider returned " + response.status + ": " + body.slice(0, 500));
  }
  return response;
}

async function getMaleVoices(force = false) {
  if (!force && voiceCache.expires > Date.now() && voiceCache.voices.length) {
    return voiceCache.voices;
  }

  const collected = [];
  for (let page = 0; page < 4 && collected.length < 50; page++) {
    const url = new URL(API_BASE + "/v1/shared-voices");
    url.searchParams.set("gender", "male");
    url.searchParams.set("language", "en");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "trending");

    const response = await apiRequest(url);
    const data = await response.json();
    for (const voice of (data.voices || [])) {
      const id = voice.voice_id || voice.id;
      const owner = voice.public_owner_id || voice.public_user_id;
      if (!id || !owner || collected.some(v => v.voice_id === id)) continue;
      collected.push({
        voice_id: id,
        public_owner_id: owner,
        name: voice.name || "Unnamed voice",
        labels: voice.labels || {},
        description: voice.description || "",
        preview_url: voice.preview_url || null,
        category: voice.category || ""
      });
      if (collected.length >= 50) break;
    }
    if (!data.has_more) break;
  }

  voiceCache = { voices: collected, expires: Date.now() + 10 * 60 * 1000 };
  return collected;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(API_KEY) });
});

app.get("/api/voices", async (_req, res) => {
  if (!requireApiKey(res)) return;
  try {
    const voices = await getMaleVoices();
    res.json({
      voices: voices.map(({ voice_id, name, labels, description, preview_url, category }) => ({
        voice_id, name, labels, description, preview_url, category
      })),
      count: voices.length,
      required: 50
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

function safeText(value) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function voiceSettingsFor(line) {
  const text = line.toLowerCase();
  if (/thank|bless|saved|forget this/.test(text)) {
    return { stability: 0.48, similarity_boost: 0.78, style: 0.45, use_speaker_boost: true };
  }
  if (/follow me|this way|stay close|run!|leave them|take me|defend|not today/.test(text)) {
    return { stability: 0.32, similarity_boost: 0.78, style: 0.72, use_speaker_boost: true };
  }
  return { stability: 0.28, similarity_boost: 0.78, style: 0.68, use_speaker_boost: true };
}

function runFfmpeg(concatFile, outputFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
      "-vn", "-c:a", "libmp3lame", "-q:a", "2", outputFile
    ], { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error("Audio merge failed: " + stderr.slice(-1200)));
    });
  });
}

async function importSharedVoice(voice) {
  const url = API_BASE + "/v1/voices/add/" +
    encodeURIComponent(voice.public_owner_id) + "/" +
    encodeURIComponent(voice.voice_id);

  // If the voice is already in the account collection, continue to TTS.
  try {
    await apiRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: voice.name.slice(0, 80), bookmarked: true })
    });
  } catch (error) {
    if (!/already|exist|duplicate|409|422/i.test(error.message)) throw error;
  }
}

async function createClip(line, voice, filePath) {
  await importSharedVoice(voice);

  const url = API_BASE + "/v1/text-to-speech/" +
    encodeURIComponent(voice.voice_id) + "?output_format=mp3_44100_128";

  const response = await apiRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: line,
      model_id: "eleven_multilingual_v2",
      voice_settings: voiceSettingsFor(line)
    })
  });

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 1000) throw new Error("The provider returned an empty audio clip.");
  fs.writeFileSync(filePath, audio);
}

async function generateJob(lines, voices, id) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "voiceforge-"));
  const clipPaths = [];

  try {
    for (let i = 0; i < lines.length; i++) {
      job.progress = i;
      job.message = "Recording line " + (i + 1) + " of " + lines.length + " — " + voices[i].name;
      const clipPath = path.join(tempDir, String(i + 1).padStart(3, "0") + ".mp3");
      await createClip(lines[i], voices[i], clipPath);
      clipPaths.push(clipPath);
    }

    job.message = "Combining all recordings into one MP3…";
    const concatFile = path.join(tempDir, "clips.txt");
    const concatText = clipPaths
      .map(file => "file '" + file.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'")
      .join("\n");
    fs.writeFileSync(concatFile, concatText, "utf8");

    const outputName = "voiceforge-" + id + ".mp3";
    const outputPath = path.join(GENERATED_DIR, outputName);
    await runFfmpeg(concatFile, outputPath);

    job.progress = lines.length;
    job.downloadUrl = "/downloads/" + outputName;
    job.message = "Finished — all lines are in one MP3.";
    job.active = false;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

app.post("/api/generate", async (req, res) => {
  if (!requireApiKey(res)) return;
  if (job.active) return res.status(409).json({ error: "A generation is already running." });

  const lines = Array.isArray(req.body.lines) ? req.body.lines.map(safeText).filter(Boolean) : [];
  if (!lines.length) return res.status(400).json({ error: "Add at least one dialogue line." });
  if (lines.length > 50) return res.status(400).json({ error: "Maximum 50 lines per combined recording." });

  try {
    const available = await getMaleVoices();
    const requestedIds = Array.isArray(req.body.voiceIds) ? req.body.voiceIds : [];
    const selected = requestedIds.length
      ? requestedIds.map(id => available.find(v => v.voice_id === id)).filter(Boolean)
      : available;

    const unique = [];
    for (const voice of selected) {
      if (!unique.some(v => v.voice_id === voice.voice_id)) unique.push(voice);
    }
    if (unique.length < lines.length) {
      return res.status(400).json({
        error: "You have " + unique.length + " usable male voices for " + lines.length +
          " lines. The voice library returned fewer than the number of lines. Try refreshing the voice list or selecting more voices."
      });
    }

    const id = crypto.randomUUID();
    job = {
      id,
      active: true,
      progress: 0,
      total: lines.length,
      message: "Starting voice generation…",
      downloadUrl: null,
      error: null
    };

    generateJob(lines, unique.slice(0, lines.length), id).catch(error => {
      job.active = false;
      job.error = error.message;
      job.message = "Generation failed.";
    });

    res.status(202).json({ jobId: id, total: lines.length });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/status/:id", (req, res) => {
  if (req.params.id !== job.id) return res.status(404).json({ error: "Generation job not found." });
  res.json({
    active: job.active,
    progress: job.progress,
    total: job.total,
    message: job.message,
    downloadUrl: job.downloadUrl,
    error: job.error
  });
});

app.listen(PORT, () => {
  console.log("VoiceForge 50+ running at http://localhost:" + PORT);
});
