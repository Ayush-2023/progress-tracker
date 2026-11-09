# Progress Tracker

Personal tool for goals, achievements and reminders. Currently a proof of concept (v0), kept as simple as possible.

## Tech stack (v0)

- Plain HTML, CSS and JavaScript in `app/`, with no framework, build step or dependencies. The one outside request is the JetBrains Mono font from Google Fonts, used by the Programmer theme.
- Themes are Light, Dark and Programmer, defined as CSS variables at the top of `app/styles.css`.
- Data lives in the browser's `localStorage`, on one device. JSON export and import are the backup.
- Run it by opening `app/index.html` in a browser.
- It installs to a phone's home screen as a web app: `app/manifest.json`, `app/icons/` and the offline service worker `app/sw.js`. When adding a file the app needs, add it to `APP_FILES` in `sw.js`, and bump `CACHE` in `sw.js` when that list changes.
- Do not add a framework, backend or dependency unless the user asks.

## Core concepts

- Goals (long term) hold blockers, tasks and subtasks.
- Each goal has a permanent visible ID (`G-001`). A deleted goal's number is never reused.
- Any goal type can be finished from its dropdown. Finished goals can be reopened or archived, and archived goals can be unarchived.
- Achievements (short term) can attach to a goal, blocker, task or subtask.
- Goal types: Targeted (reach an end state), Maintenance (keep something steady), Growth (continuous improvement). Saved data stores these as `Achieve`, `Maintain` and `Grow`, and only the displayed names differ.
- Reminders are things that come up on their own, unlike goals and achievements, which the user sets.

## Mottos

1. If I don't have to, I won't; if I have to, I'll do it as quickly as possible.
2. You don't get what you dream for, you get what you work for.

## Docs

- Notes live in `docs/` as Markdown, meant to be opened in Obsidian.
- New ideas go in `docs/inbox.md`. When the user says "add this to the inbox", append it at the top with the next `I-` number and today's date.
- Link ideas with `[[I-001]]` style wikilinks, using the relation fields described at the top of `inbox.md`.
- Sort the inbox only when the user asks, and confirm where each item goes before moving it.

## Versioning

- Never version ideas with labels like "I-002 v2" or copies like `inbox-v2.md`. Git holds the history.
- Small edit to an idea: edit it in place and start the commit message with its ID, for example `I-003: narrow reminders to list-only`.
- Change of direction: if anything planned or built on the old version would now be wrong, create a new idea with `Supersedes: [[I-000]]` and set the old one to `superseded`. Keep the old entry.
- Status values are listed at the top of `docs/inbox.md`. Rejected ideas stay in the file with a one-line reason.
- Releases: tag each one in git (`v0.2.0`) and list it in `CHANGELOG.md` with links to the ideas it shipped. The numbering rules are at the top of the changelog.
