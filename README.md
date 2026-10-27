# Closer

> Click any image to view it full size. Closer knows which images are worth opening.

**English** · [简体中文](README.zh_CN.md)

Click any image and it opens at full size, from where it already sits. A Chrome extension that knows which images are worth opening.

Status: **v0.1 is feature complete.** The judge, yield detection, the byte channel, the viewer layer, copy and save are all in place; static checks and smoke tests pass. What remains is regression on real sites and performance measurement.

## Install

No build step — the extension *is* the repository.

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked** → select the repo root.
3. A welcome page opens and asks for site access. Nothing is granted at install time: the manifest requests only `storage`, `scripting` and `activeTab`, and `*://*/*` is an *optional* host permission. Until you grant it on that page no content script is registered, and clicking an image does nothing.
4. A tab that was already open when you granted access starts working as it is; refresh it only if you want a control case.

Editing source takes effect after the refresh button on the extensions page.

## What runs today

| Command | What it proves |
| --- | --- |
| `npm run verify` | Six checks in one command: manifest references, the permission allowlist and size budget, the syntax of every shipped file, both locale catalogs (42 strings each, compared in both directions), the judge's 38 rules, 31 assertions on dimensions and file names. |
| `npm run smoke` | Four real-browser suites, 73 assertions: the overlay opens and the DOM is restored byte for byte on close, yield detection, the stacked viewer, the speed budget. |
| `npm run live` | The real extension against real pages: end-to-end on live sites (needs network), three backdrops plus panel theming (25 assertions), preference wiring and narrow-viewport centering (9 assertions). |
| `node tools/lab/e2-drift.mjs` | Whether the hit-point criterion drifts while the image is moving — 480 comparisons, 0 drift. |
| `node tools/lab/e3-pollution.mjs` | Whether a cross-origin image routed through a blob still taints the canvas — it does not, so copying works. |

`verify` needs no browser, and prints the content-side budget while it runs: **70.5 KB of 72 KB**, 38 top-level declarations out of 9 injected files. The other scripts each launch a **headless Chrome owned by that process** (system-assigned port, throwaway profile, stub servers on free ports — see `tools/lab/browser.mjs`): no window, so it never steals input or desktop focus, and **several can run at once** — different worktrees running different code keep their own extension, ports and scratch directories without touching each other. Everything is reclaimed when the process exits; orphans left behind by `kill -9` are swept by the next start, or by hand with `node tools/lab/browser.mjs sweep`.

To watch a run, point at a windowed instance explicitly: `CDP=http://127.0.0.1:9333 npm run smoke`. That falls back to a shared browser, where the suites clean up each other's extensions, so don't run them in parallel. `e5` drives real sites and needs network.

---

## Why this is not just another image viewer

Chrome ships an image viewer. A dozen extensions ship one, and one of them already does dimensions, EXIF and rotation well. The fifteenth is not a product.

What is missing is **judgement**: on a page Closer has never seen, in front of forty images, knowing which one the user just clicked. The overlay is the easy half — and the only half anyone can copy. The judge is the half worth building, which is why everything else in this repo is written to protect it.

## Read in this order

| File | What it settles |
| --- | --- |
| [`CONSTITUTION.md`](CONSTITUTION.md) | Ten articles written to end arguments: don't interrupt, the page owns the page, speed is a budget, elegance is subtraction. Each carries a test that can fail. |
| [`docs/design-v0.1.md`](docs/design-v0.1.md) | The actual v0.1: permission model, click contract, yield detection, the ordered signal table, overlay and info panel spec, architecture, and the manual acceptance criteria. |
| [`docs/tech-spec.md`](docs/tech-spec.md) | Implementation level: module contracts, state machine, coordinate math, yield detection in practice, the byte channel, the viewer layer (event ownership, rendering, focus), the copy and save paths, MV3 pitfalls. |
| [`docs/decisions.md`](docs/decisions.md) | What is locked and why, how the disagreements converged, and what has already been rejected — written down so it does not come back. |
| [`docs/cases.md`](docs/cases.md) | Every real misjudgement, **including the ones we cannot fix**. `test-judge` is the shadow of the rules; only this table comes from the world. |
| [`docs/manual-check.md`](docs/manual-check.md) | The eighteen things automation cannot test: permission prompts, the clipboard, yield on real sites. Install once, five minutes. |
| [`docs/STATUS.md`](docs/STATUS.md) | Where the work actually stands — the single source of truth for progress. |

The design documents are written in Chinese, the project's working language. Code, UI strings and commit subjects are English.

## In one paragraph

On by default everywhere, off per site. Click an image and it flies out of its own thumbnail, unfolding in place; wheel to zoom, drag to pan. A ⓘ in the top-left corner (the `·` key does the same) reveals what the image actually is — native pixels against the pixels the page drew, aspect ratio, megapixels, format, file size. Three actions top-right: copy, save, close, with `⌘/Ctrl + C` and `⌘/Ctrl + S` as equivalents, and a line at the bottom to confirm. Sites without a viewer, we appear; sites with their own, we step aside. No network request beyond reading the image you are already looking at, no `downloads` permission, no host permission — until you press that button. No telemetry, no build step, no third-party framework. The interface is English and Chinese, chosen by browser language, with no toggle to get wrong.

## License

MIT. Use it commercially, change it, fork it — keep the copyright notice.

The license grants no trademark, so the name "Closer" stays with the author: if someone did ship a malicious build of this code, what stops them is the store listing and the name, not the license.
