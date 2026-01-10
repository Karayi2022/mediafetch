import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/**
 * Env
 */
const PORT = Number(process.env.PORT || 3002);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/data/downloads";
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

/**
 * Ensure output dir exists
 */
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Very small Basic Auth middleware.
 * Applies to everything (UI + downloads + API).
 */
function basicAuth(req, res, next) {
  // If not configured, allow access (useful for local dev)
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return next();

  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MediaFetch"');
    return res.status(401).send("Auth required");
  }

  const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="MediaFetch"');
  return res.status(401).send("Invalid credentials");
}

app.use(basicAuth);

/**
 * Serve UI (public/)
 * - GET / loads public/index.html automatically
 */
app.use(express.static(path.join(__dirname, "public")));

/**
 * Serve downloaded files
 * - GET /downloads/<file>
 */
app.use("/downloads", express.static(OUTPUT_DIR));

/**
 * Helpers
 */
function safeSlug(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "mediafetch";
}

function normalisePublicBaseUrl(req) {
  // Prefer explicit PUBLIC_BASE_URL (best behind reverse proxies)
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");

  // Fallback: infer from request (works in some setups)
  const proto =
    (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() ||
    "http";
  const host =
    (req.headers["x-forwarded-host"] || req.headers.host || "")
      .toString()
      .split(",")[0]
      .trim();

  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function cleanInputUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "";
  // Very light validation: must look like http(s) URL
  if (!/^https?:\/\//i.test(u)) return "";
  return u;
}

/**
 * SSE endpoint to run yt-dlp
 * Call like:
 *   GET /api/run?url=<encoded>&mode=video|audio&name=optional
 *
 * Streams:
 *  event: start
 *  event: log
 *  event: done  { ok, downloadUrl }
 */
app.get("/api/run", (req, res) => {
  const rawUrl = req.query.url;
  const mode = (req.query.mode || "video").toString();
  const name = (req.query.name || "").toString();

  const cleanUrl = cleanInputUrl(rawUrl);
  if (!cleanUrl) return res.status(400).json({ ok: false, error: "Invalid url" });

  // Job id + filename template
  const jobId = crypto.randomBytes(8).toString("hex");
  const baseName = safeSlug(name) || "mediafetch";
  const outTemplate = path.join(OUTPUT_DIR, `${baseName}-${jobId}.%(ext)s`);

  // yt-dlp args
  const argsBase = [
    "--no-warnings",
    "--newline",
    "--restrict-filenames",
    "--no-playlist",
    "--no-part",
    "-o",
    outTemplate,
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
  res.flushHeaders?.();

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
    const baseUrl = normalisePublicBaseUrl(req);
    let link = null;

    // Only produce a link if the file is inside OUTPUT_DIR
    if (code === 0 && lastFile) {
      const normalisedOutput = path.resolve(OUTPUT_DIR) + path.sep;
      const normalisedFile = path.resolve(lastFile);

      if (normalisedFile.startsWith(normalisedOutput) && baseUrl) {
        const rel = normalisedFile.slice(normalisedOutput.length).replace(/^\/+/, "");
        link = `${baseUrl}/downloads/${rel}`;
      }
    }

    send("done", { ok: code === 0, code, downloadUrl: link });
    res.end();
  });

  proc.on("error", (err) => {
    send("done", { ok: false, error: err.message });
    res.end();
  });
});

/**
 * Optional: basic health endpoint (nice for Dokploy checks)
 */
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`MediaFetch listening on :${PORT}`));
