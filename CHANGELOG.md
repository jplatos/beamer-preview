# Changelog

## 0.2.0 — 2026-10-06

Snippet engine (TikZ / pgfplots / algorithm2e):

- Clear diagnostics: errors go to the **Beamer Preview** output channel, a status-bar item and a warning, and are shown on the placeholder.
- New command **Beamer: Check LaTeX Snippet Engine**.
- Detects when Docker is missing or not running, when an image pull fails, and when Docker cannot mount a folder.
- Pulls the image with progress on first use, and retries automatically instead of giving up for the whole session.
- Runs the container as the current user on Linux/macOS.
- Mounts the project only when a snippet reads files.
  Root-relative `\input`, images and pgfplots `table {…}` files now resolve without slow recursive searches.
- The `local` engine now runs `pdflatex` directly instead of through a shell loop. The binary is configurable via `snippets.latexCommand`.
- Beamer overlays inside TikZ (`\visible<2>{…}`, `\only`, `\uncover<+->`, `\alt`, `\pause`) are compiled once per step and switched in the preview.
- Loads metropolis' pgfplots theme (`mlineplot`, …), and only uses Fira Sans when the TeX installation has it.

Renderer:

- `lstlisting` options (`language`, `basicstyle` size, `keywordstyle` colour) with keyword, comment and string highlighting; also `minted`, `\lstinputlisting` and `\lstset`.
- Enumerate mini-templates such as `[ {[}1{]} ]` and `[(a)]`.
- Image names containing dots (`figure.drawio` → `figure.drawio.pdf`).
- `\setlength{\tabcolsep}` in tables; `\todo` and `\missingfigure` are shown as notes.
- `\pause` inside a list also hides what follows the list.
- Enumerate numbering follows enumerate depth.
- Footnotes in columns are lettered and placed under the column.

## 0.1.0 — 2026-10-05

First release.

- Compile-free HTML rendering of beamer/metropolis frames: title page, section pages, frame titles, progress bar, standout frames.
- Lists, columns, blocks, tables, floats, footnotes, verbatim, links; user macros and environments.
- KaTeX math; PNG/JPG/SVG and PDF (pdf.js) images; `\animategraphics`.
- Overlays (`\pause`, `\only`, `\uncover`, `\alt`, `\item<>`, `[<+->]`, …) with per-slide step selection and an "every step" mode.
- Live update from unsaved buffers, cursor sync, click-to-source, lecture mode for `\subimport`ed files, present mode.
- Background LaTeX rendering (Docker or local `pdflatex`) for TikZ, pgfplots and algorithm2e, cached by content hash.
- `cli.js` static HTML export.
