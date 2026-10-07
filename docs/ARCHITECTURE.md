# Architecture

```
.tex buffers ──► tokenizer ──► Renderer ──► frames[] (HTML + metadata) ──► webview (preview.js + metropolis.css)
                                  │                                           │
                                  └─► SnippetCache ──► docker/pdflatex ──► cached PDFs ──► pdf.js canvas
```

## Files

| File | Role |
|---|---|
| `src/tokenizer.js` | Converts TeX source into tokens: control sequences, chars, groups, `\begin`/`\end`, math, verbatim and raw environments |
| `src/render.js` | The `Renderer`: preamble, document walk, frames → HTML. It holds most of the logic |
| `src/colors.js` | xcolor expressions (`a!30!b`, `-a`), color models, dvips and svg names |
| `src/project.js` | Root-file discovery (`%!TEX root`, parent search through `\subimport`/`\input`), file reading with editor overrides |
| `src/snippets.js` | Background LaTeX compilation of `tikzpicture`/`algorithm`, content-hash cache |
| `src/page.js` | HTML page shell, shared by the webview and the CLI export |
| `src/extension.js` | VS Code glue: panel, debounced rendering, cursor sync, click-to-source |
| `media/preview.js` | Webview runtime: incremental DOM patching, scaling, overlays, pdf.js, animations, present mode |
| `media/metropolis.css` | The theme, in TeX points on a 455.24 × 256.07 pt (16:9) slide |
| `cli.js` | Static HTML export |

## Tokenizer

The tokenizer is a single pass. It handles comments, control words and symbols, braces, `$…$`, `$$…$$`, `\[…\]` and `\(…\)`, `&`, `~` and `#n`.
It turns blank lines into `par` tokens. Some environments are captured whole, as raw text:

- math (`equation`, `align`, …), sent to KaTeX as written;
- verbatim-like (`verbatim`, `lstlisting`);
- *raw* (`tikzpicture`, `algorithm`), sent to the snippet renderer.

Every token stores its file and offset, so frames and list items know their source line.

## Renderer

The renderer reads arguments on demand: `readArg` takes `{…}` or a single token, and there are also `readOpt` and `readOverlay`.
Commands therefore don't need a declared signature table.

1. **Preamble.** Collects `\title` & co., `\definecolor`, `\setbeamercolor`, `\metroset`, `\newcommand` (also forwarded to KaTeX
   as macros), packages and TikZ libraries (for snippets). `finishTheme()` then computes CSS variables using metropolis' formulas,
   for example `block title bg = normal text.bg!80!fg`.
2. **Document walk.** Follows `\subimport`/`\input` recursively and records title, section and frame items.
   Numbering and the progress-bar fraction are computed afterwards, so they match beamer's `\inserttotalframenumber`.
3. **Frames.** `convertStream` walks the tokens. Font and size switches wrap the rest of the group in `display: contents` spans.
   Environments and commands are handled in `environment()` and `command()`. Anything unknown is dropped, with a diagnostic.
4. **Overlays.** Elements get `data-only` / `data-uncover` / `data-notonly` / `data-invisible` attributes holding the overlay spec.
   `\pause` wraps the rest of the frame; a pause inside a list also covers what follows the list.
   The webview turns a step number into visibility classes, so all steps share one DOM.

## Webview

- Slides are laid out at their real size in `pt`, so TeX lengths like `mm`, `em` and `0.6\textheight` map directly.
  They are then scaled with CSS `zoom`.
- Each slide is identified by a hash of its HTML. Updates only replace slides that changed, so PDF canvases and the scroll position survive typing.
- pdf.js is loaded lazily as an ES module. The worker is started from a blob URL, because webview resource URLs are cross-origin.
  Rendering is serialised per canvas.
- Snippets: on a cache hit the renderer emits a `canvas.snippet-img` with the PDF's webview URI right away. On a miss it emits a
  `.snippet.pending` placeholder (`data-key`). After the background compile, `onReady` posts a `snippet` message with the key and the
  webview URI (already converted, never convert it again), and `preview.js` swaps the placeholder for a canvas, or marks it failed.
- The webview reports `stats` (cards, `pdfOk`, `pdfFail`, pending/rendered snippets, fonts, …) after updates and snippet arrivals.
  The integration test reads them through the hidden `beamerPreview._stats` command.

## Calibration

The CSS numbers come from beamer itself:

- `\textwidth` = 398.34 pt and `\textheight` = 224.79 pt, measured with `\typeout` in a 16:9, 11pt metropolis document.
- List indent 21.9 pt, label separation 5.47 pt, item separation 3 pt.
- The frame title bar is 28.6 pt high.
- Title page positions were measured from rendered PDF pages.
