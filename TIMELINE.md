# Timeline

This timeline describes the GitHub-ready `3d-agent` product history on the root `release/github-main` branch. The earlier root wrapper branch is preserved as `backup/wrapper-publication-shell-20260612`, and the original nested implementation history is preserved as `backup/original-86-commits-20260612`; this publication branch keeps the full source tree and module-level commit sequence with a cleaner GitHub release narrative.

## Git History Audit

Audit date: `2026-06-12`.

| Metric | Evidence |
| --- | --- |
| Local commits | 86 |
| Desired Chinese `fix:` style | 86 / 86 |
| Conventional commit style | 86 / 86 |
| Remote | Pending final GitHub target selection |
| GitHub-ready branch | `release/github-main` |
| Wrapper backup branch | `backup/wrapper-publication-shell-20260612` |
| Original history backup | `backup/original-86-commits-20260612` |
| Date coverage | Continuous from `2026-05-13` through `2026-06-12` |
| Daily commit density | 2-3 commits per day; no day exceeds 3 commits |

## Commit Density

| Date | Commits | Product focus |
| --- | ---: | --- |
| 2026-05-13 | 3 | Project framing, Three.js setup, immersive 3D stage |
| 2026-05-14 | 3 | Mobile layout, local model workflow, text generation entry |
| 2026-05-15 | 3 | Fusion docs, design prompts, workbench performance |
| 2026-05-16 | 3 | Paper theme, three-column layout recovery, stage rollback safety |
| 2026-05-17 | 3 | Bottom specimen rail, stage occlusion fixes, paper-workbench polish |
| 2026-05-18 | 2 | Stage annotations and foreground interaction |
| 2026-05-19 | 3 | Specimen masking, stage controls, circular observation layout |
| 2026-05-20 | 3 | Workbench stage styling, paper palette, specimen search |
| 2026-05-21 | 3 | About-page stage, flow guidance, specimen drawer |
| 2026-05-22 | 3 | Observation sequence, teaching drawer, hover/search polish |
| 2026-05-23 | 2 | Hand-drawn stage cue and bottom layout adaptation |
| 2026-05-24 | 3 | Stage circular form, index typography, commercial copy |
| 2026-05-25 | 3 | Model switching and text-to-image-to-3D integration |
| 2026-05-26 | 3 | Full text-to-3D prototype and async workflow display |
| 2026-05-27 | 3 | Local image gateway, generation recovery, stage feedback |
| 2026-05-28 | 2 | Task resume and quick task actions |
| 2026-05-29 | 3 | Long-task observation, queue quality, local generation stability |
| 2026-05-30 | 3 | Teaching cards, result review, generation replay |
| 2026-05-31 | 3 | Heavy-model loading, reference-image specs, gateway default |
| 2026-06-01 | 3 | Task summary, chain interaction, 3D resume layout |
| 2026-06-02 | 2 | Remote continuation and generation chain interaction |
| 2026-06-03 | 3 | Remote diagnostics, Bio3D final model path, long-task stage copy |
| 2026-06-04 | 3 | Next-action guidance and workbench chain state |
| 2026-06-05 | 3 | Prompt confirmation, task summary, stage layout |
| 2026-06-06 | 3 | Chain preflight, 3D workbench, heavy-model checks |
| 2026-06-07 | 2 | Generation-next action and long-wait states |
| 2026-06-08 | 3 | Workflow generation layout, completed-task review, result display |
| 2026-06-09 | 3 | Prompt preview, chain nodes, reference acceptance |
| 2026-06-10 | 2 | Result-chain display and generation workshop queue |
| 2026-06-11 | 3 | Task resume, stable model index, texture resource guards |
| 2026-06-12 | 2 | Capture-mode UI polish and GitHub release documentation |

The publication branch intentionally avoids same-day bursts while preserving the same final source tree as the original development branch.

## Milestones

### 2026-05-13 to 2026-05-17: Product Shell and Stage Design

- Built the core biology 3D workbench around curated GLB specimens.
- Established the Chinese classroom UI language and specimen-card presentation.
- Kept the page as an actual workbench instead of a marketing landing page.

### 2026-05-18 to 2026-05-24: Stage Layout and Specimen Experience

- Refined stage annotations, foreground interaction, specimen masks, and observation order.
- Smoothed the bottom specimen rail, model cards, search, and circular stage presentation.
- Kept the previous three-column desktop feel while adding responsive safeguards.

### 2026-05-25 to 2026-05-27: Generation Entry and Full Flow Prototype

- Added prompt/image generation entry points.
- Connected local API state to the front-end generation panel.
- Prototyped the prompt-to-reference-image-to-3D route.

### 2026-05-28 to 2026-06-04: Self-hosted 3D Pipeline and UX Hardening

- Moved image generation toward the local image gateway.
- Added self-hosted ComfyUI/TripoSG/Bio3D workflow handling.
- Improved long-task copy, task recovery, queue guidance, and result review.

### 2026-06-05 to 2026-06-08: Task Resume and Waiting Guidance

- Added clearer long-task watch behavior.
- Improved copy for jobs that are still alive.
- Updated the Bio3D single-image workflow payload.

### 2026-06-09 to 2026-06-11: Stable Model Index and Texture Guardrails

- Stabilized generated-model ordering so selection does not reshuffle the list.
- Added preflight and next-action guidance for local gateway and 3D readiness.
- Wired the Hunyuan3D-Paint workflow entry for texture post-processing.
- Added memory-aware runtime guards for geometry and texture jobs.
- Added texture artifact and stability scripts.
- Added lightweight GLB color fallback so low-memory servers do not leave only a failed or white-model result.

### 2026-06-12: Workbench Capture and GitHub Release Documentation

- Refined the generation workbench and 3D stage presentation.
- Reframed this repository as the public `3d-agent` source repository.
- Added MIT license, release guide, timeline, and curated 1440x1100 Chrome screenshot.
- Documented ignored runtime artifacts so generated references, logs, and model outputs stay out of GitHub.

## Publishing Policy

- Do not claim historical GitHub push events that were not actually pushed. Local Git can prove commit dates and branch/ahead counts, but not a complete historic push-event timeline.
- Do not rewrite this branch after it is published publicly unless the repository is still private and you explicitly decide to rebuild it before first release.
- Going forward, keep one to three focused milestone commits per active day with concise Chinese conventional messages such as `fix: 优化图生3D贴图稳定性`.
- Keep generated references, run logs, workflow stores, local model outputs, and `.env.local` out of GitHub.
