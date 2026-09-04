---
name: pi-upgrade
description: Update this repository's pi development dependencies to the installed pi version, review every intervening release for relevant changes, adapt affected extensions and skills, update documentation, and run all checks. Use when Jonah asks to review, synchronize, or catch up with a pi upgrade, or invokes /skill:pi-upgrade.
compatibility: Requires pi and mise, and must run in Jonah's custom pi repository
metadata:
  author: jonah
  version: "1.0.0"
---

# Pi Upgrade

Synchronize this repository with the installed pi release and review all changes
since the development dependencies were last synchronized. Do not update the
installed pi program. Do not commit

## Workflow

1. Read `AGENTS.md`, `README.md`, `docs/architecture.md`,
   `docs/papercuts.md`, `package.json`, and `mise.toml`
2. Confirm this is Jonah's custom pi repository. Preserve all existing worktree
   changes and identify them before editing
3. Get the installed version from `pi --version`. Get the reviewed version from
   the exact `@earendil-works/pi-coding-agent` development dependency in
   `package.json`. Require all three pi development dependencies to have the
   same exact reviewed version:
   - `@earendil-works/pi-ai`
   - `@earendil-works/pi-coding-agent`
   - `@earendil-works/pi-tui`
4. Locate the installed release at `$(mise where pi)/pi`. Read each complete
   changelog release section newer than the reviewed version through the
   installed version. Follow and read local documentation referenced by a
   relevant entry. If the installed changelog does not contain the full range,
   fetch the missing tagged changelog or release information from the official
   `earendil-works/pi` repository
5. Map this repository's pi usage before judging relevance. Read every extension
   and skill that uses an affected API or behavior. Search imports and API calls
   instead of guessing from filenames
6. Review `New Features`, `Added`, `Changed`, `Deprecated`, `Breaking Changes`,
   `Removed`, and `Fixed` entries. Pay special attention to:
   - extension APIs, events, lifecycle, and resource discovery
   - custom editors, TUI components, rendering, cursors, hardware cursor, and
     working indicators
   - tool schemas, execution, results, rendering, cancellation, and truncation
   - providers, models, authentication, and usage accounting
   - sessions, branching, compaction, and persistence
   - skills, prompts, settings, environment variables, and keybindings
   - fixes or defaults that match code this repository imports or overrides
7. Before changing dependencies, report the reviewed version range and a short
   list of relevant findings. Do not list unrelated provider catalog additions
   or model changes unless this repository depends on them
8. Adapt affected code and keep `README.md` and `docs/architecture.md` in sync.
   Remove temporary compatibility casts and shims when the new development
   types make them unnecessary. Keep papercut entries as historical records
9. Update all three pi development dependencies to the installed version with
   one exact npm operation:

   ```bash
   npm install --save-dev --save-exact \
     @earendil-works/pi-ai@<installed-version> \
     @earendil-works/pi-coding-agent@<installed-version> \
     @earendil-works/pi-tui@<installed-version>
   ```

10. Run `mise x -- hk check --all` and `git diff --check`. Inspect the final diff
    to confirm the lockfile and all three exact versions agree
11. Report:
    - old and new reviewed versions
    - relevant release changes and the local response to each
    - files changed
    - validation results
    - behavior that still needs Jonah to verify interactively

If the installed and reviewed versions already match, still run the checks and
report that there are no unreviewed releases. Do not reinstall dependencies

If the reviewed version is newer than the installed version, stop with a clear
error. Do not downgrade the development dependencies
