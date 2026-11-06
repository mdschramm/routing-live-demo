import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, Annotation, MessagesAnnotation, MemorySaver, START, END } from "@langchain/langgraph";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getPrompt } from "./prompts.mjs";
import { loadHospitals, sameRow, uniqueValues } from "./hospitals.mjs";

// Per-conversation state lives here, keyed by thread_id (= Live session id).
const checkpointer = new MemorySaver();

const State = Annotation.Root({
  columns: Annotation(), // CSV header
  filterColumns: Annotation(), // columns the user can filter on (excludes e.g. audio)
  proposalMade: Annotation(), // true once proposal has spoken; router then sends the next turn to handleUserDecision
  windowStart: Annotation(), // transcript index of the latest rejection; earlier turns are ignored
  allHospitals: Annotation(), // cached at conversation start, sorted left-to-right
  filtered: Annotation(), // narrowed subset; filter() preserves order so it stays sorted
  intent: Annotation(), // "filter" | "question", set by router
  transcript: Annotation(), // [{role, text}] overwritten each delegation
  messages: MessagesAnnotation.spec.messages,
});

const transcriptText = (transcript) => transcript.map((t) => `${t.role}: ${t.text}`).join("\n");
const windowed = (state) => (state.transcript ?? []).slice(state.windowStart ?? 0);
const rowText = (row, columns) => columns.map((c) => `${c}: ${row[c]}`).join(", ");
const describe = (rows, columns) =>
  Object.entries(uniqueValues(rows, columns))
    .map(([c, values]) => `${c}: ${values.slice(0, 15).join(" | ")}${values.length > 15 ? " | ..." : ""}`)
    .join("\n");

async function loadState() {
  const data = await loadHospitals();
  const { columns, filterColumns, rows } = data ?? { columns: [], filterColumns: [], rows: [] };
  return { columns, filterColumns, allHospitals: rows, filtered: rows, proposalMade: false, windowStart: 0 };
}

function buildGraph({ model, filterModel }) {
  const llm = new ChatOpenAI({ model });
  const filterLlm = new ChatOpenAI({ model: filterModel });

  const speak = (promptName, { listRows = 0 } = {}) => async (state) => {
    const system = await getPrompt(promptName);
    const context = [
      `Conversation:\n${transcriptText(windowed(state))}`,
      `Matching options (${state.filtered.length} rows):\n${describe(state.filtered, state.filterColumns)}`,
      listRows ? `Rows (up to ${listRows}):\n${state.filtered.slice(0, listRows).map((r) => state.filterColumns.map((c) => r[c]).join(" | ")).join("\n")}` : "",
      state.filtered.length === 1 || sameRow(state.columns, state.filtered[0], state.filtered.at(-1))
        ? `The single match: ${rowText(state.filtered[0], state.filterColumns)}`
        : "",
    ].join("\n\n");
    const reply = await llm.invoke([new SystemMessage(system), new HumanMessage(context)]);
    return { messages: [reply], ...(promptName === "proposal_system" && { proposalMade: true }) };
  };

  return new StateGraph(State)
    .addNode("router", async (state) => {
      // Safety net if /api/conversation/start didn't run first.
      const base = state.allHospitals ? {} : await loadState();
      if (state.proposalMade) return base;
      const prompt = await getPrompt("router_system");
      const { intent } = await filterLlm
        .withStructuredOutput(z.object({ intent: z.enum(["filter", "question"]) }))
        .invoke([new SystemMessage(prompt), new HumanMessage(transcriptText(windowed(state)))]);
      return { ...base, intent };
    })
    .addNode("filter", async (state) => {
      // Safety net if /api/conversation/start didn't run first.
      const base = state.allHospitals ? {} : await loadState();
      const columns = state.filterColumns ?? base.filterColumns;
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
          .invoke([new SystemMessage(prompt), new HumanMessage(transcriptText(windowed(state)))]);
        for (const [column, value] of Object.entries(picked)) {
          if (value != null) filtered = filtered.filter((r) => r[column] === value);
        }
      }
      console.log(`Filtered rows: ${filtered.length}`);
      return { ...base, filtered };
    })
    .addNode("handleUserDecision", async (state) => {
      const row = state.filtered[0];
      const recent = transcriptText(state.transcript.slice(-4));
      const { accepted } = await filterLlm
        .withStructuredOutput(z.object({ accepted: z.boolean() }))
        .invoke([
          new SystemMessage(await getPrompt("decision_system")),
          new HumanMessage(`Proposed: ${rowText(row, state.filterColumns)}\n\nRecent conversation:\n${recent}`),
        ]);
      console.log("Decision:", accepted ? "accepted" : "rejected");
      if (accepted) {
        playAudio(row);
        return {
          proposalMade: false,
          messages: [new AIMessage({ content: "", additional_kwargs: { end: true, audio: row.audio ?? null } })],
        };
      }
      const lastUser = state.transcript.findLastIndex((t) => t.role === "user");
      return {
        filtered: state.allHospitals,
        proposalMade: false,
        windowStart: Math.max(lastUser, 0),
        messages: [new AIMessage("Okay, let's try again. What are you looking for?")],
      };
    })
    .addNode("proposal", speak("proposal_system"))
    .addNode("ask", speak("ask_system"))
    .addNode("answer", speak("answer_system", { listRows: 50 }))
    .addEdge(START, "router")
    .addConditionalEdges("router", (state) =>
      state.proposalMade ? "handleUserDecision" : state.intent === "question" ? "answer" : "filter",
    )
    .addEdge("handleUserDecision", END)
    .addEdge("answer", END)
    // Rows are sorted, so "all remaining rows identical" is first === last.
    .addConditionalEdges("filter", (state) =>
      state.filtered.length && sameRow(state.columns, state.filtered[0], state.filtered.at(-1)) ? "proposal" : "ask",
    )
    .addEdge("proposal", END)
    .addEdge("ask", END)
    .compile({ checkpointer });
}

// Stub: the real version will play the clip for the accepted row.
function playAudio(row) {
  console.log(`Would play audio: ${row.audio ?? "(no audio column)"}`);
}

// Load hospitals.csv into this conversation's state (once, at conversation start).
export async function startConversation(sessionId, models) {
  const graph = buildGraph(models);
  const state = await loadState();
  await graph.updateState({ configurable: { thread_id: sessionId } }, state, START);
  return state.allHospitals.length;
}

// Yields spoken text chunks (strings) from proposal/ask/answer as they stream,
// the fixed reply from handleUserDecision, and {end, audio} once a proposal is accepted.
export async function* runDelegation(transcript, { sessionId, model, filterModel, signal }) {
  const t0 = performance.now();
  // Rebuilt per call so settings.json / STUB_MODEL changes apply immediately.
  const graph = buildGraph({ model, filterModel });
  const compileMs = performance.now() - t0;

  const t1 = performance.now();
  let ttft;
  const first = (node) => {
    if (ttft !== undefined) return;
    ttft = performance.now() - t1;
    console.log(`TTFT: ${ttft.toFixed(0)} ms (from graph.stream; ${(compileMs + ttft).toFixed(0)} ms incl. compile) via ${node}`);
  };
  const stream = await graph.stream(
    { transcript },
    { configurable: { thread_id: sessionId }, streamMode: ["messages", "updates"], signal },
  );
  for await (const [mode, data] of stream) {
    if (mode === "messages") {
      const [chunk, meta] = data;
      if (!["proposal", "ask", "answer"].includes(meta.langgraph_node)) continue;
      if (typeof chunk.content === "string" && chunk.content) {
        first(meta.langgraph_node);
        yield chunk.content;
      }
    } else if (data.handleUserDecision) {
      const message = data.handleUserDecision.messages[0];
      first("handleUserDecision");
      if (message.content) yield message.content;
      if (message.additional_kwargs?.end) yield { end: true, audio: message.additional_kwargs.audio };
    }
  }
}
