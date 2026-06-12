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
| GitHub-ready branch | `release/github-main` |
| Original history backup | `backup/original-86-commits-20260612` |
| Wrapper backup branch | `backup/wrapper-publication-shell-20260612` |
| Remote | Pending final GitHub target selection |
| Date coverage | `2026-05-13` to `2026-06-12` |
| Daily commit density | 2-3 commits per day |

The root `/Users/Apple/Developer/art/3d-agent` repository now has a GitHub-ready `release/github-main` branch with the full product source and the curated 86-commit implementation timeline. The earlier 7-commit wrapper shell remains available only as `backup/wrapper-publication-shell-20260612`.

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

## README Screenshot

The curated screenshot is stored at:

```text
docs/assets/screenshots/3d-agent-workbench-desktop.png
```

It was captured with Google Chrome/CDP from:

```text
http://127.0.0.1:<frontend-port>/?capture=readme#workbench
```

The release capture currently uses a 1440x1100 Chrome desktop viewport, matching the original desktop QA ratio while README capture mode keeps the 3D stage visually stable without creating a headless WebGL context.

## Verification

Run:

```bash
npm run test:api
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
git switch release/github-main
git status --short --branch
git remote set-url origin git@github.com:<owner>/3d-agent.git
git push -u origin release/github-main:main
```

Use this direct push only before the first public release or when you explicitly decide this branch should become the public `main` branch. Otherwise push it as a review branch and open a pull request into `main`.

Do not claim daily historical GitHub pushes for local-only commits. Use `TIMELINE.md` to present the GitHub-ready development narrative and start a consistent milestone-commit cadence going forward.
