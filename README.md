## GPT-live agent demo

# Todo:
- [x] Create a passthrough client delegation system: https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client#configure-client-delegation with a simple langgraph backend
- [x] Create endpoint to upsert hospitals.csv that can be used from the browser with a file upload button. There should be a panel below the file upload button showing a scrollable preview of hospitals.csv if it exists. If it does not show nothing
- [x] trigger load of hosptials.csv into backend context during conversation start
- [x] Add filtering logic

## Known limitations
- Filtering is narrow-only: within a conversation a filter cannot be undone or relaxed.
- Values the user names that are not in the currently filtered set are silently ignored (no "that option isn't available" response).
- hospitals.csv is cached in graph state at conversation start; later uploads apply to new conversations only.
