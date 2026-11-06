import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { getPrompt } from "./prompts.mjs";


const settingsPath = resolve("settings.json");
async function loadSettings() {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

function buildGraph(model, system) {
  const llm = new ChatOpenAI({ model });
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => ({
      messages: [await llm.invoke([new SystemMessage(system), ...state.messages])],
    }))
    .addEdge(START, "agent")
    .addEdge("agent", END)
    .compile();
}

// Yields text chunks from the model as they stream.
export async function* runDelegation(turns, { model, signal }) {
  console.log("Running delegation", { model, turns });
  const t0 = performance.now();
  // Rebuilt per call so settings.json / STUB_MODEL changes apply immediately.
  const graph = buildGraph(model, await getPrompt("graph_system"));
  const compileMs = performance.now() - t0;
  console.log(`Graph build+compile: ${compileMs.toFixed(1)} ms`);

  const t1 = performance.now();
  let ttft;
  const messages = turns.map((t) => new HumanMessage(t));
  const stream = await graph.stream({ messages }, { streamMode: "messages", signal });
  for await (const [chunk] of stream) {
    if (typeof chunk.content === "string" && chunk.content) {
      if (ttft === undefined) {
        ttft = performance.now() - t1;
        console.log(`TTFT: ${ttft.toFixed(0)} ms (from graph.stream; ${(compileMs + ttft).toFixed(0)} ms incl. compile)`);
      }
      yield chunk.content;
    }
  }
  console.log(`Total: ${(performance.now() - t0).toFixed(0)} ms`);
}
