---
description: Resolve upstream conflicts and repair the current PR branch stack
argument-hint: "[PR link or additional instructions]"
---
$@

I am on the top branch of a stack, with each PR targeting the branch below it. Inspect the stack and upstream changes, resolve merge conflicts, and repair the branches from bottom to top while preserving each PR's scope and any unrelated work

Create backup refs before rewriting history, run the required checks, and return to the top branch when finished. Ask if the stack or a conflict resolution is unclear. Do not push unless I explicitly ask
