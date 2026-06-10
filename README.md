# Mercor Studio — Rubric Sync

A Chrome (Manifest V3) extension that lets you **bulk-edit Build Rubric criteria
from a JSON file** on Mercor Studio task pages
(`https://studio.mercor.com/annotator/tasks/<id>`), instead of clicking through
the UI one criterion at a time.

It adds two buttons to the *Step 3 · Build Rubric* section header:

- **⤒ Export Rubric** — saves the current rubric as JSON grouped by category:
  `{ "reasoning": [...], "completeness": [...], "style": [...] }`.
- **⤓ Import Rubric** — loads a JSON file and reconciles it against the page
  (add / update / delete), then writes the file back so it mirrors the browser.

---

## Install

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the `mercor-rubric-sync` folder.
4. Open a task page — you'll see **⤓ Import Rubric** and **⤒ Export Rubric** in
   the Build Rubric section header.

> Requires a Chromium-based browser (Chrome/Edge). Write-back uses the
> File System Access API.

---

## How to use

### Export

1. Open a task and the *Step 3 · Build Rubric* section.
2. Click **⤒ Export Rubric** and choose where to save.
3. You get a `rubric.json` grouped by category — edit it in any editor.

### Import

1. Click **⤓ Import Rubric** and pick your JSON file.
2. The extension reconciles each criterion against the page:

   | Criterion state                      | Action                                             |
   |--------------------------------------|----------------------------------------------------|
   | matches a row (by id or description) | **Update** Description, Rationale, Weight          |
   | in JSON, not on the page             | **Add** via that category's *Add criterion* button |
   | on the page, not in JSON             | **Delete** that row                                |

3. A status panel (bottom-right) logs every add/update/delete and auto-closes
   when done.
4. When Chrome asks **"Save changes to this file?"**, allow it — the file is
   rewritten (in the same shape it was read) with the live, tool-assigned ids.
5. Review the rows, then click **Submit for Review** yourself. *(The extension
   never submits for you. Studio autosaves the rubric.)*

### JSON format

Import accepts any of: a **flat array**, `{ "criteria": [...] }`, or the
**grouped** form. Export always writes the grouped form. See `sample-rubric.json`.

```json
[
  {
    "id": "reasoning-5ayacj",          // matched against the page (optional for new ones)
    "category": "reasoning",           // reasoning | completeness | style
    "description": "....",
    "rationale": "....",               // optional
    "weight": "critical"               // critical | bonus | penalty
  }
]
```

- **`id`** is matched first. New criteria without a matching id are added, then
  the file is rewritten with the real ids.
- **`category`** chooses which *Add criterion* button to use. In grouped JSON
  it's taken from the group key; otherwise it's inferred from the id prefix
  (`reasoning-…` → `reasoning`).
- Matching falls back to **description text** when ids don't line up, so
  re-importing the same file is idempotent.

---

## Architecture

A single content script, injected into the page's **MAIN world** (so it can use
React's native input setter and the File System Access API directly).

```
manifest.json   MV3 config — runs content.js on studio.mercor.com/annotator/tasks/*
content.js      all logic (see flow below)
styles.css      button + status-panel styling
sample-rubric.json   example input
```

**Runtime flow**

```
MutationObserver  ─►  injectButton()       add Import/Export buttons to the
(SPA-safe)                                  Build Rubric header

Export click  ─►  exportRubric()      read rows per <section> → grouped JSON
              └►  showSaveFilePicker() write file (fallback: download)

Import click  ─►  showOpenFilePicker(readwrite)   pick + read JSON
              └►  normalizeInput()     flat array | {criteria} | grouped → flat list
              └►  sync():
                    1. snapshot existing rows  (id + description)
                    2. match each item  (by id, then by description)
                    3. DELETE unmatched rows
                    4. UPDATE matched rows / ADD new ones via "Add criterion"
                    5. re-read live ids from the DOM
                    6. serialize() back to the file's original shape  ─► write-back
```

**How it reads the DOM** (all centralised in the `CONFIG` block + finder helpers
at the top of `content.js`, so it's easy to retarget if the page changes):

- Each category is a `<section>` with an `<h3>` (`reasoning` / `completeness` /
  `style`) and its own *Add criterion* button.
- A criterion row is `div.rounded-md.border.p-3` containing a `<code title="…">`
  with the criterion id.
- The **weight** control is `[data-slot="select-trigger"]` (a radix select); the
  *Depends on* `popover-trigger` (also `role="combobox"`) is deliberately ignored.
- **Description / Rationale** textareas are located by their placeholder text.
- Text fields are set via React's native value setter so `onChange` fires; the
  weight is set by opening the radix select and clicking the matching option.

**Resilience notes**

- `ensureExpanded()` opens the Build Rubric section first if it's collapsed.
- Write-back requests `readwrite` permission during the click gesture, so the
  later write doesn't fail on expired user activation. If write-back still
  fails, the status panel offers a one-click **Save** and a **Download**
  fallback so the synced JSON is never lost.
- Progress is also logged to the DevTools console under `[RubricSync]`.
