# Configuration

The extension follows the documented Claude Code configuration model where Pi supports it.

It reads `autoMode` only from Pi-owned configuration sources:

- the global config file
- the project-local config file for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`

Which files these are depends on the host:

| | Pi | OMP |
|---|---|---|
| Global config | `~/.pi/agent/extensions/pi-automode/config.json` | `<agentDir>/automode/config.json` |
| Project-local config | `.pi/automode.local.json` | `.omp/automode.local.json` |
| Shared project config | `.pi/automode.json` | `.omp/automode.json` |
| Logs for in-memory sessions | `~/.pi/agent/extensions/pi-automode/logs/` | `<agentDir>/automode/logs/` |

Pi-automode detects OMP through the `getAgentDir()` function that OMP exposes to extensions. `<agentDir>` is the directory OMP reports, normally `~/.omp/agent`. It follows OMP profiles and `PI_CONFIG_DIR`. Under any other host, pi-automode uses the Pi paths. See [ADR-003](adr/ADR-003-omp-config-directory.md).

At startup, pi-automode selects one active global config path for the session. Under Pi, it moves a legacy `~/.pi/agent/automode.json` file to the Pi path. Under OMP, it moves a Pi config (`~/.pi/agent/extensions/pi-automode/config.json`, or the older `~/.pi/agent/automode.json`) to `<agentDir>/automode/config.json`. This is a one-way move: Pi no longer finds the file afterwards. If both files exist, pi-automode uses the new file and reports the conflict. If migration fails, it uses the legacy file for that session and reports the error.

Under OMP, project files come from `.omp/`. If `.omp/` lacks a file but `.pi/` has it, pi-automode reads the `.pi/` file and `/automode config` reports the legacy location. If both exist, it reads the `.omp/` file and reports the ignored `.pi/` file. Pi-automode never moves project files. `/automode config` shows the selected files under `configSources`.

It does not read project configuration until the host trusts the project. For an untrusted project, it ignores the project config files in both `.omp/` and `.pi/`. `/automode config` reports each ignored file that exists.

Shared project `automode.json` (`.pi/automode.json` under Pi, `.omp/automode.json` under OMP) cannot weaken auto mode. For a trusted project, it can add `permissions.deny` and `permissions.ask` rules.

The shared file cannot set `autoMode` or add `permissions.allow` rules. If the file contains `permissions.allow`, `/automode config` reports a diagnostic.

To disable pi-automode for the current project, create or edit `.pi/automode.local.json` (`.omp/automode.local.json` under OMP):

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This file is project-local. The host must trust the project before pi-automode reads it. Do not commit this file. Shared project `automode.json` cannot disable auto mode.

Set a global default classifier model in the global config file. For a trusted project, override it in the project-local config file.

### Classifier model selectors

`classifierModel` accepts three forms:

- `provider/model-id` selects one model from the Pi/OMP registry.
- `typesafe/jev-*` selects the native [TypeSafe Jev](#typesafe-jev) backend.
- `@role` (OMP only) selects an OMP model role such as `@smol` or `@judge`.

A role selector expands to the role's complete OMP chain: the model assigned to the role in OMP settings, then its configured or built-in fallbacks, which can sit on other providers. The classifier uses the first model in the chain that has working credentials. The `@judge` chain also holds native judgment and on-device models. They cannot run the classifier's decision tool, so the classifier skips them.

Under OMP, an unset `classifierModel` means `@smol`. If that role resolves to no available model, the current session model is used. Pi has no model roles, so an unset value still means the session model, and a role selector fails closed with a reason that names the missing OMP support.

If a role or model cannot be resolved, the action is blocked. An explicit selector never falls back to the session model. `/automode status`, `/automode config`, and `automode_inspect` show the selector and the concrete model it resolves to, for example `@smol → anthropic/claude-haiku-5-5 +16 fallbacks`.

### Provider failures and fallback

Each classifier failure gets a type: `rate-limit` (HTTP 429 or a rate or quota message), `timeout`, `server` (5xx, overload, dropped connections, and unrecognized provider errors), `auth` (401, 402, 403, rejected credentials), `invalid-response` (an invalid decision, a truncated or non-`0`/`1` answer, a request the provider rejects), `context-limit` (an action too large for the model), `no-classifier` (no usable model or credential), and `aborted` (the session cancelled the action). The decision log and `automode_inspect` record these as `errorKind` and `kind`.

- A `timeout` or `server` failure is retried once on the same model after a pause of 250 to 750 ms.
- Any other failure, or a failed retry, moves to the next model in the role chain. The walk prefers a provider that has not failed yet, tries at most four models, and starts no new attempt once three `classifierTimeoutMs` have passed.
- A `rate-limit` puts that provider on cooldown for the `retry-after` the provider gave (capped at 10 minutes, 60 seconds when it gave none). Until then, every model of that provider is skipped without a request, in every session of the process. `/automode reload` clears the cooldowns.
- Two consecutive timeouts of the same model (an attempt and its retry count as two) skip that model for 60 seconds, so one slow model does not cost a full timeout and its retry on every action. Other models of the provider are unaffected, and any decision from the model resets the count.
- When no model can decide, the action is blocked with kind `classifier-unavailable` and a reason such as `classifier unavailable (rate limited, retry in 53m)`. The model sees that this is not a policy denial. These blocks do not count as classifier denials in the status counters.

A single `provider/model-id` has no fallback, but it gets the same retry, cooldown, and typed block. Jev has no retry or fallback; its failures are typed and block as `classifier-unavailable`. The decision log's `classifier` entries record, for each attempt, the serving model, `errorKind`, and `retryAfterMs`.

For Pi/OMP chat models, `classifierReasoningLevel` requests `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both classifier stages. If the key is absent, pi-automode sends no reasoning preference. The server then selects the level.

Pi AI clamps an unsupported value to the nearest level that the selected model supports. A model without reasoning support resolves to `off`. `low` matches the reasoning effort of Codex Auto Review.

Higher levels can use all 512 or 1200 stage tokens before they produce visible output. In this case, the classifier fails closed. If truncation occurs before the required `0` or `1` digit, increase `fastClassifierMaxTokens`. The default is 512, and the minimum is 16.

`classifierTimeoutMs` limits each classifier request in milliseconds. The default is 20000, and the minimum is 1000. The fast and detailed stages have separate budgets.

If a request stalls or exceeds its budget, pi-automode aborts it. Then auto mode fails closed and blocks the action.

`allowInsideWorkingDirectory` adds a deterministic allow tier for the file tools. The default value is `false`. The file tools are `read`, `write`, `edit`, `grep`, `find`, and `ls`.

The value `allowInsideWorkingDirectory: true` allows access to paths inside the working directory without classifier review. Pi-automode sends access to outside paths to the classifier. This rule also applies to read calls.

This tier takes precedence over `classifyReadOnlyTools`. If both configuration fields are enabled, pi-automode still allows in-tree file access locally. `classifyReadOnlyTools: true` does not change this behavior.

Protected in-tree targets do not use this allow tier. Writes and edits to `.git/hooks`, `.pi` controls, shell profiles, and configuration files still reach the classifier.

`deniedPaths` is a list of path glob patterns. The default list is `[]`. A matching pattern blocks a file-tool call before classifier review or an allow tier.

Patterns support `~`, `$HOME`, and `${HOME}` expansion. The `*` wildcard matches all characters, including `/`. Thus, `**/id_rsa` matches a private key at any depth.

Each pattern can contain at most 4,096 UTF-16 code units. Pi-automode matches the typed path and its symlink-resolved form. It also resolves the fixed path prefix of each pattern. Thus, a symlink alias cannot bypass a denied target.

If a recursive `grep` or `find` scope can contain a denied path, pi-automode blocks the call. A broad pattern such as `*.env` blocks these tools for every directory scope.

A matching path blocks the call without classifier review or an override. The list applies only to file tools. The classifier governs `bash` path access. Both keys use the normal scalar and array precedence.

`allowInsideWorkingDirectory` uses scalar precedence: global, then project-local, then `PI_AUTOMODE_SETTINGS_JSON`. `deniedPaths` entries accumulate across these configuration sources.

Shared project `.pi/automode.json` cannot set either field. Omitting either field at a higher-precedence source does not clear a lower-source value.

`headlessAsk` sets what a `permissions.ask` match does in a session that has no UI, such as an OMP subagent or `/tan` clone. A session with its own UI always asks its own user. The default is `parent`. The setting uses scalar precedence like `allowInsideWorkingDirectory`, and shared project `.pi/automode.json` cannot set it.

- `parent` asks the nearest ancestor session in the same process that has a UI. The dialog title names the asking agent. A decline, an abort, no answer within 25 seconds, or an ancestor that cannot be found blocks the call. An accepted dialog works as it does in a session with its own UI: the call continues through the deterministic checks to the classifier.
- `classifier` does not ask. The call skips every allow tier and reaches the classifier, which receives a note that the rule matched in a session without UI. If the classifier allows the call, it runs without any user approval, so this is the weakest setting. Use it only when you accept the classifier as the sole reviewer of calls your ask rules mark as sensitive.
- `block` blocks the call.

The lookup for `parent` uses the session header of the asking session, which names its parent by session file or session id. It finds only sessions of the same process, and a parent that has shut down is gone. OMP lets an extension's `tool_call` handler work for 30 seconds (`extensionHandlers.toolCallTimeoutMs`) and does not pause that clock for a dialog in another session's UI. For that reason a forwarded dialog closes after 25 seconds and the asking call is blocked. Subagents that ask at the same time queue in the parent's UI, and each one's 25 seconds start when it asks, not when its dialog appears.

Example:

```json
{
  "autoMode": {
    "classifierModel": "provider/model-id",
    "classifierReasoningLevel": "low",
    "classifyReadOnlyTools": false,
    "fastClassifierMaxTokens": 512,
    "classifierTimeoutMs": 20000,
    "allowInsideWorkingDirectory": false,
    "headlessAsk": "parent",
    "deniedPaths": [],
    "maxUserTranscriptTokens": 4000,
    "maxToolTranscriptTokens": 4000,
    "maxUserTranscriptMessages": 30,
    "maxToolTranscriptCalls": 40,
    "includeToolResults": true,
    "maxToolResultTranscriptTokens": 2000,
    "maxToolResultTranscriptEntries": 10,
    "environment": [
      "$defaults",
      "Source control: github.example.com/acme-corp and all repos under it",
      "Trusted internal domains: *.corp.example.com, git.example.com",
      "Trusted cloud buckets: s3://acme-dev-artifacts, gs://acme-ci-cache",
      "Key internal services: staging deploy API at deploy.corp.example.com"
    ],
    "allow": ["$defaults"],
    "protectedPaths": ["$defaults"],
    "soft_deny": ["$defaults"],
    "hard_deny": [
      "$defaults",
      "Never send repository contents to third-party code-review APIs"
    ]
  },
  "permissions": {
    "deny": ["bash(rm -rf *)"],
    "ask": ["bash(git push *)"],
    "allow": ["bash(git status*)", "example-extension-tool"]
  }
}
```

`maxUserTranscriptTokens`, `maxToolTranscriptTokens`, and `maxToolResultTranscriptTokens` are approximate token budgets for user, tool-call, and tool-result evidence. They default to 4000, 4000, and 2000, and accept integers of at least 32.

`maxUserTranscriptMessages`, `maxToolTranscriptCalls`, and `maxToolResultTranscriptEntries` limit how many of the newest messages, tool calls, and tool results the classifier sees. They default to 30, 40, and 10, and accept integers of at least 1. Per-entry caps apply on top: an entry that exceeds its cap keeps its start and end.

The first user message (the brief), up to eight recent verified `ask` answers, and the latest message are pinned: the count and token budgets never drop them.

`includeToolResults` (default `true`) sends bounded, untrusted excerpts of recent tool results to the classifier. See [What is sent to the classifier](automode-classifier-flow.md#tool-result-excerpts). Set it to `false` when tool output must not reach the classifier provider. Results of `read`, `grep`, `find`, and `ls` are never sent. Shared project configuration cannot set any of these keys.

Pi-automode does not support the former `maxTranscriptLines` field. Evidence selection now uses token and message-count budgets instead of line counts.

## Ask-user tools and explicit authorization

Classifier evidence includes normal user messages, verified answers from OMP's built-in `ask` tool, assistant tool-call inputs, and bounded excerpts of recent tool results. Tool results are untrusted and never count as authorization, including output from same-named or extension-provided ask tools such as `@vanillagreen/pi-questions`.

An OMP `ask` answer counts only when the tool reports itself as `<builtin:ask>` from the `builtin` source. Pi-automode records the question with the selected options, custom answer, and note from the result's structured details. It ignores timeout auto-selections, chat redirects, cancellations, errors, and nested tool calls. The classifier sees the answer as `Answered ask question "<question>": <answer>` at the result's position in the transcript, so a later user message can narrow or revoke it.

The answer must still meet the policy: soft-denied existing-file changes need a question and answer that name the task, one repository or worktree, path scopes, and whether modification, deletion, or both are allowed. Hard denies stay unconditional. The answer stops counting when its result leaves the active context, for example after compaction or on another branch.

Captured answers apply to built-in ask calls made while this version is installed. Earlier sessions do not contain the capture record. Send authorization as a normal chat message when no verified ask answer applies.

## `$defaults`

See [Defaults and rule-list behavior](defaults.md) for built-in `environment`, `allow`, `protectedPaths`, `soft_deny`, and `hard_deny` entries. The document also explains replacement behavior after omission of `$defaults`.

## Observability logging

Auto mode can write a JSONL observability log for decisions and classifier usage. Persisted sessions use a sidecar next to the Pi session file. In-memory sessions use a global application directory. Logging is off by default.

```json
{
  "autoMode": {
    "log": {
      "enabled": true,
      "classifierIo": false
    }
  }
}
```

With logging enabled, persisted-session sidecars also contain ccusage-compatible entries for every classifier response. When `classifierIo` is off, `ccusage pi` still reports a separate `-pi-automode` session. In-memory logs use the same entry shape but live outside the normal Pi session tree.

See [Observability logging](observability-logging.md) for the log file location, entry schema, and the `classifierIo` privacy tradeoff. Run `/automode config` to see the resolved log file path.

## Permission patterns

Permission patterns use Pi tool names. Examples include `bash(...)`, `write(...)`, `edit(...)`, and `read(...)`. The parser accepts capitalized names such as `Bash(...)`. The documented form is lowercase because Pi tool names are lowercase.

`permissions.allow` is a deterministic allow tier. The default list is `[]`. A matching rule skips classifier review.

Use this tier for a narrow command such as `bash(git status*)`. You can also use it for a side-effect-free extension or MCP tool.

The matcher understands primary arguments for `bash`, the file tools, and `grep`. For file tools, it uses the resolved `input.path`. For `grep`, it uses `input.pattern`.

For `bash`, pi-automode parses `input.command` with `unbash`. Deny and ask rules inspect each executable command in the Bash syntax tree. This includes pipelines, logical chains, compound commands, substitutions, and literal scripts passed to `bash -c`, `sh -c`, or `eval`. The analysis also follows these literal shell scripts through transparent `command`, `exec`, and `env` dispatch.

The matcher normalizes whitespace between Bash tokens. It preserves whitespace and quoting inside each token. Thus, `bash(git push*)` matches `git  push origin main`. Quoted operators do not create extra commands.

A Bash allow decision requires coverage for each executable command. A multi-command pattern must match the same AST structure and operators. This structure check also applies to one command inside a group, wrapper, control structure, or background statement. Separate single-command patterns only cover top-level foreground chains and plain pipelines. Other supported structure requires one matching structural pattern. A multi-command pattern must match the same number of commands in the same order. Each pattern command must match its corresponding input command. One wildcard cannot hide an additional command or a different operator.

A redirect requires explicit coverage in the allow pattern. The redirect operator, file descriptor, variable name, and target pattern must match. Here-documents and dynamic redirect targets continue to the classifier. Parser errors, dynamic command names, and dynamic wrapper scripts cannot use `permissions.allow`.

Control nodes with unrepresented semantic values cannot use `permissions.allow`. This includes loops, functions, coprocesses, case statements, test commands, and arithmetic commands. These scripts continue to the classifier.

Pi-automode does not execute shell expansions. It cannot resolve aliases, variables, generated scripts, or dynamic `eval` input. These calls continue to the classifier unless a deterministic rule blocks them.

For other tools, the matcher uses the serialized input object. Use a bare tool name for an MCP or extension tool. For example, `example-extension-tool` matches every call to that tool.

The providing extension or MCP server defines the Pi tool name. Pi-automode does not need a predefined list.

A match skips only the classifier call. It cannot skip `permissions.deny`, deterministic hard-deny checks, `deniedPaths`, or protected-path controls. An accepted `permissions.ask` rule also takes precedence. After confirmation, the call continues through deterministic checks and then reaches the classifier. It cannot use `permissions.allow`, the inside-working-directory tier, or the read-only fast path.

Pi-automode reads `permissions.allow` only from global configuration, trusted `.pi/automode.local.json`, and `PI_AUTOMODE_SETTINGS_JSON`. Shared `.pi/automode.json` cannot add allow rules.

A pattern can contain at most 4,096 UTF-16 code units. Bash analysis accepts at most 1,048,576 UTF-16 code units. A longer Bash input is blocked before parsing.

For other allow matching, an input can contain at most 1,048,576 UTF-16 code units. A longer input returns no match. Deny and ask patterns match the same oversized input so that they fail closed.

`write` and `edit` calls whose resolved target is a protected path are never covered by `permissions.allow`. This includes protected targets reached through symlink aliases.

See [Permission recipes](permission-recipes.md) for narrow examples of Bash permissions, directory changes, command chains, redirects, and classifier guidance.

## TypeSafe Jev

Select the backend through the existing `autoMode.classifierModel` setting:

```json
{
  "autoMode": {
    "classifierModel": "typesafe/jev-latest",
    "classifierTimeoutMs": 20000
  }
}
```

Set `TYPESAFE_API_KEY` in the process environment before starting OMP or Pi. Do not put API keys in automode rules or configuration files. The extension sends the key only as a Bearer authorization header to `https://api.typesafe.ai/v1/systemone`.

`typesafe/jev-latest`, `typesafe/jev-preview`, and pinned IDs such as `typesafe/jev-1.14.0` use the native TypeSafe backend. No `models.json` entry or `/login` provider is required. `/automode model typesafe/jev-latest` saves the selection globally and requires the environment key. When the key is present, the picker includes `jev-latest` and the currently configured Jev version.

Any other `provider/model-id` uses the existing Pi/OMP registry and provider credentials. Omitting `classifierModel` uses `@smol` under OMP and the current session model under Pi. Setting a TypeSafe key alone does not switch backends.

Jev evaluates four typed questions in one request: hard-deny match, soft-deny match, coverage by ALLOW exceptions, and direct user authorization for all remaining soft-denied effects. Hard denies always block. A soft deny blocks unless every affected operation is covered by an exception or direct user authorization. Actions without a deny match are allowed.

Jev cannot generate a free-text explanation; denial reasons identify the policy tier. `classifierReasoningLevel` and `fastClassifierMaxTokens` do not alter Jev requests. An explicitly requested reasoning level is logged with effective level `off`. `classifierTimeoutMs` covers the entire native request, including response-body consumption, and parent cancellation still applies.

The extension keeps the full action and uses the existing bounded transcript. Conservative context estimates enforce TypeSafe's default 32k per-question and 64k per-request limits without truncating the action. It does not enable TypeSafe's experimental long-context header.

Missing credentials, transport errors, non-success HTTP responses, malformed or incomplete typed answers, context overflow, cancellation, and deadlines block the action. They never fall back to a different classifier. Existing permission, deterministic hard-deny, and local allow tiers run before either backend.

## Custom models (like OpenRouter's presets)

Except for the native Jev backend above, pi-automode selects models through Pi's model registry. Add unlisted chat models to `~/.pi/agent/models.json`.

For example, register an OpenRouter preset in the built-in `openrouter` provider:

```json
{
  "providers": {
    "openrouter": {
      "models": [
        {
          "id": "@preset/nvidia-nemotron-3-nano-30b-a3b-fast",
          "name": "NVIDIA: Nemotron 3 Nano 30B A3B Fast (Preset)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262144,
          "maxTokens": 235929,
          "cost": {
            "input": 0.05,
            "output": 0.2,
            "cacheRead": 0.03,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Restart Pi (or run `/reload`), then select the model with `/automode model openrouter/@preset/nvidia-nemotron-3-nano-30b-a3b-fast`.
