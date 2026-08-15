---
name: repo-audit
description: >
  Whole-repo improvement audit. Scans the entire codebase, not a diff, for
  over-engineering, dead code, duplication, dependency bloat, error handling
  gaps, performance and security red flags, untested critical paths, and
  structural issues. Outputs a ranked list of concrete findings, biggest
  impact first, one line each, with the replacement named. Use when the user
  says "audit this codebase", "audit the repo", "what can I improve",
  "code quality review", "find bloat", "repo health check", or
  "/repo-audit". One-shot report, applies nothing.
metadata:
  author: jonah
  version: "1.0.0"
---

# Repo Audit

Whole-repo improvement scan, adapted from the ponytail-audit skill by
DietrichGebert (https://github.com/DietrichGebert/ponytail). The tags `cut`,
`stdlib`, `native`, `yagni`, and `shrink`, the ranked one-line format, and
the `net:` closing line come from that work. The rest are added from general
code audit practice: duplication, dependency hygiene, error handling,
performance, security, testing, and structure. Scan the whole tree, rank
findings biggest impact first, one line per finding, apply nothing.

## Method

1. Map the repo first. Read the README, package manifest, AGENTS.md, and
   docs/ to learn what the project is and which conventions it deliberately
   follows. Never flag a deliberate choice.
2. Walk the tree by hand: entry points and core modules first, then the
   rest. Grep finds candidates, but verify every finding by reading the
   actual code and tracing how it is used. A false positive is noise, and an
   audit full of noise is worse than no audit.
3. Skip vendored code, generated code, lockfiles, and third-party code the
   repo does not own.
4. A finding must survive this test: the change is a clear win, the
   replacement is concrete, and nothing breaks. When in doubt, leave it out.

## Tags

Complexity, biggest cuts first:

- `cut:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.
- `dup:` same logic copied in N places. Name the shared form.

Health:

- `dep:` dependency hygiene: unused, redundant, or major-version-behind dependency. Name the action.
- `err:` swallowed errors, silent failures, missing input validation. Name the failure mode it hides.
- `perf:` performance red flag with a concrete fix: N+1 queries, I/O in a loop, unbounded growth.
- `sec:` security red flag with a concrete fix: hardcoded secrets, injection, unsafe deserialization, missing authz.
- `test:` critical path with no coverage, or a test that asserts nothing. Name the path.

Structure:

- `arch:` coupling, god object, layering violation. Name the simpler shape.
- `doc:` documentation that no longer matches the code. Name the mismatch.

## Output

Start with one sentence on the overall state of the repo and the single
change that helps the most. Then one line per finding, ranked biggest impact
first:

`<tag> <what>. <replacement>. [path:line]`

Cap the list at 15 findings. If more exist, add a final line:
`More candidates: <count> more.` End with the net:

`net: -<N> lines, -<M> deps possible`

When there is nothing worth changing, say `Lean already. Ship.` and stop.

## Boundaries

- Scope: maintainability and improvement. A genuine bug or security hole
  spotted in passing is worth a `err:` or `sec:` line, but the audit is not
  a bug hunt and not a security review (pi-package-audit covers installed
  packages, a dedicated pass covers threats).
- One-shot report. The user decides what to change.
- A single smoke test or assert-based self-check is the minimum, not bloat.
  Never flag it.
