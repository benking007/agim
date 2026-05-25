---
name: summarize
description: Summarize URLs, articles, PDFs, or YouTube videos. Use when the user asks "这篇文章讲什么" / "总结一下 …" / "summarize this link" / "what's this video about". For long content prefer summary over verbatim transcript unless the user explicitly asks for a transcript.
always: false
metadata:
  agim:
    requires:
      bins: [curl]
---

# Summarize

Two paths depending on content type. Pick **path A** for HTML / article / blog; **path B** for YouTube; **path C** for local files.

## Path A — Web page / article

1. Fetch the page (server-rendered HTML usually has the body):
   ```bash
   curl -sL -A "Mozilla/5.0" "<url>" | head -c 200000
   ```
2. If the page is a SPA (the body has almost no text), try a reader API:
   - `r.jina.ai/<url>` — strips chrome, returns clean text
     ```bash
     curl -s "https://r.jina.ai/<url>"   # url passed verbatim
     ```
3. Pipe the cleaned text into your own context and produce a 3-section summary:
   - **核心结论** (1-2 sentences)
   - **要点** (3-7 bullets)
   - **数据/引用** (any concrete numbers, dates, names mentioned)

## Path B — YouTube

The user typically wants a summary, not a transcript. Try transcript route first; fall back gracefully if blocked:

1. Try `r.jina.ai` reader on the watch URL — sometimes returns auto-caption text.
2. If that fails and `yt-dlp` is installed, pull subtitles:
   ```bash
   yt-dlp --skip-download --write-auto-sub --sub-lang zh,en --convert-subs vtt -o "/tmp/yt-%(id)s" "<url>"
   ```
3. Read the `.vtt`, strip timestamps, then summarise.
4. If neither works, tell the user: "字幕拉不到，建议你贴一段文字过来我帮你总结。"

## Path C — Local file

1. Use the model's file-read tool on `*.md`, `*.txt`, `*.html`, `*.json`.
2. PDFs: prefer a converter on the host (`pdftotext file.pdf -` if installed); otherwise tell the user you can't read PDFs in this environment.

## Output rules

- Default reply ≤ 12 lines unless the user asks for detail.
- If the source is long (> 50K chars): give summary + offer "需要详细展开哪一段？".
- Always cite the source URL at the bottom.
- Never paste base64 / raw HTML / raw VTT to the user.
