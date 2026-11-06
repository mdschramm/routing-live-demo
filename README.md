## GPT-live agent demo

# Todo:
- [x] Create a passthrough client delegation system: https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client#configure-client-delegation with a simple langgraph backend
- [x] Create endpoint to upsert hospitals.csv that can be used from the browser with a file upload button. There should be a panel below the file upload button showing a scrollable preview of hospitals.csv if it exists. If it does not show nothing
- [x] trigger load of hosptials.csv into backend context during conversation start
- [x] Add filtering logic
- [x] Add a router node: filter requests go to the filter node; general questions about what is available go to an answer node that uses the filtered hospitals in state
- [x] Add `scripts/add-audio.mjs` (adds an `audio` column and generates TTS clips) and a proposal/decision loop (`proposalMade`, `handleUserDecision`)
- [x] Live state panels in the page: remaining distinct hospitals (scrollable), active filters, `proposalMade`

## Graph flow
`router` -> `filter` -> (`proposal` if all remaining rows are identical, else `ask`); `router` -> `answer` for general questions. After `proposal` sets `proposalMade`, the next turn goes `router` -> `handleUserDecision`: accept sends the clip path to the browser, which plays it separately from the voice agent and ends the call; reject resets `filtered` to all hospitals and ignores earlier transcript turns (`windowStart`). Only `proposal`, `ask`, `answer` and `handleUserDecision` stream text back to the voice agent.

## Known limitations
- Filtering is narrow-only: within a conversation a filter cannot be undone or relaxed.
- Values the user names that are not in the currently filtered set are silently ignored (no "that option isn't available" response).
- hospitals.csv is cached in graph state at conversation start; later uploads apply to new conversations only.
- The router can misclassify follow-up questions (e.g. "Which hospitals can do that?" was routed as a filter); it still gets a reasonable reply but the router prompt may need examples.
- Audio: `node scripts/add-audio.mjs [csv] [--dry-run] [--limit N]` writes clips to `data/audio/` (gitignored) and the `audio` column; the column is excluded from filtering via `hospitals.nonFilterableColumns` in `settings.json`. Clips are served at `/audio/`.
- `handleUserDecision` is binary: any non-acceptance (including a question about the proposal) is treated as a rejection.
- `windowStart` indexes the full transcript, so keep `delegation.transcriptTurns` null.
- State panels show *distinct* remaining rows (the count is distinct too); snapshots are capped at 500 rows and arrive as `event: state` frames on the delegate stream.
