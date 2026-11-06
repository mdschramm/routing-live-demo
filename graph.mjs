import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, Annotation, MessagesAnnotation, MemorySaver, START, END } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getPrompt } from "./prompts.mjs";
import { loadHospitals, sameRow, uniqueValues } from "./hospitals.mjs";

// Per-conversation state lives here, keyed by thread_id (= Live session id).
const checkpointer = new MemorySaver();

const State = Annotation.Root({
  columns: Annotation(), // CSV header
  allHospitals: Annotation(), // cached at conversation start, sorted left-to-right
  filtered: Annotation(), // narrowed subset; filter() preserves order so it stays sorted
  transcript: Annotation(), // [{role, text}] overwritten each delegation
  messages: MessagesAnnotation.spec.messages,
});

const transcriptText = (transcript) => transcript.map((t) => `${t.role}: ${t.text}`).join("\n");
const describe = (rows, columns) =>
  Object.entries(uniqueValues(rows, columns))
    .map(([c, values]) => `${c}: ${values.slice(0, 15).join(" | ")}${values.length > 15 ? " | ..." : ""}`)
    .join("\n");

async function loadState() {
  const data = await loadHospitals();
  const { columns, rows } = data ?? { columns: [], rows: [] };
  return { columns, allHospitals: rows, filtered: rows };
}

function buildGraph({ model, filterModel }) {
  const llm = new ChatOpenAI({ model });
  const filterLlm = new ChatOpenAI({ model: filterModel });

  const speak = (promptName) => async (state) => {
    const system = await getPrompt(promptName);
    const context = [
      `Conversation:\n${transcriptText(state.transcript)}`,
      `Matching options (${state.filtered.length} rows):\n${describe(state.filtered, state.columns)}`,
      state.filtered.length === 1 || sameRow(state.columns, state.filtered[0], state.filtered.at(-1))
        ? `The single match: ${JSON.stringify(state.filtered[0])}`
        : "",
    ].join("\n\n");
    const reply = await llm.invoke([new SystemMessage(system), new HumanMessage(context)]);
    return { messages: [reply] };
  };

  return new StateGraph(State)
    .addNode("filter", async (state) => {
      // Safety net if /api/conversation/start didn't run first.
      const base = state.allHospitals ? {} : await loadState();
      const columns = state.columns ?? base.columns;
      let filtered = state.filtered ?? base.filtered;
      const shape = {};
      for (const [column, values] of Object.entries(uniqueValues(filtered, columns))) {
        if (values.length > 1) {
          shape[column] = z.enum(values).nullable().describe(`Value for "${column}" the user specified, or null`);
        }
      }
      if (Object.keys(shape).length && filtered.length) {
        const prompt = await getPrompt("filter_system");
        const picked = await filterLlm
          .withStructuredOutput(z.object(shape))
          .invoke([new SystemMessage(prompt), new HumanMessage(transcriptText(state.transcript))]);
        console.log("Filter picked", picked);
        for (const [column, value] of Object.entries(picked)) {
          if (value != null) filtered = filtered.filter((r) => r[column] === value);
        }
      }
      console.log(`Filtered rows: ${filtered.length}`);
      return { ...base, columns, filtered };
    })
    .addNode("proposal", speak("proposal_system"))
    .addNode("ask", speak("ask_system"))
    .addEdge(START, "filter")
    // Rows are sorted, so "all remaining rows identical" is first === last.
    .addConditionalEdges("filter", (state) =>
      state.filtered.length && sameRow(state.columns, state.filtered[0], state.filtered.at(-1)) ? "proposal" : "ask",
    )
    .addEdge("proposal", END)
    .addEdge("ask", END)
    .compile({ checkpointer });
}

// Load hospitals.csv into this conversation's state (once, at conversation start).
export async function startConversation(sessionId, models) {
  const graph = buildGraph(models);
  const state = await loadState();
  await graph.updateState({ configurable: { thread_id: sessionId } }, state, START);
  return state.allHospitals.length;
}

// Yields spoken text chunks from the proposal/ask nodes as they stream.
export async function* runDelegation(transcript, { sessionId, model, filterModel, signal }) {
  console.log("Running delegation", { model, filterModel, sessionId, turns: transcript.length });
  const t0 = performance.now();
  // Rebuilt per call so settings.json / STUB_MODEL changes apply immediately.
  const graph = buildGraph({ model, filterModel });
  const compileMs = performance.now() - t0;
  console.log(`Graph build+compile: ${compileMs.toFixed(1)} ms`);

  const t1 = performance.now();
  let ttft;
  const stream = await graph.stream(
    { transcript },
    { configurable: { thread_id: sessionId }, streamMode: "messages", signal },
  );
  for await (const [chunk, meta] of stream) {
    if (!["proposal", "ask"].includes(meta.langgraph_node)) continue;
    if (typeof chunk.content === "string" && chunk.content) {
      if (ttft === undefined) {
        ttft = performance.now() - t1;
        console.log(`TTFT: ${ttft.toFixed(0)} ms (from graph.stream; ${(compileMs + ttft).toFixed(0)} ms incl. compile) via ${meta.langgraph_node}`);
      }
      yield chunk.content;
    }
  }
  console.log(`Total: ${(performance.now() - t0).toFixed(0)} ms`);
}
