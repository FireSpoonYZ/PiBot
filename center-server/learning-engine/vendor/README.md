# Adapted Bot learning modules

The sources derive from Nous Research's revision
`71736c9f32597bbca9d89cede5aa136e55946b2f`. See `LICENSE` for the MIT notice.
PiBot adapts the import namespace, prompts and curation behavior to its
managed Skill review workflow. `MANIFEST.json` records upstream Git blob IDs
and local SHA-256 digests. Git preserves the bytes in this directory.

## Learning modules

- `agent/background_review.py` — `spawn_background_review_thread` target +
  `prepare_background_review_run` / `finish_background_review_run` run token,
  `build_cache_parity_fork`, `_review_tool_whitelist`, `_review_input_token_budget`,
  `summarize_background_review_actions`, and the review prompts.
- `agent/learn_prompt.py` — `build_learn_prompt` (the complete /learn prompt builder).
- `agent/curator.py` — `run_curator_review`, `maybe_run_curator`,
  `apply_automatic_transitions`, draft proposals and report generation.
- `agent/curator_backup.py` — vendored for provenance; shadowed at runtime by the facade adapter `python/facade/agent/curator_backup.py`, which forwards snapshot ops to the center skill service (local-dir snapshots would only back up an empty/nonexistent tree).
- `agent/skill_utils.py` — `get_disabled_skill_names`, `is_excluded_skill_path` and friends.
- `agent/interrupt_compat.py`, `agent/safe_worker_policy.py`,
  `agent/thread_scoped_output.py`, `agent/jiter_preload.py` — stdlib helpers.
- `tools/skill_ledger.py` (ledger actor contextvar + `TRANSIENT_DIRS`),
  `tools/skill_manager_guards.py` (`_reset_background_review_read_marks`),
  `tools/skill_provenance.py` (write-origin ContextVar).
- `learning_constants.py` (`get_learning_home` -> `LEARNING_HOME` env = job stateDir,
  `resolve_reasoning_config`, `parse_reasoning_effort`), `utils.py`
  (`atomic_json_write`, `is_truthy_value`), `learning_cli/sizefmt.py`.

## Bridge adapters under ../python/facade

- `run_agent.AIAgent` — facade; `run_conversation` forwards one bounded
  `agent.run` callback to the Host (no provider credentials or model I/O here).
- `model_tools.get_tool_definitions` — returns the job-provided tool schemas
  (`config.tools` / `snapshot.tools`) filtered by toolset name.
- `tools.skill_usage` — forwards curator storage calls as `skill.call`
  `{name: "skill_usage.<fn>", args}` to the center skill service. Never touches a
  local skill tree.
- `tools.skill_lock.is_locked_skill` — set-membership check on the names the
  center returned (no filesystem fallback; locked protection is enforced center-side).
- `agent.i18n.t` — English catalog subset for the `display.review.*` keys the
  vendored modules reference.
- `agent.prompt_cache_scope.resolve_prompt_cache_scope_safe` — `None` (no
  session DB / cache-scope concept in this runtime).
- `agent.curator_backup` — snapshots of managed skill content and metadata are
  stored in the center database; the two latest are retained. Snapshot restore
  is not exposed by this facade; individual content revisions remain available
  through the managed skill history and rollback API.
- `learning_cli.config` — `load_config_readonly` returns the bound job config.
- `learning_cli.runtime_provider.resolve_runtime_provider` — resolves only
  credential-free (provider, model) requests; explicit api_key/base_url raises.
- `learning_cli.plugins` — thread-local review tool whitelist consumed by the facade.
- `learning_cli.observability.shared_metrics_loop.record_curator_run` — relays the
  run metric as a protocol `log` line (no metrics backend here).
- `gateway.session_finite.finite_turn_required` -> `None`,
  `gateway.session_context.get_session_env` -> env lookup.
- `learning_yaml.safe_load` — bounded callback to the existing Node YAML parser.
- `learning_dir_acl.make_user_dir` — creates private per-Bot state directories;
  host-specific elevated ACL integration is not used.
- `tools.terminal_tool` — thread-local approval callback only; no shell.

## Schedule and runtime boundaries

- `cron.jobs.referenced_skill_names` reads the target Bot’s schedule references.
  Schedule rewrites require a separate user action.
- `tools.skill_manager_tool` / `tools.skill_usage` filesystem implementation:
  skill writes go through the center skill service callbacks, not a local
  filesystem tree.
- Auxiliary routing to a provider that needs credentials resolved here
  (explicit api_key/base_url): raises; vendored code falls back to the main model.
