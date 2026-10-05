# Changelog

## 0.1.0 — 2026-10-05

First release.

- Compile-free HTML rendering of beamer/metropolis frames: title page, section pages, frame titles, progress bar, standout frames.
- Lists, columns, blocks, tables, floats, footnotes, verbatim, links; user macros and environments.
- KaTeX math; PNG/JPG/SVG and PDF (pdf.js) images; `\animategraphics`.
- Overlays (`\pause`, `\only`, `\uncover`, `\alt`, `\item<>`, `[<+->]`, …) with per-slide step selection and an "every step" mode.
- Live update from unsaved buffers, cursor sync, click-to-source, lecture mode for `\subimport`ed files, present mode.
- Background LaTeX rendering (Docker or local `pdflatex`) for TikZ, pgfplots and algorithm2e, cached by content hash.
- `cli.js` static HTML export.
