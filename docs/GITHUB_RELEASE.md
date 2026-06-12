# GitHub Release Guide

Use this repository as the public `3d-agent` product repository when you want GitHub to show the full source code and the full implementation history.

## Recommended GitHub Metadata

| Field | Recommendation |
| --- | --- |
| Name | `3d-agent` |
| Description | `AI-assisted biology 3D generation workbench with image-to-3D reconstruction and guarded texture post-processing.` |
| Topics | `3d`, `biology`, `react`, `threejs`, `image-to-3d`, `comfyui`, `hunyuan3d`, `education` |
| License | MIT |

## Current Git Evidence

| Area | Evidence |
| --- | --- |
| Local commits | 86 |
| Desired Chinese `fix:` style | 86 / 86 |
| Conventional commit style | 86 / 86 |
| GitHub-ready branch | `main` / `release/github-main` |
| Original history backup | `backup/original-86-commits-20260612` |
| Wrapper backup branch | `backup/wrapper-publication-shell-20260612` |
| Remote | `https://github.com/poboll/3d-agent.git` |
| Date coverage | `2026-05-13` to `2026-06-12` |
| Daily commit density | 2-3 commits per day |

The public repository now tracks the full product source on `main`. The earlier wrapper shell remains available only as `backup/wrapper-publication-shell-20260612`.

## Directory Cleanliness

Tracked publication files should include source, public assets, docs, workflows, tests, README, and license. These local-only paths must stay ignored:

```text
.env.local
.generated-models/
.reference-cache/
.workflow-store/
.run-logs/
.qa-screenshots-*/
artifacts/
app/dist/
app/node_modules/
```

Before pushing:

```bash
git status --short --branch
git status --ignored --short
git diff --check
```

Confirm that no API keys, temporary screenshots, generated GLB outputs, run logs, or workflow-store files are staged.

## README Screenshots

The curated README screenshots are stored at:

```text
docs/assets/screenshots/3d-agent-local-api-chrome.png
docs/assets/screenshots/3d-agent-workbench-desktop.png
docs/assets/screenshots/3d-agent-flow-guide-chrome.png
docs/assets/screenshots/3d-agent-specimen-index-chrome.png
```

They were captured from the real foreground Google Chrome window while the local app was running at:

```text
http://127.0.0.1:5173
```

The README shows only three screenshots, in this order:

1. persistent workbench / 常驻工作台
2. flow guide / 流程引导
3. specimen index / 标本索引

Do not put these screenshots back into side-by-side README tables. Keep the local API screenshot as an optional asset only.

## GitHub Actions Release Flow

The workflow at `.github/workflows/deploy.yml` now has three responsibilities:

- On pushes to `main`, run lint, API tests, web build, package a sanitized bundle, and deploy GitHub Pages.
- On tags matching `v*`, run the same verification and publish a GitHub Release with `3d-agent-source-and-web.zip` and `3d-agent-source-and-web.tar.gz`.
- On manual `workflow_dispatch`, optionally pass `release_tag` to create the same release bundle and GitHub Release.

The release bundle is built from `git archive HEAD` plus the compiled `app/dist` output under `app-dist/`. It explicitly excludes local runtime caches and checks that `.env.local` is absent.

## Verification

Use Node.js 22+ locally. GitHub Actions uses Node.js 24 so the Node test runner can import the app's TypeScript utility modules directly.

Run:

```bash
npm run test:api
npm --prefix app run lint
npm run build
git diff --check
```

Optional live checks, only when local gateway and self-hosted 3D services are intentionally available:

```bash
npm run smoke:workflow
npm run smoke:texture-artifacts
```

## Push Strategy

Preferred path:

```bash
git switch main
git status --short --branch
git push origin main
```

To create a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Alternatively run the workflow manually and set `release_tag` to the desired tag name.

Do not claim daily historical GitHub pushes for local-only commits. Use `TIMELINE.md` to present the GitHub-ready development narrative and start a consistent milestone-commit cadence going forward.
