import express from "express";
import OpenAI from "openai";
import { runDelegation, startConversation } from "./graph.mjs";
import { getPrompt } from "./prompts.mjs";
import { seedHospitals, saveHospitalsCsv, loadHospitals } from "./hospitals.mjs";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

process.loadEnvFile(".env");
await seedHospitals();

const app = express();
const client = new OpenAI({ maxRetries: 0 });
const port = 3000;
const origin = `http://localhost:${port}`;
const indexPath = resolve("index.html");

const settingsPath = resolve("settings.json");
async function loadSettings() {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

app.use(express.json({ limit: "1mb" }));
app.get("/", async (_request, response) => {
  response.type("html").send(await readFile(indexPath, "utf8"));
});

// Local-only demo. Add your application's authentication and authorization
// before exposing session creation to other users.
app.post("/api/session", async (request, response) => {
  if (request.headers.origin !== origin) {
    response.status(403).json({ error: "Unexpected request origin" });
    return;
  }
  if (typeof request.body?.sdp !== "string" || !request.body.sdp.trim()) {
    response.status(400).json({ error: "An SDP offer is required" });
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({ error: "Set OPENAI_API_KEY on the server" });
    return;
  }

  try {
    const ackDelay = (await loadSettings()).delegation?.acknowledgementDelayMs;
    const result = await client.live.create({
      session: {
        model: "gpt-live-1",
        instructions: await getPrompt("live_instructions"),
        delegation: {
          type: "client",
          ...(ackDelay != null && { acknowledgement_delay_ms: ackDelay }),
        },
      },
      transport: {
        type: "webrtc",
        sdp: request.body.sdp,
      },
    });
    // Preserve the SDK's typed session ID and SDP answer.
    response.status(201).json(result);
  } catch (error) {
    if (!(error instanceof OpenAI.APIError)) throw error;
    console.error("Live session creation failed", error.status, error.code, error.message);
    response
      .status(error.status ?? 502)
      .json({ error: "Live session creation failed" });
  }
});


const sameOrigin = (request, response) => {
  if (request.headers.origin === origin) return true;
  response.status(403).json({ error: "Unexpected request origin" });
  return false;
};

app.get("/api/settings", async (_request, response) => {
  response.json(await loadSettings());
});

app.get("/api/hospitals", async (_request, response) => {
  try {
    const data = await loadHospitals();
    if (!data) return void response.status(204).end();
    response.json(data);
  } catch (error) {
    console.error("Hospitals load failed", error.message);
    response.status(500).json({ error: "Stored hospitals.csv is invalid" });
  }
});

app.post(
  "/api/hospitals",
  express.text({ type: "text/csv", limit: "1mb" }),
  async (request, response) => {
    if (!sameOrigin(request, response)) return;
    if (typeof request.body !== "string" || !request.body.trim()) {
      response.status(400).json({ error: "A text/csv body is required" });
      return;
    }
    try {
      response.json({ count: await saveHospitalsCsv(request.body) });
    } catch (error) {
      if (error.status !== 400) throw error;
      response.status(400).json({ error: error.message });
    }
  },
);

const validSession = (id) => typeof id === "string" && /^[\w-]+$/.test(id);

app.post("/api/conversation/start", async (request, response) => {
  if (!sameOrigin(request, response)) return;
  if (!validSession(request.body?.sessionId)) {
    response.status(400).json({ error: "sessionId is required" });
    return;
  }
  const settings = await loadSettings();
  const count = await startConversation(request.body.sessionId, {
    model: process.env.STUB_MODEL ?? settings.model,
    filterModel: settings.filterModel,
  });
  response.json({ count });
});

app.post("/api/delegate", async (request, response) => {
  if (!sameOrigin(request, response)) return;
  const { sessionId, transcript } = request.body ?? {};
  if (
    !validSession(sessionId) ||
    !Array.isArray(transcript) ||
    !transcript.length ||
    !transcript.every((t) => ["user", "agent"].includes(t?.role) && typeof t.text === "string")
  ) {
    response.status(400).json({ error: "sessionId and a non-empty transcript [{role,text}] are required" });
    return;
  }
  const settings = await loadSettings();
  const model = process.env.STUB_MODEL ?? settings.model;
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  try {
    for await (const text of runDelegation(transcript, { sessionId, model, filterModel: settings.filterModel, signal: controller.signal })) {
      response.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    response.write("event: done\ndata: {}\n\n");
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error("Delegation failed", error.message);
      response.write(`event: error\ndata: ${JSON.stringify({ error: "Delegation failed" })}\n\n`);
    }
  }
  response.end();
});

app.post("/api/transcript", async (request, response) => {
  if (!sameOrigin(request, response)) return;
  const { transcript: cfg } = await loadSettings();
  const { sessionId, turns } = request.body ?? {};
  if (!cfg?.saveToFile) return void response.status(204).end();
  if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId) || !Array.isArray(turns)) {
    response.status(400).json({ error: "sessionId and turns are required" });
    return;
  }
  const dir = resolve(cfg.dir ?? "transcripts");
  await mkdir(dir, { recursive: true });
  await appendFile(
    resolve(dir, `${sessionId}.jsonl`),
    turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
  response.status(204).end();
});

app.listen(port, "127.0.0.1", () => console.log(`Open ${origin} (OPENAI_API_KEY ${process.env.OPENAI_API_KEY ? "loaded" : "missing"})`));