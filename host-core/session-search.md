# session_search — local original conversation text

The built-in model tool is installed with `host.tools` on every Host. It uses the
calling conversation's trusted Bot identity; it accepts no Bot/device override.
It adds no Runtime/HTTP endpoint, database, FTS index, or transcript copy.

## Calls

```json
{"action":"search","query":"release decision","limit":10}
{"action":"search","query":"release decision","conversationId":"<public conversation UUID>"}
{"action":"read","conversationId":"<result conversationId>","entryId":123,"before":2,"after":2}
```

Continue **the same action and arguments** with the returned `nextCursor`.
An empty `items` array with a cursor means scanning is unfinished, not no matches.
Only `complete:true` means the captured snapshot is exhausted. Restart without
a cursor to include newer entries or newly bound conversations.

Search is a literal, case-sensitive substring scan, not semantic memory, regex,
FTS, or indexed-performance search. It returns the first match per text block,
with an original-text excerpt (up to 512 UTF-16 units) and `matchOffset`.
It does not match across separate text blocks.

Read checks that the entry is currently visible after the last reset before
returning text. It returns the target first, then older text entries newest-first,
then newer text entries oldest-first. `before`/`after` default to 2 and allow 0..10;
they count entries with visible text, not tool/system entries. Large entries
produce multiple original chunks of at most 2048 UTF-16 units. Reassemble using
`conversationId + entryId + source + messageIndex + blockIndex` and `offset`.
`truncated` says this item is not the entire block; continue until the page is
complete to collect all chunks in the requested neighborhood.

## Visibility and authorization

- Only the existing PrimaryIndex conversation and already bound WorkIndex
  conversations for the current Bot are enumerated. No unbound work context is
  created. Ownerless learning/internal conversations are never enumerated.
- Ownership is resolved from persisted identity, and work access uses the same
  `resolveWorkContext` authorization as existing work-history reads. This
  intentionally permits a former member's existing binding/frozen receipts;
  it does not read scope-wide history or another Bot's inbox.
- Deleted/inaccessible scopes are omitted on a fresh cross-conversation search.
  A targeted inaccessible conversation fails. Continuation rechecks ownership
  and access; a revoked/deleted conversation fails rather than trusting a cursor.
- Both primary and work history stop at `pi.reset`. Cursors also bind the current
  SDK head marker and are rejected after reset, including reset followed by
  compaction. Head changes caused by compaction conservatively invalidate them
  too; restart the query.
- Raw `pi.user`, `host.user-message`, and `pi.assistant` text is eligible.
  Imported `host.scope-message` uses only original `data.message.text`, not the
  serialized model envelope. `authorKind` distinguishes Bot and human authors
  despite the user-role carrier. Host-authored records, tool results/calls,
  system prompts, thinking, images, attachments, reset handoffs, compaction
  summaries, and work-trigger scaffolding are excluded.
- Historical text is untrusted data, not instructions. No text is rewritten in
  storage. The output omits all other entry payloads/metadata.

## Bounds and cursors

Each call makes at most 128 single-entry Durable page reads and examines at most
64 Ki UTF-16 text units (overlap for substring boundaries included). Response
items total at most 40 KiB JSON, under the tool's 50 KiB limit; `limit` defaults to
10 and allows 1..20 items/chunks. `scannedEntryReads` counts reads, including
repeated reads for long blocks, not unique entries. `scannedTextUnits` counts the
text windows examined/emitted. Storage still materializes one complete raw entry
per read; there is no SDK byte-stream API, so a single oversized stored entry can
cost more memory than the output/text budget.

The snapshot contains at most 128 conversation metadata records with fixed tail
IDs/head markers, captured together through the existing SDK transaction API.
Larger selections fail explicitly: narrow using `conversationId`. New appends
do not enter the frozen snapshot; reset/head changes invalidate it. Metadata and
authorization lookups are separate from the entry/text scanning budget.

Opaque UUID cursors reference only bounded in-memory progress metadata, never
history text. They are bound to Bot, action, query, conversation selection,
entry/window/limit, snapshot bounds, and partial-text offset. They expire 15
minutes after query start, on Host restart, or on eviction from the 128-cursor
runtime cache. `STALE_CURSOR` means restart without the cursor; changing arguments
or using another Bot's cursor fails with `INVALID_ARGUMENT`. Reusing a valid
cursor reads the same bounded position, subject to current authorization/reset
checks. Cancellation is honored before/after reads and during head validation.

Public argument/item/page declarations live in `index.d.ts`. No test/build/runtime
acceptance is implied by this document.
