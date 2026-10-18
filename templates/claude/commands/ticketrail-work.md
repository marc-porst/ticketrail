---
description: Watch the Ticketrail board and work cards as they arrive
argument-hint: [worker-name] [--only label:x,type:bug]
---

Work the Ticketrail board. Follow the `ticketrail` skill for the full contract.

Arguments: `$ARGUMENTS`. If they are not empty, you are a **named worker**: the first word is
your name and the rest is your filter, e.g. `fe --only label:frontend`. Add
`--worker <name>` and that `--only ...` to **every** `next` and `wait` call below, so you only
claim and only wake for your cards. With no arguments, run the commands exactly as written.

Repeat this loop:

1. Run `{{pk}} next` (no `--wait`; it answers at once).
2. `{"status":"none"}` — nothing is queued. Start `{{pk}} wait --timeout 0` as a
   **background** Bash task (`run_in_background: true`), say "Board is quiet — waiting for the next
   card" in one line, and **end your turn**. Do not poll it, and do not sleep. `wait` never claims
   anything, so it costs nothing while it waits and strands nothing if the session closes. When the
   background task finishes, Claude Code wakes you: go back to step 1. Another worker may have taken
   the card in the meantime, in which case `next` says `none` again and you wait again.
   `{"status":"updated"}` means Ticketrail was updated while you waited: also go back to step 1.
   Never stop because the board has been quiet for a while.
   (No background tasks where you run? Use `{{pk}} next --wait` in the foreground instead, and
   just run it again on every `none`.)
3. `{"status":"claimed"}` — the card is now In Progress and is yours:
   - If `task.attachments` is non-empty, open every `attachments[].path` first — a screenshot
     usually says more than the description does.
   - If `relatedCards` is present, read each card's plan and result as context — they are
     not yours to change.
   - If `agent` is present, the card belongs to that project agent: delegate it with the Agent
     tool as `guidance` says, rather than working it yourself.
   - Check `task.type` first: an **Investigation** or a **Question** must never change code —
     follow the `guidance` string, which names the command to finish with.
   - **`mode: "plan"`** — research the code and write a real plan: what changes, in which
     files, and how to verify it. Do not implement. Save with
     `{{pk}} plan <id> --file <plan.md>`.
   - **`mode: "implement"`** — implement it. Use `task.plan` as the spec when it is set,
     otherwise `task.description`. Run the project's tests or build if it has them.
     Finish with `{{pk}} done <id> --file <summary.md>`, where the summary says
     what changed, which files, and how it was verified.
   - Call `{{pk}} log <id> "..."` at the real milestones as you go.
   - When a decision is the user's to make, `{{pk}} ask <id> "..." --wait`.
   - If you cannot finish, `{{pk}} fail <id> "reason"` — never abandon a card in
     In Progress.
4. Go back to step 1 straight away. There may be more work queued already.

Between cards, report in one line what you finished and what you are picking up next.

This runs unattended as it is: an idle worker costs nothing and wakes itself when a card arrives.
