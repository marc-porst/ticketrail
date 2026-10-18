---
description: Start the Ticketrail board UI for this project
---

Start the Ticketrail board for this project.

1. If `.ticketrail/config.json` does not exist, run `{{pk}} init`.
2. Start the server as a **background** Bash task: `{{pk}} serve --open`.
   Do not run it in the foreground — it never exits.
3. Wait a moment, then read the background task's output to get the URL.
4. Report the URL and, in two or three lines, how the board works:
   - write cards in **Backlog**,
   - drag to **Plan** for Claude to plan, or **Implement** to skip straight to building,
   - review a plan in **Planned**, edit it, then drag to **Implement**,
   - answer Claude's questions inside the card when it lands in **User Input**.
5. Tell them to run `/ticketrail-work` (here or in a second session) so Claude starts picking
   cards up, and stop there — do not start the worker yourself unless they ask.
