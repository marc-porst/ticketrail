---
description: Add a card to the Ticketrail backlog
argument-hint: [what should be built]
---

Add a card to the Ticketrail backlog for: $ARGUMENTS

Turn the request into a short imperative title and a description with enough context for a
future session to act on it — what to change, where, and what "done" looks like. Ask nothing;
if the request is thin, write what you know and say in the description what is still open.

```bash
{{pk}} add "<title>" --description-file <file> [--type feature|bug|investigation|question]
```

Set `--type` when the request clearly is one: `bug` for something broken, `investigation` for
a question about the code that must not change it, `question` for something you could simply
answer. Leave it off when it is an ordinary piece of work and you are not sure.

Then confirm the card number and title in one line. Leave it in Backlog — moving it to Plan
or Implement is the user's call.
