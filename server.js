import express from "express";
import basicAuth from "express-basic-auth";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = express();

// Config
app.use(express.json({ limit: "256kb" }));
const PORT = Number(process.env.PORT || 3000);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/data/downloads";
const BASE_URL = process.env.PUBLIC_BASE_URL || ""; 
const AUTH_USER = process.env.BASIC_AUTH_USER || "admin";
const AUTH_PASS = process.env.BASIC_AUTH_PASS || "changeme";

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 1. Basic Auth (Browser Prompt)
app.use(
  basicAuth({
    users: { [AUTH_USER]: AUTH_PASS },
    challenge: true,
    realm: "MediaFetch",
  })
);

// 2. Static Assets
app.use("/assets", express.static(path.join(process.cwd(), "assets"))); 
app.use("/downloads", express.static(OUTPUT_DIR, { fallthrough: false }));

// 3. Helpers
function safeUrl(input) {
  try {
    const u = new URL(input);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function makeJobId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// 4. API
app.post("/api/fetch", async (req, res) => {
  const { url, mode, filename } = req.body || {};
  const cleanUrl = typeof url === "string" ? safeUrl(url.trim()) : null;

  if (!cleanUrl) return res.status(400).json({ error: "Invalid URL." });

  const jobId = makeJobId();
  
  // Clean filename: alphanumeric + dashes/underscores only
  const cleanBase =
    typeof filename === "string" && filename.trim()
      ? filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)
      : "";

  // Template: Use custom name if provided, else title + ID
  const outTemplate = cleanBase
    ? path.join(OUTPUT_DIR, `${cleanBase}.%(ext)s`)
    : path.join(OUTPUT_DIR, "%(title).200B [%(id)s].%(ext)s");

  const argsBase = [
    "--no-warnings",
    "--newline",
    "--restrict-filenames",
    "--no-playlist",
    "--no-part",
    "-o", outTemplate
  ];

  let args = [];
  if (mode === "audio") {
    // Extract Audio (mp3)
    args = [...argsBase, "-x", "--audio-format", "mp3", "--audio-quality", "192K", cleanUrl];
  } else {
    // Best Video + Best Audio (merge to mp4)
    args = [...argsBase, "-f", "bv*+ba/b", "--merge-output-format", "mp4", cleanUrl];
  }

  // Setup SSE stream
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("start", { jobId });

  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  let lastFile = null;

  const onLine = (chunk) => {
    const text = chunk.toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      // Heuristic to find the final filename
      if (line.includes("Destination:") || line.includes("Merging formats into")) {
        const m = line.match(/(?:Destination:|Merging formats into)\s+"?([^"]+)"?$/);
        if (m?.[1]) lastFile = m[1].trim();
      }
      send("log", { line });
    }
  };

  proc.stdout.on("data", onLine);
  proc.stderr.on("data", onLine);

  proc.on("close", (code) => {
    let link = null;
    if (code === 0 && lastFile && lastFile.startsWith(OUTPUT_DIR)) {
      const rel = lastFile.slice(OUTPUT_DIR.length).replace(/^\/+/, "");
      link = `${BASE_URL}/downloads/${rel}`;
    }
    send("done", { ok: code === 0, code, downloadUrl: link });
    res.end();
  });

  proc.on("error", (err) => {
    send("done", { ok: false, error: err.message });
    res.end();
  });
});

app.listen(PORT, () => console.log(`MediaFetch listening on :${PORT}`));