---
name: "TrailTemps workspace instructions"
description: "Guidance for Copilot Chat in the TrailTemps static-site repo. Includes repo layout, conventions, and common tasks."
---

## Purpose

This file bootstraps workspace-level agent behavior for the TrailTemps project. It helps Copilot Chat understand repository structure, conventions, and priorities with minimal onboarding friction.

## Project overview

- Static website for hiking trail weather normals/historical data.
- Root assets: `index.html`, `css/`, `images/`, `assets/`, `scripts/`.
- Trail-specific pages and data under `trails/<trail-name>/`.
- Data files in `trails/*/data/` and JS apps in `trails/*/js/`.
- Generated/historical data scripts in `trails/*/tools/`.

## Existing structure

- No root `README.md` or Node scripts in this repo (pure-file static site + local tools).
- Key directories:
  - `trails/` (trail pages, historical data, code)
  - `css/` (styles)
  - `scripts/` (utilities for data migration/normal generation)

## Ask quickly

Use these short prompts to get help from the agent:

1. "How do I add a new trail page with normalized weather data?"
2. "What is the format for `trails/<trail>/data/points.json` and how do I regenerate it?"
3. "Help me fix a JavaScript issue in `trails/florida-trail/js/app.js`."
4. "Summarize data pipeline in `trails/appalachian-trail/tools/` and the script to update normals."

## Workflow (from init.prompt instructions)

1. Discover existing conventions:
   - Search for `.github/copilot-instructions.md`, `AGENTS.md`, and other agent customization files.
   - If none, initialize one here.
2. Explore codebase:
   - Identify build/test commands (none currently; static site is likely served directly).
   - Identify architecture boundaries: front-end UI code, trail datasets, migration scripts.
   - Identify edge cases in data conversion scripts and point geometry normalization.
3. Generate or merge:
   - Create or update workspace instruction file with high-level guidance.
   - Preserve existing content where relevant; keep minimal duplicate docs.
4. Iterate:
   - Ask user for clarifications when missing details.
   - Suggest file-scoped instruction sets as needed (e.g., `trails/**.instructions.md`).

## Priorities for contributions

- Keep static content and data separate.
- Prefer minimal DOM and data transformations in `trails/*/js/app.js`.
- Preserve historical archives under `trails/*/data/archive/`.

## Optional follow-up customizations

- Create file-scoped instructions for `trails/*/tools/` data scripts.
- Add prompt templates in `.github/prompts` (or user scope) for dataset updates.
- Add an agent at `.github/agents/` for multi-step data migration checklists.
