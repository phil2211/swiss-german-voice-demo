const talkButton = document.querySelector("#talk");
const statusEl = document.querySelector("#status");
const rawEl = document.querySelector("#raw");
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

function setStatus(text) {
  statusEl.textContent = text;
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

      if (message.type === "partial" && active) {
        rawEl.textContent = message.text || "…";
        return;
      }

      if (message.type === "utterance") {
        showResult(message);
        setStatus(message.german ? "Fertig" : "Schreibe um…");
        return;
      }

      if (message.type === "error") {
        setStatus(message.message);
        return;
      }

      if (message.type === "status" && message.state === "ready" && active) {
        setStatus("Sprich jetzt");
      }
    });
  });

  return connecting;
}

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  const context = new AudioContext();
  await context.audioWorklet.addModule("/pcm-worklet.js");
  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "pcm-processor");
  worklet.port.onmessage = (event) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(event.data);
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
  if (!audio) return;
  audio.worklet.port.onmessage = null;
  audio.source.disconnect();
  audio.worklet.disconnect();
  audio.context.close();
  for (const track of audio.stream.getTracks()) track.stop();
  audio = null;
}

function finishUtterance() {
  active = false;
  talkButton.classList.remove("live");
  talkButton.textContent = "Halten und sprechen";
  stopMic();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "finalize" }));
    setStatus("Schreibe um…");
  }
}

async function press() {
  if (active || starting) return;
  starting = true;
  cancelStart = false;
  setStatus("Verbinde…");

  try {
    await ensureSocket();
    if (cancelStart) {
      finishUtterance();
      return;
    }
    await startMic();
    if (cancelStart) {
      finishUtterance();
      return;
    }
    active = true;
    talkButton.classList.add("live");
    talkButton.textContent = "Loslassen zum Beenden";
    setStatus("Sprich jetzt");
    clearOutput();
  } catch (error) {
    stopMic();
    active = false;
    setStatus(error.message || "Mikrofon nicht verfügbar");
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
  talkButton.setPointerCapture(event.pointerId);
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
  setStatus("Schreibe um…");
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
    setStatus("Fertig");
  } catch (error) {
    germanEl.textContent = "—";
    germanEl.classList.remove("pending");
    setStatus(error.message || "Umschreibung fehlgeschlagen");
  } finally {
    submit.disabled = false;
  }
});
