# Closer

> Click any image to view it full size. Closer knows which images are worth opening.

**English** · [简体中文](README.zh_CN.md)

Click any image and it opens at full size, from where it already sits. A Chrome extension that knows which images are worth opening.

Site: <https://closer-viewer.vercel.app/> (source in `docs/index.html`; Vercel publishes `docs/` from `main`, see D40)

Status: **v0.1 is feature complete, and everything a machine can check is green.** The judge, yield detection, the byte channel, the viewer layer, copy and save are all in place; `smoke` passes 83/83, `live` has been re-run across all three suites, and the permission chain has been walked on a real machine. Store assets — screenshots, promo images, listing copy — come out of `npm run promo` and `store/listing.md`. What is left is 15 of the 18 manual checks, and uploading them to the store console.

## Install

No build step — the extension *is* the repository.

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked** → select the repo root (or unpack `.temp/closer-<version>.zip` from `npm run pack`).
3. A welcome page opens and asks for site access. Nothing is granted at install time: the manifest requests only `storage`, `scripting` and `activeTab`, and `*://*/*` is an *optional* host permission. Until you grant it on that page no content script is registered, and clicking an image does nothing.
4. A tab that was already open when you granted access starts working as it is; refresh it only if you want a control case.

Editing source takes effect after the refresh button on the extensions page.

## What runs today

| Command | What it proves |
| --- | --- |
| `npm run verify` | Six checks in one command: manifest references, the permission allowlist plus the code-size budget (effective code — comments do not count) and the load-time listener count, the syntax of every shipped file, both locale catalogs (42 strings each, compared in both directions), the judge's 38 rules, 31 assertions on dimensions and file names — and then `pack --check` re-derives the release list. |
| `npm run smoke` | Five real-browser suites, 83 assertions: the overlay opens and the DOM is restored byte for byte on close, yield detection, the stacked viewer, the speed budget, and E11 — install **the 24 files that actually ship** (not the repo root) and ask Chrome whether the extension really runs. |
| `npm run live` | The real extension against real pages: the full path on live sites (25 assertions, needs network), three backdrops plus panel theming (25), preference wiring and narrow-viewport centering (9). |
| `node tools/lab/e2-drift.mjs` | Whether the hit-point criterion drifts while the image is moving — 480 comparisons, 0 drift. |
| `node tools/lab/e3-pollution.mjs` | Whether a cross-origin image routed through a blob still taints the canvas — it does not, so copying works. |
| `npm run pack` | Pick out the part that ships and zip it into `.temp/closer-<version>.zip`: the manifest is derived from the import graph rather than hand-written, and the archive is unpacked and compared right after writing, so the same source always yields the same sha256. |
| `npm run promo` | Generate store assets: 5 × 1280×800 screenshots per language plus 440×280 and 1400×560 promo tiles. Output lands in `store/` and stays out of git; the script does not. |

`verify` needs no browser, and prints the budget as it runs: **37.7 KB of effective code against 44 KB** — comments (34.7 KB) and blank lines are excluded, no single file may take more than half the total (22 KB), and the raw source is 72.3 KB. It also holds the release list to 24 files (101.0 KB uncompressed) and page-load listeners to 3 of 3.

The other scripts each launch a **headless Chrome owned by that process** (system-assigned port, throwaway profile, stub servers on free ports — see `tools/lab/browser.mjs`): no window, so it never steals input or desktop focus, and **several can run at once** — different worktrees running different code keep their own extension, ports and scratch directories without touching each other. Everything is reclaimed when the process exits; orphans left behind by `kill -9` are swept by the next start, or by hand with `node tools/lab/browser.mjs sweep`.

To watch a run, point at a windowed instance explicitly: `CDP=http://127.0.0.1:9333 npm run smoke`. That falls back to a shared browser, where the suites clean up each other's extensions, so don't run them in parallel. `e5` drives real sites and needs network.

---

## Why this is not just another image viewer

Chrome ships an image viewer. A dozen extensions ship one, and one of them already does dimensions, EXIF and rotation well. The fifteenth is not a product.

What is missing is **judgement**: on a page Closer has never seen, in front of forty images, knowing which one the user just clicked. The overlay is the easy half — and the only half anyone can copy. The judge is the half worth building, which is why everything else in this repo is written to protect it.

## Read in this order

| File | What it settles |
| --- | --- |
| [`CONSTITUTION.md`](CONSTITUTION.md) | Ten articles written to end arguments: don't interrupt, the page owns the page, a budget is a number and not a feeling, elegance is subtraction. Each carries a test that can fail. |
| [`docs/design-v0.1.md`](docs/design-v0.1.md) | The actual v0.1: permission model, click contract, yield detection, the ordered signal table, overlay and info panel spec, architecture, and the manual acceptance criteria. |
| [`docs/tech-spec.md`](docs/tech-spec.md) | Implementation level: module contracts, state machine, coordinate math, yield detection in practice, the byte channel, the viewer layer (event ownership, rendering, focus), the copy and save paths, MV3 pitfalls. The last three experiments had to pass before any code was written. |
| [`docs/decisions.md`](docs/decisions.md) | What is locked and why, how the disagreements converged, and what has already been rejected — written down so it does not come back. |
| [`docs/cases.md`](docs/cases.md) | Every real misjudgement, **including the ones we cannot fix**. `test-judge` is the shadow of the rules; only this table comes from the world. |
| [`docs/manual-check.md`](docs/manual-check.md) | The eighteen things automation cannot test: permission prompts, the clipboard, yield on real sites. Install once, five minutes. |
| [`docs/STATUS.md`](docs/STATUS.md) | Where the work actually stands — the single source of truth for progress. |
| [`https://closer-viewer.vercel.app/privacy`](https://closer-viewer.vercel.app/privacy) | The page the store requires: what this thing actually does with data. The source lives in `docs/`, and every sentence in it maps to something in the code. |

The design documents are written in Chinese, the project's working language. Code, UI strings and commit subjects are English.

## In one paragraph

On by default everywhere, off per site. Click an image and it flies out of its own thumbnail, unfolding in place; wheel to zoom, drag to pan. A ⓘ in the top-left corner (the `·` key does the same) reveals what the image actually is — native pixels against the pixels the page drew, aspect ratio, megapixels, format, file size. Three actions top-right: copy, save, close, with `⌘/Ctrl + C` and `⌘/Ctrl + S` as equivalents, and a line at the bottom to confirm. Sites without a viewer, we appear; sites with their own, we step aside. No network request beyond reading the image you are already looking at, no `downloads` permission, no host permission — until you press that button. No telemetry, no build step, no third-party framework. The interface is English and Chinese, chosen by browser language, with no toggle to get wrong.

## License

MIT. Use it commercially, change it, fork it — keep the copyright notice.

The license grants no trademark, so the name "Closer" stays with the author: if someone did ship a malicious build of this code, what stops them is the store listing and the name, not the license.
