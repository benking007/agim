---
name: image-generation
description: How to handle "generate an image / 画一张 …" requests when agim has (or doesn't have) an image-gen tool available. Currently agim ships NO built-in image generator; this skill describes the workflow to take instead. Use whenever the user asks you to create, render, draw, design, or edit an image.
always: false
---

# Image generation

## Current status (v1.2.65)

**agim does not ship a built-in image generation tool yet.** A future
release will add `native_image_gen(prompt, ...)` backed by a configured
provider (StepFun / 通义万象 / OpenAI / …). Until then, image
generation requests need to be routed to whatever the operator has
already wired.

## Decision tree

When the user asks to generate / draw / design an image:

1. **Check if any external MCP server exposes an image-gen tool.** Look
   at your system prompt's tool list for anything containing
   `image_generation` / `generate_image` / `draw` / `text_to_image`.
   If present, call it.
2. **Check if a finance-style spec exists** (e.g. an operator has
   wired StepFun image gen behind a `stepfun_image` tool). Same as
   above — look at your tool table; if not there, it isn't enabled.
3. **None available** — explicitly tell the user agim doesn't have an
   image generator yet. Offer alternatives:
   - Use `native_web_search` to find an existing image online.
   - Send a `sendmail`-skill email with the prompt to a third-party
     service if the operator wired one.
   - Ask the operator to enable image generation
     (`mcp__agim__push_message` to the operator-alert thread is
     OK if the prompt is "operator hint" framed).

**Don't fabricate output.** Don't claim you generated an image when no
tool ran. Don't return a fake URL. The user pays attention to whether
your reply matches the tool_call sequence.

## When an image-gen tool IS available (forward-compatible)

Once `native_image_gen` (or similar) lands, the expected interface is:

```
native_image_gen({
  prompt: "...",
  reference_images?: ["<path-or-id>"],  // for iterative edits
  size?: "1024x1024" | "1024x1536" | ...,
  style?: "natural" | "vivid" | ...,
})
```

Returns `{ id, path, mime, prompt, model }` — store these as
**artifacts** in the per-thread media directory, do NOT inline raw
base64 in chat. Deliver to the user via the existing media path:
`mcp__agim__push_message({ text: "✅ done", media: [path] })`.

## Prompt-writing rules (once the tool exists)

When you do generate, write the prompt with enough detail:

- Subject + scene (who / what / where)
- Composition / camera / layout
- Style + mood + lighting + color palette
- Any text the image must contain (quoted exactly)
- Constraints ("keep the same character", "preserve the logo")

For iterative edits in the same thread, prefer the most recent
generated artifact's path as `reference_images[0]` when the user says
"change the background", "make it brighter", "try another version".

## Don't

- Don't claim image generation without an actual tool call.
- Don't inline base64 image data in chat — it's huge and useless.
- Don't expose local filesystem paths to the user in the reply; keep
  paths internal and reference images by short id.
