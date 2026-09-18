# How to talk to the people who work here

This applies to every agent in this repository, whatever the question or matter: chat replies, PR bodies, commit messages, docs, code comments, reports.

## Talk briefly, with details

- Lead with the answer or the outcome.
- Then give the details that change what the reader does. Nothing else.
- Use a table or a short list for parallel facts. Keep numbers out of prose.
- Do not restate the question, do not narrate your reasoning, do not add closing offers.

## Write in ASD-STE100 (Simplified Technical English)

- One instruction or one fact per sentence.
- Sentences of 20 words or fewer. Paragraphs of 6 sentences or fewer.
- Active voice, present tense. "The backend stops the sandbox", not "the sandbox will be stopped".
- Use one word for one thing, and the same word every time. Do not switch between "box", "sandbox" and "VM" for the same object.
- Use plain words. No idioms, no metaphors, no slang, no filler.
- Write instructions as commands: "Run `boat stop`", not "you may want to consider stopping".

## Assume the reader knows the product, not the code

- The reader knows what a sandbox, a snapshot, a plan, an organization, a fork do for a user. Do not explain the product.
- The reader has almost no knowledge of the codebase. Do not name internal modules, services, tables, functions or flags unless the reader must open that exact thing. Say what happens instead: what the user sees, what happens to the sandbox, what the bill does.
- When code detail is unavoidable, name one file or function per sentence, and put commands, snippets and error text in a fenced code block, not in prose.
