# CLAUDE.md

Context for working on this repository with Claude Code. Read `docs/DEVELOPMENT.md` (workflows) and
`docs/ARCHITECTURE.md` (design) as well.

## What this is

A VS Code extension that previews LaTeX **beamer/metropolis** slides *without compiling*. It parses the `.tex` source
and renders each frame as HTML/CSS that mimics metropolis, with live updates as you type, cursor sync and overlay steps.
Only `tikzpicture`/`algorithm` are compiled, once each, with real LaTeX in Docker, and cached.

The author (Jan Platoš) uses it for university courses, built from a root `main.tex` that `\subimport`s one `main.tex`
per lecture. The goal is "very similar, not pixel-perfect": bullets, images, math and layout must match closely.

## Layout

- `src/tokenizer.js`: TeX source to tokens.
- `src/render.js`: the `Renderer`. Most changes happen here.
- `src/overlays.js`: overlay specs and per-step variants for snippets.
- `src/snippets.js`: Docker or local LaTeX compilation and the cache.
- `src/colors.js`: xcolor expressions.
- `src/project.js`: root discovery and file reading.
- `src/page.js`: HTML shell.
- `src/extension.js`: VS Code glue.
- `media/metropolis.css`: the theme, in TeX `pt`.
- `media/preview.js`: webview runtime (pdf.js, overlays, present mode).
- `cli.js`: static export.
- `test/`: tests and tools.
- `examples/demo`: demo deck plus a reference `main.pdf` compiled with xelatex.

## Conventions

- Plain CommonJS, no build step, no TypeScript. 2-space indent, single quotes, semicolons. Keep the existing style and comment density.
- Runtime dependencies are only `katex`, `pdfjs-dist` and `@fontsource/*`. Keep it that way; dev-only tools go in `devDependencies`.
- Every renderer change gets a test in `test/smoke.js` (use `memDoc`), plus a look with `npm run compare`.
- The CSS numbers are measured, not guessed. They came from `\typeout{\the\textwidth}` and similar in a 16:9, 11pt metropolis document,
  and from pixel measurements of xelatex output. Don't "tidy" them. If you change one, verify with `npm run compare`.

## Verify before claiming something works

1. `npm test`: must stay green.
2. `npm run compare -- examples/demo/main.tex --snippets`: page count must match (currently 20 = 20), and the pairs must look alike.
3. `npm run test:vscode` for anything touching `extension.js`, `preview.js` or the CSP. Webview issues don't show up in Chrome.
4. Real decks: the author's two courses are *not* in the repo (private teaching material). Ask for the zips if needed.
   Typical checks are "all frames render with 0 notes" (`npm run export -- main.tex --document`) and "all snippets compile" (`--snippets`).

## Pitfalls found the hard way

- **Windows Git Bash mangles backslashes** in heredocs, `sed` and inline `node -e`/`python -c`; `\\` collapses.
  For edits containing LaTeX or regex backslashes, use the Edit/Write tools or a script file, not shell one-liners.
- Docker from Git Bash: use `MSYS_NO_PATHCONV=1` for container paths. From Node `spawn` (as the code does) this is not needed.
- **Never use recursive `TEXINPUTS` (`//`) over a Docker bind mount**: every package lookup scans the tree, so minutes instead of seconds.
  The engine mounts the document root and lists the needed folders non-recursively.
- Snippets are standalone documents, *not* beamer. Overlay commands must be expanded first (`overlays.js`, one compile per step),
  and metropolis' implicit `pgfplotsthemetol` (`mlineplot`) must be loaded explicitly.
- `standalone` with `varwidth` does not shrink-wrap TikZ. Use plain `standalone` for pictures and `varwidth` only for algorithms.
- pdf.js refuses concurrent `render()` calls on one canvas. They are serialised per canvas in `preview.js`.
  In webviews the worker must be loaded from a blob URL.
- Font switches (`\large`, `\color`, `\bfseries`) wrap the *rest of the group* in `display:contents` spans.
  A switch before the first `\item` must style the whole list.
- `\pause` inside a nested group or environment must also hide what follows it (`afterPause`).
- The snippet cache key is a hash of the full generated document (preamble included). Failures are cached as `*.failed`
  next to `*.failed.tex`/`.log`, and **Clear LaTeX Snippet Cache** removes them.
- Pushing: Claude has no GitHub credentials here. Commit and tag locally; the author pushes (TortoiseGit, "Include Tags").

## Ideas not done yet

- TikZ placeholder approximations without Docker (e.g. draw simple node graphs in SVG).
- Other beamer themes (only metropolis styling exists; other themes render as metropolis).
- `\cite`/bibliography rendering, `\tableofcontents`, `\framebreak`/`allowframebreaks` splitting.
- Publishing to the VS Code Marketplace (publisher id `jplatos` is set; needs a PAT and `vsce publish`).
