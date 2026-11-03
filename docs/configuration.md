# Configuration

The extension follows the documented Claude Code configuration model where Pi supports it.

It reads `autoMode` only from Pi-owned configuration sources:

- `~/.pi/agent/extensions/pi-automode/config.json`
- `.pi/automode.local.json` for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`

At startup, pi-automode moves a legacy `~/.pi/agent/automode.json` file to the new global path. If both files exist, it uses the new file and reports the conflict. If migration fails, it uses the legacy file for that session and reports the error.

It does not read project configuration until Pi trusts the project. For an untrusted project, it ignores `.pi/automode.local.json` and `.pi/automode.json`. `/automode config` reports each ignored file that exists.

Shared project `.pi/automode.json` cannot weaken auto mode. For a trusted project, it can add `permissions.deny` and `permissions.ask` rules.

The shared file cannot set `autoMode` or add `permissions.allow` rules. If the file contains `permissions.allow`, `/automode config` reports a diagnostic.

To disable pi-automode for the current project, create or edit `.pi/automode.local.json`:

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This file is project-local. Pi reads it only after project trust. Do not commit this file. Shared project `.pi/automode.json` cannot disable auto mode.

Set a global default classifier model in `~/.pi/agent/extensions/pi-automode/config.json`. For a trusted project, override it in `.pi/automode.local.json`.

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
    "deniedPaths": [],
    "maxUserTranscriptTokens": 4000,
    "maxToolTranscriptTokens": 4000,
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

`maxUserTranscriptTokens` and `maxToolTranscriptTokens` are approximate budgets for each category. Both default to 4000 and accept integers of at least 32.

Pi-automode does not support the former `maxTranscriptLines` field. Evidence selection now uses token budgets instead of line counts.

## Ask-user tools and explicit authorization

Classifier evidence includes normal user messages, verified answers from OMP's built-in `ask` tool, and assistant tool-call inputs. It excludes assistant prose and all other tool results, including answers from same-named or extension-provided ask tools such as `@vanillagreen/pi-questions`.

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

The matcher understands primary arguments for `bash`, `eval` (the cell `code`; see [Eval tool](#eval-tool)), the file tools, and `grep`. For file tools, it uses the resolved `input.path`. For `grep`, it uses `input.pattern`.

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

## Eval tool

OMP's `eval` tool runs Python or JavaScript cells. Its `code` can start shell commands that a `bash(...)` rule never sees, so pi-automode matches `eval` patterns against the code, scans the code for shell commands, and treats code it cannot fully read as opaque.

### Patterns

`permissions.deny`, `permissions.ask`, and `permissions.allow` accept `eval(...)`. The argument is a wildcard pattern matched against the cell's `code`, with the same `*` semantics as other patterns. `*` also matches newlines, so `eval(*shutil.rmtree*)` matches anywhere in the cell.

Prefix the pattern with `py:` or `js:` to limit it to one language: `eval(py: *requests.post*)`. `python:` and `javascript:` work too. A pattern without a prefix applies to both languages. To match code that literally starts with `py:`, write `eval(*py:*)`. If the call has no recognizable `language`, deny and ask rules still apply to a scoped pattern, and allow rules do not. `eval(py:)` with nothing after the prefix is malformed and fails closed like other malformed patterns.

### Embedded shell commands

Pi-automode extracts shell commands whose text is a literal from:

- Python: `subprocess.run`, `call`, `check_call`, `check_output`, `Popen`, `getoutput`, `getstatusoutput`; `os.system`, `os.popen`; `asyncio.create_subprocess_shell` and `create_subprocess_exec`; IPython `!cmd` lines, `var = !cmd`, and `%%bash` cells.
- JavaScript: `child_process` `exec`, `execSync`, `execFile`, `execFileSync`, `spawn`, `spawnSync` (through `require`, `import`, `import()`, destructuring, or renamed imports); Bun's `$` template without `${}` interpolation; `Bun.spawn` and `Bun.spawnSync` with a literal array or `cmd`.

A string argument is shell text. An argument list becomes a command line with each word quoted. Glob characters and a leading `~` stay unquoted, so `['rm', '-rf', '/*']` is analyzed as `rm -rf /*`. That over-approximates what `exec` runs, which can only make deny rules and hard-deny checks stricter. A literal `cwd` becomes a leading `cd`. Literal strings joined with `+` (or written side by side in Python) are folded into one string.

Each extracted command goes through the same checks as a `bash` call: `bash(...)` deny and ask rules match it, and deterministic hard-deny checks apply to it. Every command in a cell must pass, and the block reason names the embedded command. A `bash(rm -rf /*)` deny rule therefore blocks `subprocess.run(['rm', '-rf', '/*'])` in an `eval` cell.

An `eval` allow rule also needs every extracted command to be covered by `bash(...)` allow rules. `permissions.allow: ["eval"]` alone does not allow `os.system('git status')`.

### Opaque evals

When the scanner cannot be sure it saw every command, the eval is opaque. Common causes:

- an f-string with interpolation, a variable, or concatenation with a variable as the command; `shell=True` with a computed command;
- `getattr(subprocess, ...)`, `__import__`, `importlib`, `exec`, `eval`, `compile`, `ctypes`, `pty`, `os.exec*`, `os.spawn*`, `os.fork`;
- aliasing `subprocess` or `os`, or `from subprocess import ...`;
- `env=` or `executable=` options on a subprocess call;
- an IPython magic other than `%pwd`, `%ls`, `%env`, `%set_env`, `%who`, `%whos`, `%reset`, and `%load`, `%run`, or `%pip` cells;
- JavaScript `eval`, `Function`, `vm`, `process.binding`, computed member access, or a `child_process` function used as a value;
- code the scanner cannot tokenize, and extracted strings that are not valid shell.

An opaque eval never matches `permissions.allow`, even a bare `eval` rule. It skips the classifier's fast 0/1 stage, so the detailed review always runs. The classifier also receives the reasons, so it reads the code itself.

### `tool.*` calls

Code that calls `tool.bash(...)` or another `tool.*` function from inside `eval` reaches the `tool_call` hook as a normal call under the canonical tool name. Pi-automode does not parse those calls out of the eval code, so each one runs through the normal rules once.

### Limits

The scan is a best-effort lexical pass. It is not an interpreter and not a sandbox. It cannot see:

- values computed at run time;
- aliases defined in an earlier `eval` call. The Python and JavaScript sessions persist between calls, so `run = subprocess.run` in one call and `run(['rm', '-rf', '/'])` in the next hides the command from the scan. The first call is opaque and the second is not;
- code reached through files, installed packages, `%run`, or `%load`;
- file operations such as `shutil.rmtree`, `os.remove`, `pathlib.Path.unlink`, `open(..., 'w')`, or `fs.rmSync`. These are not modeled as shell commands and reach the classifier like any other action;
- network or other side effects that need no shell.

Obfuscation that defeats the lexer can still hide a command. The classifier remains the backstop for everything a deterministic rule does not block.

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

Any other `provider/model-id` uses the existing Pi/OMP registry and provider credentials. Omitting `classifierModel` keeps the current session model as the default. Setting a TypeSafe key alone does not switch backends.

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
