---
name: ticketrail
description: Work this project's Ticketrail board — the Trello-like board in .ticketrail/ where the user queues work for Claude. Use when the user runs /ticketrail-start or /ticketrail-work, asks what is on the board or queued, asks you to pick up the next task, or refers to a card by number (#3).
---

# Ticketrail

The board lives in `.ticketrail/tasks/*.json`, one file per card. The React UI and you
read and write the same files, so anything you write shows up in the user's browser
immediately, and anything they do reaches you the next time you read.

**Never edit those JSON files by hand.** Use the CLI — it takes a lock, writes atomically,
and keeps the columns consistent.

## The columns

| Column | Meaning |
|---|---|
| **Backlog** | The user's drafts. Do not touch cards here. |
| **Plan** | Queued for you to *plan* only. |
| **User Input** | Blocked on the user's answer. |
| **Implement** | Queued for you to *build*. Top card first. |
| **In Progress** | You are working on it right now. |
| **Planned** | Your plan is waiting for the user's review. |
| **Done** | Finished. |

The user moves cards into **Plan** and **Implement**; you move them everywhere else, and
only through the commands below.

## The commands

```bash
{{pk}} next --wait          # claim the top card (Implement first, then Plan) -> JSON
{{pk}} wait --timeout 0     # block until Plan/Implement has a card; never claims (run in background)
{{pk}} check <id>           # has the user pulled the card back? -> JSON
{{pk}} log <id> "text"      # append to the card's activity feed  [--kind info|file|test|error]
{{pk}} ask <id> "q" --wait  # park on User Input and block for the answer -> JSON
{{pk}} plan <id> --file p   # store the plan, card -> Planned
{{pk}} done <id> --file p   # store the result, card -> Done
{{pk}} fail <id> "reason"   # stop and hand the card back to the user
{{pk}} files <id>           # the card's attachments, with paths to open -> JSON
{{pk}} attach <id> <file>   # attach a file to the card (a screenshot you took, a log)
{{pk}} detach <id> <fileId> # remove an attachment
{{pk}} status               # human-readable board summary
{{pk}} show <id>            # one card as JSON
{{pk}} add "title"          # create a card in Backlog  [--type feature|bug|investigation|question] [--label x]
{{pk}} label <id> --add x   # edit a card's labels  [--remove y]
{{pk}} derive <id>          # spawn a Feature card from a finished investigation
{{pk}} relate <id> <other>  # link a card as context for this one  [unrelate to remove]
{{pk}} agents             # the project's agents (.claude/agents) -> JSON
{{pk}} assign <id> <name> # hand a card to an agent  [none to clear]
```

Text arguments take `--text "..."`, `--file <path>`, or `--file -` for stdin.
`--wait` blocks for up to 500 seconds; pass `--timeout <seconds>` to change that.

## When the board is quiet

When `next` returns `{"status":"none"}`, run `{{pk}} wait --timeout 0` as a **background** Bash
task and end your turn. It blocks until Plan or Implement holds a card, and it **never claims**:
claim with `next` once it wakes you. Waiting this way uses no tokens, so never stop working the
board just because it has been quiet. While `wait` runs, the board header shows `worker ready`;
without it the user sees `no worker`, so always leave it running when you go idle.

## Working a card

`next` returns `{status, mode, type, task, guidance}`. `mode` is what the user asked for:

- **`mode: "plan"`** — research the codebase and write a plan. Do **not** implement anything.
  Save it with `plan <id> --file <plan.md>`; the card lands in **Planned** for review.
- **`mode: "implement"`** — build it. If `task.plan` is set, that plan is the spec and the
  user has already approved it; follow it. If not, work from `task.description`.
  Finish with `done <id> --file <summary.md>`.

## Card types

`task.type` is optional, and for two of the four values it **overrides the mode** — follow
`guidance`, which already says which command to finish with:

| Type | What it means for you |
|---|---|
| **Feature** / **Bug** | Classification only. Work the card exactly as the mode says. |
| **Investigation** | **Never write code.** Research and write findings into the plan, then `plan <id>`. Even if the card reached you through Implement, produce a plan and nothing else. |
| **Question** | **Never write code.** Answer it and finish with `done <id> --file <answer.md>`, whichever queue it came from, so the answer lands on the card. |

An investigation the user is happy with becomes real work through **Create implementation
task** in the UI (or `derive <id>`), which copies its plan onto a new Feature card in
Implement. You do not need to do that yourself unless asked.

Labels (`task.labels`) are free-text tags with no behaviour — read them for context, and set
them with `label <id> --add <label>` when a card obviously belongs to an area you are already
tagging.

## Related cards

A card can link other cards as context (the **Related** tab in the UI, or `relate`). When it
does, `next` adds a `relatedCards` array: each linked card's number, title, column, type,
labels, description, plan, result and attachment paths, plus the investigation the card was
derived from, if there is one. Long fields are cut; run `show <id>` for the full card.

Read them before you start. A follow-up bug is best understood through the original
feature's plan and result. They are **context, not work**: never edit, move or claim them.
When you create a follow-up card yourself, link it to the card it builds on:

```bash
{{pk}} relate <id> #12 #14    # ids or #numbers; unrelate removes
```

## Agents

A card can name a project agent (`task.agent`): a Claude Code subagent defined in
`.claude/agents/<name>.md`, which the user manages in the board's **Agents** view. When it does,
`next` adds an `agent` object (name, description, path), and `guidance` tells you to **delegate**:

1. Hand the whole card to that subagent with the Agent tool (`subagent_type: "<name>"`). If this
   session does not know that type yet (the agent was created after the session started), use a
   general-purpose subagent and tell it to follow the agent file as its instructions.
2. In the prompt, give it the card id, title, description, plan, attachment paths and related-card
   context, plus the finishing command from `guidance`. It logs with `log <id>` and finishes the
   card itself, or runs `fail <id> "reason"`.
3. When it returns, run `check <id>`. If the card is still In Progress, finish it yourself from the
   subagent's report.

Do not do the card's work yourself, so your own context stays small. A card whose agent file is
gone never reaches you: `next` hands it back to the user and claims the next card.

## Parallel workers

Several Claude Code sessions can work one board at once. Each is a **named worker** with an
optional filter, started as `/ticketrail-work <name> [--only <filter>]`, and passes both to every
`next` and `wait`:

```bash
{{pk}} next --worker fe --only label:frontend          # claim only frontend cards
{{pk}} wait --timeout 0 --worker fe --only label:frontend   # wake only for them
```

A card can also be **sent to one worker** (`task.worker`, the Worker picker in the card, or
`{{pk}} send <id> <worker|none>`). Only the worker with that name claims it, even if its filter
would not match, and every other worker passes it by.

Filter terms are `label:`, `agent:`, `folder:` and `type:`, comma-separated or repeated. Values of
one kind are alternatives and different kinds must all match; `none` matches a card with no agent,
folder or type. Claims are locked, so two workers never take the same card. The card records the
worker (`task.claimedBy`), and the board header lists who is waiting and who is on which card.

Parallel workers that change code should each run in their **own git worktree**, so they do not
edit the same files. Inside a linked worktree the CLI uses the main checkout's board, and `next`
adds `worktree: {path, branch}`: make your changes in that worktree and name the branch in your
summary so the user can merge it. `TICKETRAIL_ROOT=<path>` points the CLI at a board explicitly.

## Folders

Folders (`task.folder`, with `folderName` in `next`) only organise the board. They do not change
how you work a card, and a card with no folder is normal. Leave them alone unless the user
asks. When you create a follow-up card, you can give it the same folder:
`{{pk}} add "title" --folder "<name>"`.


## Attachments

Cards can carry files — screenshots of a bug, a design, a log, a CSV. They live in
`.ticketrail/files/` and are listed in `task.attachments`.

`next`, `show` and `files` add an absolute `path` to each attachment. **Open every attachment
before you start**: read an image with the Read tool, a text file however you like. A screenshot
is usually the clearest statement of what the user actually wants, and ignoring it means
building the wrong thing.

Attach files back to the card whenever the result is visual or the evidence is worth keeping —
a screenshot of the feature you built, a failing test log:

```bash
{{pk}} attach <id> ./screenshot.png
```

## Rules

1. **Claim, never pick.** Only work on a card that `next` handed you. It moves the card to
   In Progress atomically, so two worker sessions never collide.
2. **Log as you go.** Call `log` at the real milestones — files read, files written, tests
   run, decisions made. The user is watching this feed instead of your terminal. A few
   entries per card, not one per tool call.
3. **Ask instead of guessing.** When a decision is genuinely the user's, use
   `ask <id> "..." --wait`. The card moves to User Input, the question appears in the card's
   chat, and the command returns their answer. On `{"status":"pending"}` the wait timed out:
   stop working that card, say so, and move on.
4. **Never leave a card in In Progress.** Every claim ends in `plan`, `done`, or `fail`.
5. **Check for cancellation** on long cards. If `check` says `cancelled`, the user dragged
   the card away — stop, and leave it where they put it.
6. **Read the chat first.** `task.messages` may hold notes the user left before queueing.
7. **Open the attachments.** Never plan or build from the description alone when the card
   carries files.
8. **Read the related cards.** When `next` returns `relatedCards`, their plan and result are
   part of the brief. Do not change those cards.
9. **Notice what the user adds mid-run.** While you work a card, its type, agent and worker are
   locked, but the user can still send chat notes and add files. `check <id>` returns them as
   `news` and `log <id>` prints them. `done` / `plan` stop once if there is unread news: read it,
   take it into account, and run the same command again.
10. **Delegate cards with an agent.** When `next` returns `agent`, hand the card to that
   subagent as described under Agents. Do not work it yourself.
