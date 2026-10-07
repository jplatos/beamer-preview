# Development

## Prerequisites

| Tool | Needed for |
|---|---|
| Node.js 22+ (see `.nvmrc`) | everything |
| VS Code 1.85+ | running/debugging the extension |
| Chrome or Edge (or `CHROME_PATH`) | screenshots and visual comparison |
| Docker | TikZ/algorithm snippets and the visual comparison (xelatex + ghostscript in `texlive/texlive`) |

There is no build step: the extension is plain CommonJS JavaScript.

```sh
git clone git@github.com:jplatos/beamer-preview.git
cd beamer-preview
npm install
npm test
```

## Run and debug

Open the folder in VS Code and press **F5** (*Run Extension*, see `.vscode/launch.json`).
This opens a second VS Code window on `examples/demo` with the extension loaded.
Open a `.tex` file there and press `Ctrl+K B`.

The extension logs to the **Beamer Preview** output channel. Webview errors are forwarded there as well.

## Checks

| Command | What it does | Needs |
|---|---|---|
| `npm test` | Smoke and unit tests on `examples/demo` and in-memory documents | Node |
| `npm run test:vscode` | Real VS Code (downloaded into `.vscode-test/`): opens the demo and the preview, checks that PDFs and fonts load, cursor sync and live edit, runs the snippet engine check, then clears the snippet cache and checks that freshly compiled snippets load (`pdfFail` in the webview stats). Close all other VS Code windows first: VS Code refuses to run extension tests next to a running instance | Node, Docker (set `BEAMER_PREVIEW_NO_SNIPPETS=1` to skip the snippet parts) |
| `npm run compare -- examples/demo/main.tex --snippets` | **Visual comparison with real LaTeX.** Compiles with xelatex, rasterises the pages, screenshots every preview slide (one per overlay step) and writes `compare-out/compare.html` side by side, reporting page-count mismatches | Docker, Chrome |
| `npm run export -- file.tex -o out.html [--document] [--snippets]` | Static HTML of the preview | Node |
| `npm run screenshots -- out.html shots/ [last\|first\|all]` | PNG per slide | Chrome |
| `node test/dump.js file.tex "Frame title"` | Prints the generated HTML of matching frames | Node |
| `node test/probe.js out.html "return …"` | Evaluates JS in the exported page (measure layout, find elements) | Chrome |

The comparison is the main quality check. Use it on real decks too: `npm run compare -- path/to/main.tex --focus path/to/lecture.tex`.
For a deck that already has a PDF, pass `--pdf deck.pdf` to skip the xelatex run.
The first page-count mismatch usually points to an overlay or frame-splitting bug.

## Adding support for a LaTeX command

1. Find where it belongs in `src/render.js`:
   - simple wrappers go in `FONT_WRAP`;
   - font/size switches go in `SWITCHES` and `SIZES`;
   - text symbols go in `SYMBOLS`;
   - commands to swallow (with N arguments) go in `IGNORE`;
   - anything else gets a `case` in `command()` or, for environments, in `environment()`.
2. Read arguments on demand with `readArg`, `readOpt`, `readOverlay` and `readStar`.
   Convert token arrays with `this.convert(toks, ctx)`.
3. Add CSS to `media/metropolis.css`, in TeX points.
4. Add a test to `test/smoke.js`. `memDoc(String.raw`…frame source…`)` renders an in-memory document; extra files can be passed as a map.
5. Check visually with `npm run compare`.

Unknown commands show up as "notes" in the preview toolbar and in the CLI output. That is the quickest way to find what a new deck needs.

## Release

1. Bump `version` in `package.json` (`npm install --package-lock-only` updates the lock file).
2. Add a section to `CHANGELOG.md`.
3. Commit, create an annotated tag `vX.Y.Z`, and push the branch **and the tag**.
4. GitHub Actions (`.github/workflows/ci.yml`) runs the tests and the VS Code integration test, packages the VSIX and publishes a GitHub Release with it.

`npm run package` builds the VSIX locally. `.vscodeignore` is an allow-list for `node_modules`; in vsce, `!` patterns override later excludes, so whitelist exact files.
