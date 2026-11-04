# Progress Tracker

Personal tool for goals, achievements and reminders. Currently a proof of concept: the manual workflow and ideas come first, code later. Do not choose a tech stack or write app code unless asked.

## Core concepts

- Goals (long term) hold blockers, tasks and subtasks.
- Achievements (short term) can attach to a goal, blocker, task or subtask.
- Goal types: Achieve (reach an end state), Maintain (keep something steady), Grow (continuous improvement).
- Reminders are things that come up on their own, unlike goals and achievements, which the user sets.

## Mottos

1. If I don't have to, I won't; if I have to, I'll do it as quickly as possible.
2. You don't get what you dream for, you get what you work for.

## Docs

- Notes live in `docs/` as Markdown, meant to be opened in Obsidian.
- New ideas go in `docs/inbox.md`. When the user says "add this to the inbox", append it at the top with the next `I-` number and today's date.
- Link ideas with `[[I-001]]` style wikilinks, using the relation fields described at the top of `inbox.md`.
- Sort the inbox only when the user asks, and confirm where each item goes before moving it.
