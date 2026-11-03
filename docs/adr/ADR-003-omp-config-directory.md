# ADR-003: Use OMP's agent and project directories for config under OMP

**Date:** 2026-11-03

## Context

[ADR-002](ADR-002-global-config-in-extension-data-directory.md) put the global config at `~/.pi/agent/extensions/pi-automode/config.json`, inside the extension install directory. That location assumed Pi, where `~/.pi/agent/extensions/<name>/` is a user-writable directory that Pi creates.

OMP differs in three ways:

- OMP keeps user data in `<agentDir>`, normally `~/.omp/agent`. `getAgentDir()` follows OMP profiles and `PI_CONFIG_DIR`. A hard-coded `~/.omp/agent` would read the wrong directory for a profile.
- OMP projects use `.omp/`, not `.pi/`.
- OMP extensions are often installed from a marketplace, a Git checkout, or a package manager. The install directory can be read-only. For example, a Nix store symlink makes every write there fail. A config file inside the install directory cannot be created, edited with `/automode model`, or migrated into.

This decision refines the config source locations from ADR-001 and ADR-002. It does not change permission precedence or project trust boundaries.

## Decision

The extension detects OMP through the `getAgentDir()` function on the host's `pi.pi` namespace. If the function is missing, throws, or returns a non-absolute path, the extension uses the Pi locations from ADR-002 unchanged.

Under OMP, the extension stores data below the agent directory, outside any extension install directory:

| Item | Path |
|---|---|
| Global config | `<agentDir>/automode/config.json` |
| Logs for in-memory sessions | `<agentDir>/automode/logs/` |
| Project-local config | `.omp/automode.local.json` |
| Shared project config | `.omp/automode.json` |

The `.pi` locations stay readable as legacy sources.

### Global config

At startup the extension applies the ADR-002 selection rules, with the new path as the destination and Pi's global config as the legacy source:

1. If only the new file exists, use it.
2. If only a legacy file exists, move it to the new path. The legacy candidates are `~/.pi/agent/extensions/pi-automode/config.json` and, if that is absent, the older `~/.pi/agent/automode.json`.
3. If both exist, use the new file, leave the legacy file unchanged, and report a conflict at every startup.
4. If migration fails, use the legacy file for reads and writes during that session and report the error once.
5. If neither exists, use the new path for the next write.

One active path serves reads and writes, so a failed migration cannot split the configuration.

### Project config

Selection is per file, in the order `.omp/`, then `.pi/`:

- If `.omp/<file>` exists, it is used. An existing `.pi/<file>` is ignored and reported in diagnostics.
- If only `.pi/<file>` exists, it is used and diagnostics report the legacy location.
- Project files are never moved. They can be committed or shared with Pi users, so the extension does not rewrite them.
- Trust rules are unchanged. Untrusted projects ignore files in both directories. The shared file keeps the ADR-001 limits.

### Protection

The extension protects the new locations as it protects the Pi ones. Direct `write` and `edit` calls, and Bash redirects and file-mutating commands, are hard-denied for `.omp/automode*`, `<agentDir>/automode/`, and `<agentDir>/extensions/`. The default `~/.omp/agent` is always protected. The active `<agentDir>` is registered at startup, so a profile or `PI_CONFIG_DIR` directory is protected too. `.omp` joins `.pi` in the default protected paths, and the classifier prompt names `.omp/automode*`.

### Reporting

`/automode config` and `automode_inspect` report the host and the selected global and project files as `configSources`.

## Alternatives considered

- Keeping the config in the extension install directory: rejected because that directory can be read-only.
- Hard-coding `~/.omp/agent`: rejected because it ignores profiles and `PI_CONFIG_DIR`.
- Reading the legacy file without moving it: rejected because two long-lived copies diverge. ADR-002 already chose a one-way move for the same reason.
- Merging `.omp/` and `.pi/` project files: rejected because the precedence between two files with the same role is ambiguous, and a merge could silently mix a stale `.pi` file into the effective policy.

## Consequences

The global config and logs have one root directory under OMP, in the place OMP users expect user data.

The migration is one-way. After it runs, a Pi installation of the same user no longer finds its global config at the Pi path. Users who run both hosts can copy the file back or keep separate configs.

If both `.omp/automode.json` and `.pi/automode.json` exist, deny and ask rules that exist only in the `.pi` file are not applied. The diagnostics name the ignored file.

Protection of a profile directory depends on the extension having started in that process. A different process with another profile protects its own directory plus the default.

Tests must cover OMP path selection, migration, conflicts and errors, project fallback, protection of the new paths, and unchanged Pi behavior.
