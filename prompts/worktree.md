---
description: Work alongside another agent without changing its working directory
argument-hint: "[task]"
---
$@

Another agent is working in the current repository. Treat its working directory as read-only for this session. Do not edit, stage, stash, clean, reset, switch branches, or change its files, index, or branch state

Read-only investigation can stay in the current directory. Before making changes or running commands that write files, including builds, formatters, and checks, create a separate Git worktree outside this directory on a new, uniquely named branch. Start from the relevant committed revision. Do not copy or change the other agent's uncommitted work. If the task depends on that work, ask me how to proceed

Use explicit worktree paths for all writes and commands, and give any subagents the same path and restrictions. Do not assume a shell directory change also changes the session or other tools' working directory. If a tool cannot target the new worktree, stop and ask me to start a session there

Commit or push only when I explicitly ask, and only from your worktree on your own branch. Worktrees share Git metadata, so do not change shared configuration, tags, or other branches. Do not merge your work into the other agent's branch or remove its worktree. When finished, report your worktree path, branch, and results
