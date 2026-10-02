import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";
import { findMatches, loadGlossary, selectKeyterms } from "./lib/glossary.js";
import { rewriteToGerman } from "./lib/rewrite.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const TEXT_MODEL = process.env.XAI_TEXT_MODEL || "grok-4.5";
const glossary = loadGlossary(path.join(__dirname, "glossary.json"));
const keyterms = selectKeyterms(glossary);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32_000) {
        reject(new Error("Anfrage ist zu gross"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Ungültiges JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function normalize(text) {
  const raw = text.trim();
  const matches = findMatches(raw, glossary).map((entry) => ({
    swiss: entry.swiss.trim(),
    german: entry.german.trim(),
  }));
  const german = await rewriteToGerman(raw, glossary, {
    apiKey: process.env.XAI_API_KEY,
    model: TEXT_MODEL,
  });
  return { raw, matches, german };
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
      return;
    }
    const type = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(data);
  });
}

function sttUrl() {
  const params = new URLSearchParams({
    sample_rate: "16000",
    encoding: "pcm",
    interim_results: "true",
    language: "de",
  });
  for (const term of keyterms) {
    params.append("keyterm", term);
  }
  return `wss://api.x.ai/v1/stt?${params.toString()}`;
}

function send(client, payload) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

function attachSession(client) {
  if (!process.env.XAI_API_KEY) {
    send(client, { type: "error", message: "XAI_API_KEY fehlt auf dem Server" });
    client.close();
    return;
  }

  const audioQueue = [];
  const controlQueue = [];
  let queuedAudioBytes = 0;
  let upstreamReady = false;
  const maxQueuedAudioBytes = 960_000;
  let rewriteSeq = 0;
  let closed = false;

  const upstream = new WebSocket(sttUrl(), {
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
  });

  function flushUpstream() {
    if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
    for (const chunk of audioQueue) upstream.send(chunk);
    audioQueue.length = 0;
    queuedAudioBytes = 0;
    for (const message of controlQueue) upstream.send(message);
    controlQueue.length = 0;
  }

  function closeUpstream() {
    if (closed) return;
    closed = true;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: "audio.done" }));
      upstream.close();
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    }
  }

  upstream.on("open", () => {
    send(client, { type: "status", state: "connecting" });
  });

  upstream.on("message", (data, isBinary) => {
    if (isBinary) return;
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (event.type === "transcript.created") {
      upstreamReady = true;
      flushUpstream();
      send(client, { type: "status", state: "ready" });
      return;
    }

    if (event.type === "transcript.partial") {
      const text = typeof event.text === "string" ? event.text : "";
      send(client, {
        type: "partial",
        text,
        isFinal: Boolean(event.is_final),
        speechFinal: Boolean(event.speech_final),
      });

      if (event.speech_final && text.trim()) {
        const seq = ++rewriteSeq;
        const raw = text.trim();
        const matches = findMatches(raw, glossary).map((entry) => ({
          swiss: entry.swiss.trim(),
          german: entry.german.trim(),
        }));
        send(client, { type: "utterance", seq, raw, matches, german: null });
        rewriteToGerman(raw, glossary, {
          apiKey: process.env.XAI_API_KEY,
          model: TEXT_MODEL,
        })
          .then((german) => {
            if (seq !== rewriteSeq) return;
            send(client, { type: "utterance", seq, raw, matches, german });
          })
          .catch((error) => {
            if (seq !== rewriteSeq) return;
            send(client, {
              type: "error",
              message: error.message || "Umschreibung fehlgeschlagen",
            });
          });
      }
      return;
    }

    if (event.type === "error") {
      send(client, {
        type: "error",
        message: event.message || "Spracherkennung fehlgeschlagen",
      });
    }
  });

  upstream.on("error", () => {
    send(client, { type: "error", message: "Verbindung zur Spracherkennung unterbrochen" });
  });

  upstream.on("close", () => {
    send(client, { type: "status", state: "closed" });
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      const chunk = Buffer.from(data);
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(chunk);
      } else {
        audioQueue.push(chunk);
        queuedAudioBytes += chunk.length;
        while (queuedAudioBytes > maxQueuedAudioBytes && audioQueue.length > 1) {
          queuedAudioBytes -= audioQueue.shift().length;
        }
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      send(client, { type: "error", message: "Ungültige Client-Nachricht" });
      return;
    }

    if (message.type === "finalize") {
      const payload = JSON.stringify({ type: "finalize" });
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(payload);
      else controlQueue.push(payload);
      return;
    }

    if (message.type === "audio.done") {
      closeUpstream();
    }
  });

  client.on("close", closeUpstream);
  client.on("error", closeUpstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/normalize") {
    try {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "Text fehlt" });
        return;
      }
      sendJson(res, 200, await normalize(text));
    } catch (error) {
      const message = error.message || "Umschreibung fehlgeschlagen";
      const status = message === "Ungültiges JSON" || message === "Anfrage ist zu gross" ? 400 : 502;
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405).end("Method not allowed");
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", attachSession);

server.listen(PORT, () => {
  console.log(`Demo läuft auf http://localhost:${PORT}`);
});
