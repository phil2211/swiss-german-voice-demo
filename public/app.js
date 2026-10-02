const talkButton = document.querySelector("#talk");
const statusEl = document.querySelector("#status");
const statusTextEl = document.querySelector("#status-text");
const rawEl = document.querySelector("#raw");
const liveEl = document.querySelector("#live");
const levelEl = document.querySelector("#level");
const liveFinalEl = document.querySelector("#live-final");
const liveInterimEl = document.querySelector("#live-interim");
const matchesEl = document.querySelector("#matches");
const germanEl = document.querySelector("#german");
const textForm = document.querySelector("#text-form");
const textInput = document.querySelector("#text-input");

let socket = null;
let audio = null;
let active = false;
let starting = false;
let cancelStart = false;
let connecting = null;
let liveChunks = [];
let micGranted = false;

function renderLive(interim = "") {
  const finalText = liveChunks.join(" ");
  liveFinalEl.textContent = finalText;
  liveInterimEl.textContent = interim ? (finalText ? " " : "") + interim : "";
  liveEl.classList.toggle("has-text", Boolean(finalText || interim));
}

function resetLive() {
  liveChunks = [];
  renderLive();
}

// Partial events arrive in three flavours: interim (text may still change),
// chunk final (locked, roughly 3 s of speech) and utterance final (whole stitched utterance).
function handlePartial({ text, isFinal, speechFinal }) {
  if (speechFinal) {
    liveChunks = text ? [text] : [];
    renderLive();
    return;
  }
  if (isFinal) {
    if (text) liveChunks.push(text);
    renderLive();
    return;
  }
  renderLive(text);
}

// state: idle | busy | listening | done | error
function setStatus(text, state = "idle") {
  statusTextEl.textContent = text;
  statusEl.dataset.state = state;
}

function clearOutput() {
  rawEl.textContent = "…";
  germanEl.textContent = "—";
  germanEl.classList.remove("pending");
  matchesEl.replaceChildren();
  const empty = document.createElement("li");
  empty.className = "empty";
  empty.textContent = "Keine Treffer";
  matchesEl.append(empty);
}

function showResult({ raw, matches, german }) {
  rawEl.textContent = raw || "—";
  matchesEl.replaceChildren();

  if (!matches?.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Keine Treffer";
    matchesEl.append(empty);
  } else {
    for (const match of matches) {
      const item = document.createElement("li");
      item.textContent = `${match.swiss} → ${match.german}`;
      matchesEl.append(item);
    }
  }

  germanEl.textContent = german || "Schreibe um…";
  germanEl.classList.toggle("pending", !german);
}

function ensureSocket() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (connecting) return connecting;

  connecting = new Promise((resolve, reject) => {
    const next = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    next.addEventListener("open", () => {
      socket = next;
      connecting = null;
      resolve(next);
    }, { once: true });
    next.addEventListener("error", () => {
      connecting = null;
      reject(new Error("Verbindung zum Server fehlgeschlagen"));
    }, { once: true });
    next.addEventListener("close", () => {
      if (socket === next) socket = null;
    });
    next.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "partial") {
        handlePartial(message);
        if (message.speechFinal && !message.text?.trim()) {
          setStatus("Nichts verstanden. Bitte nochmals sprechen.", "idle");
        }
        return;
      }

      if (message.type === "utterance") {
        showResult(message);
        if (message.german) setStatus("Fertig", "done");
        else setStatus("Schreibe um…", "busy");
        return;
      }

      if (message.type === "error") {
        setStatus(message.message, "error");
        return;
      }

      if (message.type === "status" && message.state === "ready" && active) {
        setStatus("Sprich jetzt", "listening");
      }
    });
  });

  return connecting;
}

const MIC_CONSTRAINTS = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  video: false,
};

function describeMicError(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Mikrofon-Zugriff verweigert. Bitte in den Browser-Einstellungen für diese Seite erlauben.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Kein Mikrofon gefunden.";
    case "NotReadableError":
      return "Mikrofon ist belegt oder vom System blockiert (macOS: Systemeinstellungen → Datenschutz → Mikrofon).";
    default:
      return error?.message || "Mikrofon nicht verfügbar";
  }
}

async function micPermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    return result.state;
  } catch {
    return "unknown";
  }
}

// Ask once for permission without starting a session. While the browser prompt is
// open the user has to release the button, which would otherwise cancel the recording.
async function requestMicPermission() {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  for (const track of stream.getTracks()) track.stop();
}

function setLevel(value) {
  levelEl.style.setProperty("--level", String(Math.min(1, value * 4)));
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Dieser Browser gibt kein Mikrofon frei (https oder localhost nötig).");
  }
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  const context = new AudioContext();
  await context.audioWorklet.addModule("/pcm-worklet.js");
  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "pcm-processor");
  worklet.onprocessorerror = () => setStatus("Audio-Verarbeitung abgebrochen", "error");
  worklet.port.onmessage = (event) => {
    const message = event.data;
    if (message?.type === "level") {
      setLevel(message.value);
      return;
    }
    if (message?.type === "error") {
      setStatus(`Audio-Fehler: ${message.message}`, "error");
      return;
    }
    if (message?.type === "audio" && socket?.readyState === WebSocket.OPEN) {
      socket.send(message.buffer);
    }
  };
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(worklet);
  worklet.connect(silent);
  silent.connect(context.destination);
  if (context.state === "suspended") await context.resume();
  audio = { stream, context, source, worklet };
}

function stopMic() {
  setLevel(0);
  if (!audio) return;
  audio.worklet.port.onmessage = null;
  audio.source.disconnect();
  audio.worklet.disconnect();
  audio.context.close();
  for (const track of audio.stream.getTracks()) track.stop();
  audio = null;
}

function finishUtterance() {
  const wasActive = active;
  active = false;
  talkButton.classList.remove("live");
  talkButton.textContent = "Halten und sprechen";
  stopMic();
  if (wasActive && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "finalize" }));
    setStatus("Schreibe um…", "busy");
  } else {
    setStatus("Bereit");
  }
}

async function press() {
  if (active || starting) return;
  starting = true;
  cancelStart = false;

  try {
    const permission = await micPermissionState();
    if (permission === "prompt" || (permission === "unknown" && !micGranted)) {
      setStatus("Bitte Mikrofon-Zugriff erlauben…", "busy");
      await requestMicPermission();
      micGranted = true;
      setStatus("Mikrofon freigegeben. Taste nochmals halten und sprechen.", "done");
      return;
    }

    setStatus("Verbinde…", "busy");
    await ensureSocket();
    if (cancelStart) {
      finishUtterance();
      return;
    }
    await startMic();
    micGranted = true;
    if (cancelStart) {
      finishUtterance();
      return;
    }
    active = true;
    talkButton.classList.add("live");
    talkButton.textContent = "Loslassen zum Beenden";
    setStatus("Sprich jetzt", "listening");
    clearOutput();
    resetLive();
  } catch (error) {
    stopMic();
    active = false;
    setStatus(describeMicError(error), "error");
  } finally {
    starting = false;
  }
}

function release() {
  cancelStart = true;
  if (active || audio) finishUtterance();
}

talkButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  try {
    talkButton.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is a nicety; keep going without it.
  }
  press();
});

talkButton.addEventListener("pointerup", release);
talkButton.addEventListener("pointercancel", release);
talkButton.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("beforeunload", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "audio.done" }));
  }
});

textForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;

  const submit = textForm.querySelector("button");
  submit.disabled = true;
  setStatus("Schreibe um…", "busy");
  rawEl.textContent = text;
  germanEl.textContent = "Schreibe um…";
  germanEl.classList.add("pending");

  try {
    const response = await fetch("/api/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Umschreibung fehlgeschlagen");
    showResult(body);
    setStatus("Fertig", "done");
  } catch (error) {
    germanEl.textContent = "—";
    germanEl.classList.remove("pending");
    setStatus(error.message || "Umschreibung fehlgeschlagen", "error");
  } finally {
    submit.disabled = false;
  }
});
