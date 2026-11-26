const DEFAULT_SCRIPT = `Oh my god!
Stay away from me!
Somebody help me!
No, no, no, no!
Don't come any closer!
Don't shoot!
I give up!
My hands are up!
I don't have a weapon!
Okay, okay, I surrender!
Please don't kill me!
Please, I have a family!
I'm begging you!
Please let me go!
I'll do anything you want!
Please, I don't want to die!
Why are you doing this?
I just want to go home!
Please, please don't!
Oh no, please!
I'm on the ground!
I won't move, I swear!
Okay, I'm down!
Don't hurt me!
I'm not going to run!
Thank you!
Oh, thank you so much!
Bless you!
I won't forget this!
Thank you, thank you!
My leg!
No, get up, get up!
Help me up!
I feel dizzy.
I can't breathe.
Everything is spinning.
Stay back, I'm armed!
Not today!
I will defend myself!
Follow me!
This way, move!
Stay close to me!
Run! I'll hold him off!
Leave them alone!
Take me instead!
No! They saved us!
Don't let it be for nothing!
No, not like this!`;

const $ = id => document.getElementById(id);
const scriptInput = $("scriptInput");
const voiceGrid = $("voiceGrid");
let voices = [];
let selectedIds = new Set();
let activeJob = null;
let pollTimer = null;

scriptInput.value = DEFAULT_SCRIPT;

function linesFromScript() {
  return scriptInput.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
function updateLineCount() {
  $("lineCount").textContent = linesFromScript().length;
}
function setServerStatus(ok, text) {
  $("serverStatus").textContent = text;
  document.querySelector(".status-dot").style.background = ok ? "#b5f36b" : "#f3b75c";
}
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}
function voiceDescription(voice) {
  const labels = voice.labels || {};
  return [labels.accent, labels.age, labels.language || "English"].filter(Boolean).join(" · ") || "English voice";
}
function renderVoices(filter = "") {
  const term = filter.toLowerCase();
  const visible = voices.filter(v =>
    (v.name + " " + voiceDescription(v) + " " + (v.description || "")).toLowerCase().includes(term)
  );
  if (!visible.length) {
    voiceGrid.innerHTML = '<div class="loading-card">No voices match that search.</div>';
    return;
  }
  voiceGrid.innerHTML = visible.map((voice, index) => {
    const selected = selectedIds.has(voice.voice_id);
    const initial = escapeHtml((voice.name || "V").slice(0, 1).toUpperCase());
    return `<article class="voice-card ${selected ? "selected" : ""}">
      <input class="voice-check" type="checkbox" data-id="${escapeHtml(voice.voice_id)}" ${selected ? "checked" : ""} aria-label="Select ${escapeHtml(voice.name)}">
      <div class="voice-avatar">${initial}</div>
      <div class="voice-meta"><div class="voice-name">${escapeHtml(voice.name)}</div><div class="voice-details">${escapeHtml(voiceDescription(voice))}</div></div>
      ${voice.preview_url ? `<button class="preview-button" data-preview="${escapeHtml(voice.preview_url)}" title="Preview voice">▶</button>` : ""}
    </article>`;
  }).join("");
}
async function loadVoices() {
  voiceGrid.innerHTML = '<div class="loading-card">Connecting to the voice library…</div>';
  $("refreshVoices").disabled = true;
  try {
    const response = await fetch("/api/voices");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load voices.");
    voices = data.voices || [];
    selectedIds = new Set(voices.map(v => v.voice_id));
    $("voiceCount").textContent = voices.length;
    $("castNote").textContent = voices.length >= 50
      ? "50 distinct male voices loaded. Each dialogue line will use a different voice."
      : "The provider returned " + voices.length + " usable male voices. You need at least as many voices as dialogue lines.";
    renderVoices($("voiceSearch").value);
    setServerStatus(true, "Voice library connected");
  } catch (error) {
    voiceGrid.innerHTML = '<div class="loading-card">' + escapeHtml(error.message) + '</div>';
    setServerStatus(false, "API key or connection needed");
  } finally {
    $("refreshVoices").disabled = false;
  }
}
voiceGrid.addEventListener("change", event => {
  const input = event.target.closest(".voice-check");
  if (!input) return;
  if (input.checked) selectedIds.add(input.dataset.id);
  else selectedIds.delete(input.dataset.id);
  renderVoices($("voiceSearch").value);
});
voiceGrid.addEventListener("click", event => {
  const button = event.target.closest("[data-preview]");
  if (!button) return;
  const audio = new Audio(button.dataset.preview);
  audio.play().catch(() => {});
});
$("voiceSearch").addEventListener("input", event => renderVoices(event.target.value));
$("refreshVoices").addEventListener("click", loadVoices);
$("restoreScript").addEventListener("click", () => {
  scriptInput.value = DEFAULT_SCRIPT;
  updateLineCount();
});
scriptInput.addEventListener("input", updateLineCount);

function showError(message) {
  $("errorBox").textContent = message;
  $("errorBox").classList.remove("hidden");
}
function setProgress(progress, total, message) {
  const percent = total ? Math.round(progress / total * 100) : 0;
  $("progressBar").style.width = percent + "%";
  $("progressNumber").textContent = percent + "%";
  $("progressMessage").textContent = message;
}
async function pollStatus() {
  if (!activeJob) return;
  try {
    const response = await fetch("/api/status/" + encodeURIComponent(activeJob));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read generation status.");
    setProgress(data.progress, data.total, data.message);
    if (data.error) {
      showError(data.error);
      finishGeneration();
      return;
    }
    if (data.downloadUrl) {
      $("downloadButton").href = data.downloadUrl;
      $("audioPlayer").src = data.downloadUrl;
      $("resultBox").classList.remove("hidden");
      finishGeneration();
      return;
    }
    if (!data.active) {
      showError("Generation stopped before the MP3 was ready.");
      finishGeneration();
    }
  } catch (error) {
    showError(error.message);
    finishGeneration();
  }
}
function finishGeneration() {
  activeJob = null;
  clearInterval(pollTimer);
  $("generateButton").disabled = false;
  $("generateButton").querySelector("span").textContent = "Generate one MP3";
}
$("generateButton").addEventListener("click", async () => {
  $("errorBox").classList.add("hidden");
  $("resultBox").classList.add("hidden");
  const lines = linesFromScript();
  const chosen = voices.filter(v => selectedIds.has(v.voice_id)).map(v => v.voice_id);
  if (!lines.length) return showError("Add some dialogue lines first.");
  if (lines.length > 50) return showError("This version supports up to 50 dialogue lines per MP3.");
  if (chosen.length < lines.length) return showError("Select at least " + lines.length + " different voices for " + lines.length + " lines.");
  $("generateButton").disabled = true;
  $("generateButton").querySelector("span").textContent = "Starting…";
  $("progressArea").classList.remove("hidden");
  setProgress(0, lines.length, "Preparing your cast…");
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines, voiceIds: chosen })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start generation.");
    activeJob = data.jobId;
    $("generateButton").querySelector("span").textContent = "Generating audio…";
    pollTimer = setInterval(pollStatus, 1800);
    pollStatus();
  } catch (error) {
    showError(error.message);
    finishGeneration();
  }
});

updateLineCount();
fetch("/api/health").then(r => r.json()).then(data => {
  if (data.configured) loadVoices();
  else setServerStatus(false, "Add server API key");
}).catch(() => setServerStatus(false, "Server unavailable"));
