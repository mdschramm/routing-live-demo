import express from "express";
import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

process.loadEnvFile(".env");

const app = express();
const client = new OpenAI({ maxRetries: 0 });
const port = 3000;
const origin = `http://localhost:${port}`;
const indexPath = resolve("index.html");

app.use(express.json({ limit: "64kb" }));
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
    const result = await client.live.create({
      session: {
        model: "gpt-live-1",
        instructions:
          "Be concise. Delegate requests needing current information to the backend, which can search the web.",
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-5.6-terra",
            instructions:
              "Use web search when current facts are needed. Return concise, grounded results for a spoken conversation.",
            tools: [{ type: "web_search" }],
            tool_choice: "auto",
          },
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

app.listen(port, "127.0.0.1", () => console.log(`Open ${origin} (OPENAI_API_KEY ${process.env.OPENAI_API_KEY ? "loaded" : "missing"})`));