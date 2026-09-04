---
name: anki
description: Add notes to Jonah's source-controlled Anki memory repository. Use when Jonah says to add, save, remember, or make something in Anki, including context-dependent requests such as "add that keybinding to Anki" or "make a note of that in Anki". Choose the note type and deck, formulate the note, and write only the source note. Never commit, import, sync, or push.
compatibility: Requires ~/Projects/memory
metadata:
  author: jonah
  version: "1.0.0"
---

# Anki

Add the requested knowledge to `~/Projects/memory`. The repository is the
source of truth. Write the note only. Never run its push, preview, import, or
sync commands, and never commit its changes

## Workflow

1. Read `~/Projects/memory/AGENTS.md`
2. Inspect the current note types, decks, and nearby notes. Use the conversation
   and current work to resolve references such as "that"
3. Choose the narrowest existing note type that fits:
   - Use `keybindings` for keyboard shortcuts and key-driven commands
   - Use a specialized type when the content matches it exactly
   - Use `basic` for general knowledge that needs a direct prompt and answer
   - Do not create a new note type for one note
4. Choose the deck by subject, not by the current project name. Reuse an
   existing deck when it fits. Software and computing go in `computer-science`,
   and Christian doctrine and practice go in `christianity`. If no deck fits,
   create a lowercase kebab-case subject directory and its correctly named data
   file
5. Read the selected note type's `fields.md` and `cards.md` before writing
6. Confirm from the available context that the material is correct and
   understood. Ask one concise question only when an essential field cannot be
   inferred
7. Search the target data file for the same knowledge. Do not add a duplicate
8. Formulate the smallest useful note that tests one fact. Make the prompt
   direct, include context that prevents ambiguity, and preserve exact syntax
   for commands and bindings
9. Append one pipe-delimited line in the documented field order. Keep the note
   on one physical line, do not add a header, and do not put a raw `|` inside a
   field
10. Report the note and target file, then stop

For a keybinding, include the action, exact binding, and precise program or
mode. For a general note, prefer a question that has one short answer over a
broad prompt
