# Built-in Vault

Vault belongs to one Host, not a plugin version, Bot working directory or Center account. The built-in `e-launcher.vault` plugin is packaged enabled by default; per-Bot capability policy still applies. Disabling it revokes tool access without deleting Vault data.

## Setup and use

In chat, the Bot can call `vault_unlock({})` to open a private password card for the selected Host. On first use the card asks you to set and confirm a master password and initialize Vault; otherwise it asks for the existing master password. Confirmation is local to the UI. Enter the password only in this masked card, never as a chat message. The model gets only `{status:'unlocked'}` or `{status:'cancelled'}`. A wrong password stays a private card error and leaves the request open for another attempt. An already-unlocked Vault returns immediately without extending its idle timeout.

The dedicated client Vault panel remains available for initialization/unlock, entries, grants, locking and master-password changes. Save a label, optional username, password and explicit `allowedBotIds`. Only locally existing Bots can be granted access. Editing an existing item without a password preserves its password. Empty ACLs grant no Bot access; unlocking the Host does not grant item access.

After unlocking, ask the Bot to find the entry with `vault_find({query})`, then use `vault_fill({secretRef,target:{x,y,windowId?}})`. The Host derives Bot/scope/session identity from the actual conversation. Find returns only metadata; fill types only the saved password and returns only session/status. Username metadata can be used separately.

`vault_unlock` is model-only (`callers:['model']`) and cannot be called from a codemode script. With `codemodeOnly` enabled, currently eligible model-only interaction tools remain directly available alongside codemode; other tools still follow their capability selection and deferred rules. `vault_find` and `vault_fill` remain script-callable so the model can resume its codemode workflow after the card completes. All three Vault tools use unsafe replay: an interrupted unlock is not automatically replayed after a Host restart.

Open the intended Shower session first. Before `vault_fill`, use ordinary Shower/CUA to focus the intended input control, then reobserve its current full-source-screen coordinates: focus, keyboard or layout changes can move it. Coordinates are **full Shower source-screen physical pixels**, not window-relative CUA screenshot coordinates. Android does not accept `windowId`. On Windows, an explicit `windowId` must belong to a non-minimized window: restore and reobserve a minimized window before filling. Secret input does not restore or resize the window and checks its foreground root before input. Fill uses private queued secret input, never `api.callTool` or ordinary CUA input. It does not press Enter, submit login, or capture a screenshot. Interrupted input is **unconfirmed**, and must not be retried automatically.

Never paste master passwords or saved passwords into chat, tools, drafts, pending messages, memos, logs, shell arguments/environment or clipboard. Enter them only in dedicated Vault fields. Labels and usernames are safe metadata visible to authorized Bots; do not use them to store passwords.

## Storage and lifetime

The small whole-file store is `<dataRoot>/vault/vault.json`. Metadata and ACLs are encrypted alongside passwords using AES-256-GCM. Version, fixed KDF settings, salt and revision form authenticated header data. Each write uses a fresh random nonce; initialization and password change use fresh random salt. Key derivation uses asynchronous scrypt (`N=32768,r=8,p=3,maxmem=64MiB`). There is no adjacent plaintext key.

Writes are serialized, encrypted to a private temporary file, flushed, then atomically renamed. Save/delete require `expectedRevision`; refresh after a conflict. A wrong password or malformed/corrupt file is never replaced by initialization. Back up the encrypted file separately if needed; there is no password recovery or automatic backup. Keep the entire Host data directory private (including equivalent Windows account ACLs).

The master password is not cached. Only the unlocked key is retained; lock, timeout and runtime close zero that buffer. JavaScript strings and crypto internals cannot guarantee forensic memory erasure. Decrypted strings exist transiently inside trusted Host operations. The default idle-use timeout is 15 minutes with a real timer. Metadata find/status/list calls do not renew it; secret resolution and management unlock/writes do. Lock epochs prevent late unlocks or previously queued fills from restoring/using access. A queued fill also rejects if the store revision changed; capability and conversation ownership are checked again immediately before input.

Chat unlock requests exist only in Host memory and are bound to the invoking capability, Bot, conversation and tool execution. Safe presentation metadata (installation/conversation/request IDs, initialize/unlock mode and pending/unlocked/cancelled/interrupted status) may enter LIVE and history; passwords never enter plugin code, durable documents, memos, model output or history. The card replies through authenticated `vaultControl`, not a plugin action, chat submit or offline queue. Capability/ownership checks and a final synchronous request guard protect asynchronous key installation. Duplicate in-flight submissions are rejected; the first valid completion wins. Cancel, task stop, capability quiesce, explicit lock and Host close expire the request. Reconnecting clients may display a still-live request with an empty input, but historical cards are read-only. A past successful card does not describe the Vault's current lock state. Restart drops pending requests and keys, so old replies cannot unlock it.

Initialization still uses the existing atomic encrypted-file write. If interrupted while the rename is already in flight, the encrypted Vault may have been created, but the cancelled request cannot install its key; a new card uses the unlock flow.

## API

Existing authenticated control RPC: `vaultControl(params, options?)`, with **flat** params (no `{input: ...}` wrapper). Runtime: `runtime.vaultControl(input)`. HTTP: `POST /v1/vault`, JSON body equal to params, no query string. Existing Bearer/Origin rules apply; responses are no-store. Local/remote/Android control use the same additive v2 method. No secret request enters the durable pending-message/outbox path; transport failures are not retried.

| action | Extra input | Result |
| --- | --- | --- |
| status / lock | none | VaultStatus |
| initialize / unlock | masterPassword | VaultStatus |
| list | none | {revision,items} |
| save | expectedRevision,item | {revision,item} |
| delete | expectedRevision,secretRef | {revision} |
| changePassword | masterPassword,newMasterPassword | VaultStatus |
| respondUnlock | requestId,masterPassword (cancelled omitted or false) **or** requestId,cancelled:true (no password field) | {requestId,status:'unlocked'\|'cancelled'} |

`VaultStatus={initialized,locked,revision,expiresAt}`; expiresAt is an ISO string or null. `VaultItemMeta={secretRef,label,username,allowedBotIds,createdAt,updatedAt}`. No password, digest, length or preview is returned. `item={secretRef?,label,username?,password?,allowedBotIds}`; new items require a password. List/save/delete/changePassword require unlock. Management remains available through local control while Center is offline; during runtime maintenance only status/lock are allowed. Desktop broker bypasses Center readiness only for an already-connected local Vault call, never a relay call or automatic reconnect.

Bounds: 1,000 items, label 200 characters, username 320, password 1–1,000, master password 1–1,024, up to 256 allowed Bots per item, at most 50 find matches. The encrypted file is capped at 8 MiB. References are opaque random UUIDs; existing references stay stable on edits. Revision is visible in the encrypted header (not secret).

Fixed short errors include `VAULT_LOCKED` (call `vault_unlock` or use the client panel), `VAULT_UNLOCK_FAILED` (wrong password/corruption), `VAULT_REQUEST_EXPIRED` (request a new card), `VAULT_REQUEST_BUSY` (a reply is already in flight), `VAULT_NOT_INITIALIZED`, `VAULT_ALREADY_INITIALIZED`, `VAULT_CONFLICT`, `VAULT_NOT_FOUND`, `VAULT_FORBIDDEN`, `VAULT_INVALID_ARGUMENT`, `VAULT_SESSION_REQUIRED`, `VAULT_INPUT_UNSUPPORTED`, `VAULT_INPUT_UNCONFIRMED`, `VAULT_UNAVAILABLE` and `RUNTIME_BUSY`. Underlying exception messages and secret request parameters are not reflected.

## Trust boundary and limits

Clients, the authenticated control transport, Host, installed native plugins and any relaying Center are trusted. Vault never passes the master password to its plugin facade or a plugin action. Remote management and chat unlock send the password over the existing authenticated control connection; this is **not new end-to-end encryption against Center**. Use secure remote transport and do not add body logging.

Encryption protects the file at rest; it is not a strong OS sandbox, protection from same-user processes/X11, or protection from a compromised Host. The destination application necessarily receives the filled password and may retain it. No show-password defense, screenshot lockdown, global egress scanner, login-submit automation or clipboard fallback is provided. Platform input implementation and actual field targeting require parent-owned end-to-end/device acceptance; static source development alone establishes neither.
