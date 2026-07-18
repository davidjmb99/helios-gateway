# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-07-18

### Added
- **Conversation Lock:** Implemented an `activeProcessing` Set in the orchestrator to prevent parallel execution of flushes for the same conversation. This mitigates the risk of sending duplicate responses or corrupting conversation state if a user sends another message while Hermes is still processing the previous one.
- **Auto-Cleanup for Memory Leaks:** Added a cleanup routine for `lastProcessedFlushes` Map, which removes entries older than 60 seconds at the start of each flush to prevent indefinite memory accumulation.
- **Chatwoot Retry Mechanism:** Added a 2-attempt retry logic to `sendMessage` in `ChatwootClient` with a 1s delay, to handle rate limits and transient network errors gracefully.
- **New Logging Event:** Added `CHATWOOT_REPLY_FAILED` event in Supabase logs to record when a message fails to be delivered after retries, including the un-delivered text and error message.

### Changed
- **Parallel Database Queries:** Optimized pre-Hermes context gathering. Supabase queries for conversation state, patient profile, and active financing now run concurrently via `Promise.all()`, reducing baseline latency by ~400ms.
- **Prioritized Chatwoot Sending:** Reordered orchestrator execution logic. The response from Hermes is now sent to Chatwoot *immediately*, before executing the database post-processing operations (updating profile, state, executing tools, saving logs). This removes ~1-2s of blocking latency for the end user.
- **Error Propagation:** `ChatwootClient.sendMessage` now throws an error instead of silently catching it when the final retry fails, allowing the orchestrator to log the failure explicitly.
