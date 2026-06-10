/* =========================================================================
 * Mercor Studio — Build Rubric Sync (Chrome extension, MAIN-world content script)
 *
 * WHAT IT DOES
 *  - On https://studio.mercor.com/annotator/tasks/<id> pages, injects a
 *    "Sync Rubric" button into the "Step 3 · Build Rubric" section header.
 *  - On click, opens a file picker (File System Access API) for a JSON file.
 *  - Diffs the JSON against the criteria currently rendered in Build Rubric,
 *    keyed by the criterion id shown in each row (e.g. "reasoning-5ayacj"):
 *        * id in JSON + in DOM  -> UPDATE description / rationale / weight
 *        * id in JSON, not DOM  -> ADD via the category's "Add criterion"
 *        * id in DOM, not JSON  -> DELETE that row
 *  - After syncing, reads every row's id back out of the DOM and writes the
 *    JSON file back with the authoritative ids (new rows get the tool-assigned
 *    id), so the file always mirrors the browser.
 *
 * EXPECTED JSON SHAPE (array of objects):
 *   [
 *     {
 *       "id": "reasoning-5ayacj",          // matched against the DOM
 *       "category": "reasoning",            // reasoning | completeness | style
 *       "description": "....",
 *       "rationale": "....",                // optional
 *       "weight": "critical"                // critical | bonus | penalty
 *     },
 *     ...
 *   ]
 *
 * NOTE: the Build Rubric editor DOM is collapsed in the page snapshot we were
 * given, so field/row discovery here is heuristic and centralised in CONFIG +
 * the finder helpers below. If a step misfires, open DevTools, watch the
 * [RubricSync] logs and the on-page toast, and tweak the selectors in CONFIG.
 * ========================================================================= */
(() => {
  'use strict';

  if (window.__rubricSyncLoaded) return;
  window.__rubricSyncLoaded = true;

  // ----------------------------- config ----------------------------------
  const CONFIG = {
    stepDelay: 350,            // ms between scripted UI actions (React re-render)
    sectionTitleIncludes: 'build rubric',
    promptTitleIncludes: 'write prompt',
    goldenTitleIncludes: 'write golden answer',
    verifierTitleIncludes: 'verifier judge results',
    categoryLabels: {          // category key -> heading text in the editor
      reasoning: 'Reasoning',
      completeness: 'Completeness',
      style: 'Style',
    },
    fieldLabels: {
      description: 'description',
      rationale: 'rationale',
    },
    // textareas are most reliably found by their placeholder text
    placeholders: {
      description: 'What does this criterion check?',
      rationale: 'Why is this criterion important?',
    },
    weights: ['critical', 'bonus', 'penalty'],
    // the criterion row container
    rowSelector: '.rounded-md.border.p-3',
    // text that identifies the per-category "add" control
    addCriterionText: 'add criterion',
    // a valid criterion id looks like "<category>-<token>"
    idPattern: /^[a-z]+-[a-z0-9]+$/i,
  };

  const LOG = (...a) => console.log('[RubricSync]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // While we're scripting the page (import/export), the DOM churns heavily and
  // React is mid-reconcile. Pause our MutationObserver-driven injectors during
  // that window so we never insert nodes into a subtree React is rebuilding
  // (which trips its error boundary / "An error occurred").
  let busy = false;
  async function withBusy(fn) {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  // ------------------------- React-safe value setter ----------------------
  function setNativeValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value == null ? '' : String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ------------------------------ toast UI --------------------------------
  let toastEl = null;
  let toastBody = null;
  let autoCloseTimer = null;

  function dismissToast() {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
      toastBody = null;
    }
  }

  function scheduleAutoClose(ms = 5000) {
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(dismissToast, ms);
  }

  function cancelAutoClose() {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  function toast(msg, cls = '') {
    // any new activity cancels a pending auto-close
    cancelAutoClose();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'rubric-sync-toast';

      const bar = document.createElement('div');
      bar.className = 'rs-bar';
      const title = document.createElement('span');
      title.className = 'rs-title';
      title.textContent = 'Rubric Sync';
      const close = document.createElement('button');
      close.className = 'rs-close';
      close.type = 'button';
      close.textContent = '✕';
      close.title = 'Close';
      close.onclick = dismissToast;
      bar.appendChild(title);
      bar.appendChild(close);

      toastBody = document.createElement('div');
      toastBody.className = 'rs-body';

      toastEl.appendChild(bar);
      toastEl.appendChild(toastBody);
      document.body.appendChild(toastEl);
    }
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    toastBody.appendChild(line);
    toastBody.scrollTop = toastBody.scrollHeight;
    LOG(msg);
  }

  // ----------------------- section / card discovery -----------------------
  // The bordered card whose collapsible header <span> text includes `titleSub`.
  function getCardByTitle(titleSub) {
    const titleSpan = [...document.querySelectorAll('div, span')].find(
      (n) => n.children.length === 0 && norm(n.textContent).includes(titleSub)
    );
    if (!titleSpan) return null;
    let el = titleSpan;
    for (let i = 0; i < 6 && el; i++) {
      if (el.matches('.border.rounded-lg, [class*="rounded-lg"]')) return el;
      el = el.parentElement;
    }
    return titleSpan.closest('div');
  }

  // The clickable collapsible header bar inside a card.
  function getCardHeader(card, titleSub) {
    if (!card) return null;
    return (
      [...card.querySelectorAll('div')].find(
        (d) =>
          d.querySelector('span') &&
          norm(d.querySelector('span').textContent).includes(titleSub) &&
          d.className.includes('cursor-pointer')
      ) || card.firstElementChild
    );
  }

  // Expand a card if its collapsible content (a textarea) isn't rendered yet.
  async function ensureCardExpanded(card, titleSub) {
    if (!card) return false;
    if (!card.querySelector('textarea')) {
      const header = getCardHeader(card, titleSub);
      if (header) {
        header.click();
        await sleep(CONFIG.stepDelay);
      }
    }
    return true;
  }

  // The whole "Step 3 · Build Rubric" card (header + collapsible content).
  function getRubricCard() {
    return getCardByTitle(CONFIG.sectionTitleIncludes);
  }

  function getRubricHeader() {
    return getCardHeader(getRubricCard(), CONFIG.sectionTitleIncludes);
  }

  // Make sure the Build Rubric collapsible is open before we operate on it.
  async function ensureExpanded() {
    const card = getRubricCard();
    if (!card) return false;
    const hasContent =
      card.querySelector('textarea') ||
      [...card.querySelectorAll('button')].some((b) =>
        norm(b.textContent).includes(CONFIG.addCriterionText)
      );
    if (!hasContent) {
      const header = getRubricHeader();
      if (header) {
        header.click();
        await sleep(CONFIG.stepDelay);
      }
    }
    return true;
  }

  // All id <code> elements inside the rubric editor -> their row containers.
  function getRubricEditorRoot() {
    const card = getRubricCard();
    return card || document.body;
  }

  // A "row" = the bordered criterion container (div.rounded-md.border.p-3).
  function rowOf(node) {
    return (
      node.closest(CONFIG.rowSelector) ||
      (() => {
        // fallback: climb to an ancestor containing a textarea + weight select
        let el = node;
        for (let i = 0; i < 8 && el; i++) {
          if (
            el.querySelector &&
            el.querySelector('textarea') &&
            el.querySelector('[data-slot="select-trigger"]')
          )
            return el;
          el = el.parentElement;
        }
        return node.closest('div');
      })()
    );
  }

  // The id <code> inside a row, if any (fresh rows may not have one yet).
  function idCodeIn(row) {
    return [...row.querySelectorAll('code')].find((c) =>
      CONFIG.idPattern.test(norm(c.textContent))
    );
  }

  // All category <section>s in the editor, keyed by their h3 text.
  function getSections() {
    const root = getRubricEditorRoot();
    return [...root.querySelectorAll('section')]
      .map((sec) => {
        const h3 = sec.querySelector('h3');
        return { sec, cat: h3 ? norm(h3.textContent) : null };
      })
      .filter((s) => s.cat);
  }

  // Return [{ id, row }] for every criterion currently in the editor.
  function getExistingRows() {
    const root = getRubricEditorRoot();
    const rows = [...root.querySelectorAll(CONFIG.rowSelector)].filter((r) =>
      idCodeIn(r)
    );
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      const id = idCodeIn(row).textContent.trim();
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, row });
      }
    }
    return out;
  }

  function allRowIds() {
    return new Set(getExistingRows().map((r) => r.id));
  }

  // ---------------------- field finders within a row ----------------------
  function fieldByLabel(row, labelKey) {
    const want = CONFIG.fieldLabels[labelKey];
    const labels = [...row.querySelectorAll('label, div, span, p')].filter(
      (n) => {
        const t = norm(n.textContent);
        return t === want || t.startsWith(want);
      }
    );
    for (const lab of labels) {
      let scope = lab.parentElement || row;
      for (let i = 0; i < 4 && scope; i++) {
        const f = scope.querySelector(
          'textarea, input[type=text], input:not([type])'
        );
        if (f) return f;
        scope = scope.parentElement;
      }
    }
    return null;
  }

  function descAndRationale(row) {
    const byPlaceholder = (ph) =>
      row.querySelector(`textarea[placeholder="${ph}"]`);
    let desc = byPlaceholder(CONFIG.placeholders.description) ||
      fieldByLabel(row, 'description');
    let rat = byPlaceholder(CONFIG.placeholders.rationale) ||
      fieldByLabel(row, 'rationale');
    if (!desc || !rat) {
      // fallback: first textarea = description, second = rationale
      const tas = [...row.querySelectorAll('textarea')];
      desc = desc || tas[0] || null;
      rat = rat || tas[1] || null;
    }
    return { desc, rat };
  }

  // -------------------------- weight (radix select) -----------------------
  async function setWeight(row, weight) {
    const w = norm(weight);
    if (!w) return true;

    // native <select> fallback
    const sel = row.querySelector('select');
    if (sel) {
      const opt = [...sel.options].find(
        (o) => norm(o.textContent).includes(w) || norm(o.value).includes(w)
      );
      if (opt) {
        setNativeValue(sel, opt.value);
        return true;
      }
    }

    // radix select trigger ONLY (NOT the "Depends on" popover-trigger, which
    // is also role=combobox). The weight trigger is data-slot="select-trigger".
    const trigger = row.querySelector('[data-slot="select-trigger"]');

    if (!trigger) return false;
    if (norm(trigger.textContent) === w) return true; // already set

    trigger.click();
    await sleep(180);
    // options render in a portal at document root
    const opt = [...document.querySelectorAll('[role="option"]')].find((o) => {
      const t = norm(o.textContent);
      return t === w || t.startsWith(w);
    });
    if (opt) {
      opt.click();
      await sleep(120);
      return true;
    }
    // close the menu if we failed to find the option
    document.body.click();
    return false;
  }

  // ------------------------- add / delete criterion -----------------------
  // Locate the <section> for a category (h3 text === "reasoning" etc.).
  function sectionFor(catKey) {
    const found = getSections().find((s) => s.cat === norm(catKey));
    return found ? found.sec : null;
  }

  function findAddButton(catKey) {
    const sec = sectionFor(catKey);
    const scope = sec || getRubricEditorRoot();
    const btns = [...scope.querySelectorAll('button')].filter((b) =>
      norm(b.textContent).includes(CONFIG.addCriterionText)
    );
    return btns[0] || null;
  }

  // Click add, wait for the new row to appear, return it (diff by identity).
  async function addCriterion(catKey) {
    const sec = sectionFor(catKey);
    const scope = sec || getRubricEditorRoot();
    const before = new Set([...scope.querySelectorAll(CONFIG.rowSelector)]);

    const btn = findAddButton(catKey);
    if (!btn) {
      toast(`! no "Add criterion" button found for ${catKey}`, 'rs-row-err');
      return null;
    }
    btn.click();
    await sleep(CONFIG.stepDelay);

    // the new row is the row in this section that wasn't there before
    const fresh = [...scope.querySelectorAll(CONFIG.rowSelector)].find(
      (r) => !before.has(r)
    );
    if (!fresh) {
      toast(`! could not find newly added row in ${catKey}`, 'rs-row-err');
      return null;
    }
    const code = idCodeIn(fresh);
    return { id: code ? code.textContent.trim() : null, row: fresh };
  }

  function deleteButtonIn(row) {
    // the trash button sits in the row's top control strip; identify by icon
    return (
      row.querySelector(
        'button:has(.lucide-trash-2), button:has(.lucide-trash), button:has(svg[class*="trash"])'
      ) ||
      [...row.querySelectorAll('button')].find((b) =>
        b.querySelector('.lucide-trash-2, .lucide-trash, svg[class*="trash"]')
      ) ||
      [...row.querySelectorAll('button')].find((b) =>
        /delete|remove|trash/.test(norm(b.getAttribute('aria-label') || ''))
      ) ||
      null
    );
  }

  async function deleteRow(row) {
    const btn = deleteButtonIn(row);
    if (!btn) return false;
    btn.click();
    await sleep(CONFIG.stepDelay);
    // some UIs show a confirm dialog
    const confirm = [...document.querySelectorAll('button, [role="button"]')].find(
      (b) => /^(delete|remove|confirm|yes)$/.test(norm(b.textContent))
    );
    if (confirm && document.querySelector('[role="dialog"], [role="alertdialog"]')) {
      confirm.click();
      await sleep(CONFIG.stepDelay);
    }
    return true;
  }

  // ----------------------------- fill a row -------------------------------
  async function fillRow(row, item) {
    const { desc, rat } = descAndRationale(row);
    if (desc) setNativeValue(desc, item.description || '');
    else toast(`! no Description field for ${item.id || '(new)'}`, 'rs-row-warn');
    if (rat && item.rationale != null) setNativeValue(rat, item.rationale);
    const ok = await setWeight(row, item.weight);
    if (!ok && item.weight)
      toast(`! could not set weight=${item.weight} for ${item.id || '(new)'}`, 'rs-row-warn');
  }

  function categoryOf(item) {
    if (item.category && CONFIG.categoryLabels[norm(item.category)]) {
      return norm(item.category);
    }
    // derive from id prefix, e.g. "reasoning-5ayacj" -> "reasoning"
    const m = String(item.id || '').match(/^([a-z]+)-/i);
    return m ? norm(m[1]) : 'reasoning';
  }

  // ------------------------------ main sync -------------------------------
  async function sync(data, fileHandle, shape = 'array') {
    if (!Array.isArray(data)) {
      toast('! JSON root must resolve to a list of criteria', 'rs-row-err');
      return;
    }
    await ensureExpanded();

    // Snapshot existing rows with both their id and their description text, so
    // we can match a JSON item even when the tool-assigned id has drifted from
    // what's in the file (which is what breaks re-importing the same file).
    const existing = getExistingRows().map(({ id, row }) => {
      const { desc } = descAndRationale(row);
      return { id, row, descVal: desc ? norm(desc.value) : '' };
    });
    const byId = new Map(existing.map((r) => [r.id, r]));
    const byDesc = new Map(
      existing.filter((r) => r.descVal).map((r) => [r.descVal, r])
    );

    // For a JSON item, find its existing row: id first, then description text.
    const matchOf = (item) =>
      (item.id && byId.get(item.id)) ||
      (item.description && byDesc.get(norm(item.description))) ||
      null;

    // Which existing rows are claimed by some JSON item (so we keep them).
    const claimed = new Set();
    for (const item of data) {
      const m = matchOf(item);
      if (m) claimed.add(m.row);
    }

    // 1) DELETE existing rows that no JSON item maps to (by id OR description)
    let deleted = 0;
    for (const r of existing) {
      if (!claimed.has(r.row)) {
        toast(`- deleting ${r.id}`, 'rs-row-warn');
        if (await deleteRow(r.row)) deleted++;
        else toast(`  (no delete control found for ${r.id})`, 'rs-row-err');
      }
    }

    // 2) UPDATE matched + ADD unmatched. Track JSON item -> resolved row so we
    //    can read back authoritative ids afterwards.
    const resolved = []; // { item, row }
    for (const item of data) {
      if (!item || !item.description) {
        toast(`! skipping item without description: ${item && item.id}`, 'rs-row-warn');
        continue;
      }
      const match = matchOf(item);
      if (match) {
        const how = item.id && byId.get(item.id) ? item.id : 'by-description';
        toast(`~ updating ${how} (${item.weight || '-'})`, 'rs-row-ok');
        await fillRow(match.row, item);
        resolved.push({ item, row: match.row });
      } else {
        const cat = categoryOf(item);
        toast(`+ adding ${item.id || '(new)'} -> ${cat}`, 'rs-row-ok');
        const added = await addCriterion(cat);
        if (!added) continue;
        await fillRow(added.row, item);
        resolved.push({ item, row: added.row });
      }
      await sleep(CONFIG.stepDelay);
    }

    // 3) WRITE BACK: re-read ids from the DOM so the file matches the browser
    //    (new rows now carry tool-assigned ids). React may have re-mounted the
    //    row nodes, so match by description text first, falling back to the
    //    stored row reference.
    await sleep(CONFIG.stepDelay);
    const liveRows = getExistingRows().map(({ id, row }) => {
      const { desc } = descAndRationale(row);
      return { id, descVal: desc ? norm(desc.value) : '' };
    });
    let renamed = 0;
    for (const { item, row } of resolved) {
      let liveId = null;
      const byDesc = liveRows.find((r) => r.descVal === norm(item.description));
      if (byDesc) liveId = byDesc.id;
      else {
        const code = idCodeIn(row);
        liveId = code ? code.textContent.trim() : null;
      }
      if (liveId && liveId !== item.id) {
        toast(`  id ${item.id || '(new)'} -> ${liveId}`, 'rs-row-ok');
        item.id = liveId;
        renamed++;
      }
    }

    toast(
      `Done. updated/added ${resolved.length}, deleted ${deleted}, ids synced ${renamed}.`,
      'rs-row-ok'
    );

    // write the synced JSON back to the same file, preserving its shape
    const payload = serialize(data, shape);
    let manualPending = false;
    if (fileHandle) {
      try {
        const writable = await fileHandle.createWritable();
        await writable.write(payload);
        await writable.close();
        toast('✔ JSON file written back with synced ids.', 'rs-row-ok');
      } catch (e) {
        toast('! write-back failed: ' + e.message, 'rs-row-err');
        offerManualSave(fileHandle, payload);
        manualPending = true;
      }
    } else {
      offerManualSave(null, payload);
      manualPending = true;
    }
    toast('Changes autosave. Review the rows, then "Submit for Review" yourself.', 'rs-row-warn');

    // auto-close after completion, unless we're waiting on a manual save click
    if (manualPending) cancelAutoClose();
    else scheduleAutoClose(5000);
  }

  // --------------------------- export rubric ------------------------------
  function readWeight(row) {
    const v = row.querySelector(
      '[data-slot="select-trigger"] [data-slot="select-value"]'
    );
    return v ? norm(v.textContent) : '';
  }

  function readRowData(row, cat) {
    const code = idCodeIn(row);
    const { desc, rat } = descAndRationale(row);
    return {
      id: code ? code.textContent.trim() : null,
      category: cat,
      description: desc ? desc.value : '',
      rationale: rat ? rat.value : '',
      weight: readWeight(row),
    };
  }

  // Build { reasoning: [], completeness: [], style: [] } from the live editor.
  function exportRubric() {
    const out = {};
    // seed the three known categories so empty ones still appear
    for (const k of Object.keys(CONFIG.categoryLabels)) out[k] = [];
    for (const { sec, cat } of getSections()) {
      if (!out[cat]) out[cat] = [];
      const rows = [...sec.querySelectorAll(CONFIG.rowSelector)];
      for (const row of rows) {
        const data = readRowData(row, cat);
        // strip the redundant category key inside grouped output
        out[cat].push({
          id: data.id,
          description: data.description,
          rationale: data.rationale,
          weight: data.weight,
        });
      }
    }
    return out;
  }

  async function exportAndSave() {
    await withBusy(() => ensureExpanded());
    const grouped = exportRubric();
    const count = Object.values(grouped).reduce((n, a) => n + a.length, 0);
    const payload = JSON.stringify(grouped, null, 2);
    toast(`Exporting ${count} criteria across ${Object.keys(grouped).length} categories…`);
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'rubric.json',
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        const w = await handle.createWritable();
        await w.write(payload);
        await w.close();
        toast('✔ Rubric exported.', 'rs-row-ok');
        scheduleAutoClose(5000);
      } else {
        downloadJSON(payload, 'rubric.json');
        toast('✔ Rubric downloaded.', 'rs-row-ok');
        scheduleAutoClose(5000);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        dismissToast();
        return;
      }
      toast('! export failed: ' + e.message, 'rs-row-err');
      offerManualSave(null, payload);
    }
  }

  function downloadJSON(payload, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // --------------------- import Prompt / Golden Answer --------------------
  // Read a text/markdown file (read-only — no write-back needed here).
  async function pickTextFile() {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'Markdown / text',
            accept: {
              'text/markdown': ['.md', '.markdown'],
              'text/plain': ['.txt'],
            },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      return file.text();
    }
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
      input.onchange = () => {
        const f = input.files[0];
        if (!f) return reject(new Error('no file'));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(f);
      };
      input.click();
    });
  }

  // Load a .md file and drop its contents into the card's single textarea.
  async function importTextIntoCard(titleSub, friendlyName) {
    const card = getCardByTitle(titleSub);
    if (!card) {
      toast(`! ${friendlyName} section not found on this page`, 'rs-row-err');
      return;
    }
    let text;
    try {
      text = await pickTextFile();
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled
      toast('! could not read file: ' + e.message, 'rs-row-err');
      return;
    }
    await ensureCardExpanded(card, titleSub);
    const ta = card.querySelector('textarea[data-slot="textarea"]') ||
      card.querySelector('textarea');
    if (!ta) {
      toast(`! no text field found in ${friendlyName}`, 'rs-row-err');
      return;
    }
    setNativeValue(ta, text);
    toast(`✔ ${friendlyName} imported (${text.length} chars). Review & Save.`, 'rs-row-ok');
    scheduleAutoClose(5000);
  }

  // ------------------- copy Verifier Judge Results as JSON ----------------
  function getVerifierCard() {
    return getCardByTitle(CONFIG.verifierTitleIncludes);
  }

  // Label text of a verifier tab trigger (just the leading name span, not the
  // score span that follows it).
  function tabLabel(trig) {
    if (!trig) return '';
    const span = trig.querySelector('span');
    return (span ? span.textContent : trig.textContent).trim();
  }

  // Name of the currently-selected results tab (e.g. "Model response").
  function activeVerifierTab(card) {
    return tabLabel(card.querySelector('[role="tab"][data-state="active"]'));
  }

  // Expand the verifier card if its tabs/results aren't rendered yet. (Unlike
  // the rubric/prompt cards it has no <textarea>, so the generic
  // ensureCardExpanded would wrongly toggle an already-open card shut.)
  async function ensureVerifierExpanded(card) {
    if (!card) return false;
    if (!card.querySelector('[role="tab"], [role="tabpanel"]')) {
      const header = getCardHeader(card, CONFIG.verifierTitleIncludes);
      if (header) {
        header.click();
        await sleep(CONFIG.stepDelay);
      }
    }
    return true;
  }

  // All result tabs in the verifier card: [{ el, name }].
  function getVerifierTabs(card) {
    return [...card.querySelectorAll('[role="tab"]')].map((el) => ({
      el,
      name: tabLabel(el),
    }));
  }

  // Make `nameSub` the active tab (radix unmounts inactive panels, so we must
  // switch before scraping). Returns true once its panel is rendered.
  async function selectVerifierTab(card, nameSub) {
    if (!nameSub) return true;
    const want = nameSub.toLowerCase();
    const tab = getVerifierTabs(card).find((t) =>
      t.name.toLowerCase().includes(want)
    );
    if (!tab) return false;
    if (tab.el.getAttribute('data-state') === 'active') return true;
    tab.el.click();
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      if (tab.el.getAttribute('data-state') === 'active') return true;
    }
    return tab.el.getAttribute('data-state') === 'active';
  }

  // The active tab's result panel (whichever radix has mounted).
  function activeVerifierPanel(card) {
    return (
      card.querySelector('[role="tabpanel"][data-state="active"]') ||
      card.querySelector('[role="tabpanel"]:not([hidden])')
    );
  }

  // The verifier list is the .space-y-2 whose cards carry a font-mono <p> id
  // (this skips the "Model response" preview block above it).
  function verifierListIn(panel) {
    if (!panel) return null;
    const lists = [...panel.querySelectorAll('.space-y-2')];
    return lists.find((l) => l.querySelector('p[class*="font-mono"]')) || null;
  }

  // After a tab switch the page re-renders the panel asynchronously. Wait until
  // the active panel actually shows verifier result rows before scraping, so we
  // don't race the app mid-render (which can blank the panel / error it out).
  async function waitForVerifierResults(card) {
    for (let i = 0; i < 60; i++) {
      const panel = activeVerifierPanel(card);
      const list = verifierListIn(panel);
      if (list && list.querySelector('[class*="rounded-md"][class*="border"]')) {
        return true;
      }
      await sleep(50);
    }
    return false;
  }

  // Scrape the active tab's verifier result cards into structured objects.
  function scrapeVerifierResults(card, onlyFailed) {
    const panel = activeVerifierPanel(card);
    if (!panel) return null;
    const lists = [...panel.querySelectorAll('.space-y-2')];
    let container = verifierListIn(panel);
    container = container || lists[lists.length - 1];
    if (!container) return null;

    const results = [];
    for (const c of container.children) {
      if (!c.matches || !c.matches('[class*="rounded-md"][class*="border"]')) continue;
      const badges = [...c.querySelectorAll('[data-slot="badge"]')];
      const idEl = c.querySelector('p[class*="font-mono"]');
      const scoreEl = c.querySelector('span[class*="font-mono"]');
      const critEl = c.querySelector('[class*="line-clamp-2"]');
      const explEl = c.querySelector('[class*="line-clamp-3"]');
      const id = idEl ? idEl.textContent.trim() : null;
      const criterion = critEl ? critEl.textContent.trim() : '';
      if (!id && !criterion) continue; // not a verifier row
      results.push({
        id,
        status: badges[0] ? norm(badges[0].textContent) : '',
        weight: badges[1] ? norm(badges[1].textContent) : '',
        score: scoreEl ? scoreEl.textContent.trim() : '',
        criterion,
        explanation: explEl ? explEl.textContent.trim() : '',
      });
    }
    const filtered = onlyFailed
      ? results.filter((r) => r.status === 'fail')
      : results;
    return { tab: activeVerifierTab(card), count: filtered.length, results: filtered };
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  async function copyVerifierJSON(onlyFailed, tabName) {
    const card = getVerifierCard();
    if (!card) {
      toast('! Verifier Judge Results section not found', 'rs-row-err');
      return;
    }
    await ensureVerifierExpanded(card);
    if (tabName) {
      const wasActive = getVerifierTabs(card).some(
        (t) =>
          t.name.toLowerCase().includes(tabName.toLowerCase()) &&
          t.el.getAttribute('data-state') === 'active'
      );
      const ok = await selectVerifierTab(card, tabName);
      if (!ok) {
        toast(`! "${tabName}" tab not found`, 'rs-row-err');
        return;
      }
      // If we just switched tabs, let the panel finish rendering its results
      // before scraping (avoids racing the app mid-render).
      if (!wasActive) {
        toast(`… loading "${tabName}" results`, 'rs-row-warn');
        await waitForVerifierResults(card);
      }
    } else {
      await waitForVerifierResults(card);
    }
    const data = scrapeVerifierResults(card, onlyFailed);
    if (!data || !data.results.length) {
      toast(
        onlyFailed ? '! no failed verifiers in this tab' : '! no verifier results found',
        'rs-row-warn'
      );
      return;
    }
    const ok = await copyToClipboard(JSON.stringify(data, null, 2));
    if (ok) {
      toast(
        `✔ Copied ${data.results.length} ${onlyFailed ? 'failed ' : ''}result(s) from "${data.tab}" as JSON.`,
        'rs-row-ok'
      );
      scheduleAutoClose(5000);
    } else {
      toast('! clipboard copy failed', 'rs-row-err');
    }
  }

  // ------------------- copy review-panel results -------------------------
  // "Rubric Review" and "Golden Answer Review" share the same shape: a
  // .rounded-md.border with a collapsible header button + a Run button, and a
  // <pre> holding the grading output ending in "FINAL_SCORE: NN".
  const REVIEW_PANELS = [
    {
      key: 'rubric-review',
      title: 'rubric review',
      friendly: 'Rubric Review',
      max: 40,
      // <35 red, 35–38 yellow, 39–40 green.
      tier: (s) => (s < 35 ? 'red' : s < 39 ? 'yellow' : 'green'),
    },
    {
      key: 'golden-answer-review',
      title: 'golden answer review',
      friendly: 'Golden Answer Review',
      max: 25,
      // <24 red, 24 yellow, 25 green.
      tier: (s) => (s < 24 ? 'red' : s < 25 ? 'yellow' : 'green'),
    },
  ];

  // Last-seen output per panel, so the score badge + Copy button persist even
  // when the panel is collapsed (the page unmounts the <pre> while minimized).
  // Cleared when the task changes (see reviewTaskKey below).
  let reviewCache = {};
  let reviewTaskKey = '';

  // Reset the cache when navigating to a different task, so a collapsed panel
  // never shows the previous task's stale score.
  function syncReviewTask() {
    const key = location.pathname;
    if (key !== reviewTaskKey) {
      reviewTaskKey = key;
      reviewCache = {};
    }
  }

  function getReviewCard(titleNorm) {
    const label = [...document.querySelectorAll('div, span')].find(
      (n) => n.children.length === 0 && norm(n.textContent) === titleNorm
    );
    if (!label) return null;
    return label.closest('.rounded-md.border') || label.closest('div');
  }

  // Parse "FINAL_SCORE: NN" out of a review output.
  function parseFinalScore(text) {
    const m = /FINAL_SCORE:\s*(-?\d+(?:\.\d+)?)/i.exec(text || '');
    return m ? parseFloat(m[1]) : null;
  }

  async function copyReviewResult(panel) {
    // Prefer the live <pre>; fall back to the cached result (panel minimized).
    let text = '';
    const card = getReviewCard(panel.title);
    if (card) {
      const pre = card.querySelector('pre');
      if (pre) text = pre.textContent.trim();
    }
    if (!text && reviewCache[panel.key]) text = reviewCache[panel.key].text;
    if (!text) {
      toast(`! no ${panel.friendly} output yet — click Run first`, 'rs-row-warn');
      return;
    }
    const ok = await copyToClipboard(text);
    if (ok) {
      toast(`✔ Copied ${panel.friendly} result.`, 'rs-row-ok');
      scheduleAutoClose(5000);
    } else {
      toast('! clipboard copy failed', 'rs-row-err');
    }
  }

  // ------------------- copy QC Feedback ----------------------------------
  // The "QC Feedback" card is a .border.rounded-lg with a collapsible header
  // and reviewer-note paragraphs in its body.
  function getQcCard() {
    const label = [...document.querySelectorAll('span, div')].find(
      (n) => n.children.length === 0 && norm(n.textContent) === 'qc feedback'
    );
    if (!label) return null;
    return label.closest('.border.rounded-lg') || label.closest('div');
  }

  // Joined text of the feedback body (labels + notes, preserving line breaks).
  function qcText(card) {
    const header = card.querySelector('.cursor-pointer');
    const body = header ? header.nextElementSibling : null;
    const scope = body || card;
    const paras = [...scope.querySelectorAll('p')];
    if (paras.length) {
      return paras.map((p) => p.textContent.trim()).filter(Boolean).join('\n').trim();
    }
    return scope.textContent.trim();
  }

  async function copyQcFeedback() {
    let text = '';
    const card = getQcCard();
    if (card) text = qcText(card);
    if (!text && reviewCache['qc-feedback']) text = reviewCache['qc-feedback'].text;
    if (!text) {
      toast('! no QC Feedback to copy', 'rs-row-warn');
      return;
    }
    const ok = await copyToClipboard(text);
    if (ok) {
      toast('✔ Copied QC Feedback.', 'rs-row-ok');
      scheduleAutoClose(5000);
    } else {
      toast('! clipboard copy failed', 'rs-row-err');
    }
  }

  // If automatic write-back fails (e.g. activation expired), give the user a
  // button to save with a fresh click, plus a plain download fallback.
  function offerManualSave(handle, payload) {
    if (!toastEl) return;
    cancelAutoClose(); // needs a user click — don't auto-dismiss
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 Save to file (click)';
    saveBtn.style.cssText =
      'margin-right:8px;padding:3px 8px;border-radius:5px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer;font:inherit;';
    saveBtn.onclick = async () => {
      try {
        const h =
          handle ||
          (await window.showSaveFilePicker({
            suggestedName: 'rubric.json',
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          }));
        const w = await h.createWritable();
        await w.write(payload);
        await w.close();
        toast('✔ Saved.', 'rs-row-ok');
      } catch (e) {
        toast('! save failed: ' + e.message, 'rs-row-err');
      }
    };

    const dl = document.createElement('a');
    dl.textContent = '⤓ Download synced JSON';
    dl.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    dl.download = 'rubric.synced.json';
    dl.style.cssText = 'color:#93c5fd;cursor:pointer;';

    wrap.appendChild(saveBtn);
    wrap.appendChild(dl);
    (toastBody || toastEl).appendChild(wrap);
  }

  // ------------------------- file pick + entry ----------------------------
  async function pickAndSync() {
    let data, fileHandle;
    try {
      if (window.showOpenFilePicker) {
        // mode:'readwrite' grants write access NOW, during the click's user
        // activation, so createWritable() later (after async work) won't throw
        // "User activation is required to request permissions".
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false,
          mode: 'readwrite',
        });
        fileHandle = handle;
        // ensure the readwrite grant is settled while activation is still fresh
        try {
          if (handle.queryPermission) {
            let perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted' && handle.requestPermission) {
              perm = await handle.requestPermission({ mode: 'readwrite' });
            }
          }
        } catch (_) {
          /* non-fatal: write-back will report if it still can't write */
        }
        const file = await handle.getFile();
        data = JSON.parse(await file.text());
      } else {
        // fallback: no write-back possible
        data = await pickWithInput();
        toast('! File System Access API unavailable — cannot write back.', 'rs-row-warn');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled
      toast('! could not read JSON: ' + e.message, 'rs-row-err');
      return;
    }
    const { items, shape } = normalizeInput(data);
    if (!items) {
      toast(
        '! unrecognised JSON: expected an array, {criteria:[…]}, or {reasoning:[],completeness:[],style:[]}',
        'rs-row-err'
      );
      return;
    }
    await withBusy(() => sync(items, fileHandle, shape));
  }

  // Accept a flat array, { criteria: [...] }, or a grouped object keyed by
  // category. Returns { items: flatArray, shape } (shape drives write-back).
  function normalizeInput(raw) {
    if (Array.isArray(raw)) return { items: raw, shape: 'array' };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.criteria)) return { items: raw.criteria, shape: 'criteria' };
      // grouped: any object whose values are arrays of criteria
      const arrayKeys = Object.keys(raw).filter((k) => Array.isArray(raw[k]));
      if (arrayKeys.length) {
        const items = [];
        for (const key of arrayKeys) {
          for (const it of raw[key]) {
            if (it && typeof it === 'object') {
              items.push({ ...it, category: it.category || key });
            }
          }
        }
        return { items, shape: 'grouped' };
      }
    }
    return { items: null, shape: null };
  }

  // Serialise the synced items back in the same shape the file used.
  function serialize(items, shape) {
    if (shape === 'criteria') return JSON.stringify({ criteria: items }, null, 2);
    if (shape === 'grouped') {
      const out = {};
      for (const k of Object.keys(CONFIG.categoryLabels)) out[k] = [];
      for (const it of items) {
        const cat = categoryOf(it);
        if (!out[cat]) out[cat] = [];
        out[cat].push({
          id: it.id,
          description: it.description,
          rationale: it.rationale,
          weight: it.weight,
        });
      }
      return JSON.stringify(out, null, 2);
    }
    return JSON.stringify(items, null, 2); // 'array'
  }

  function pickWithInput() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const f = input.files[0];
        if (!f) return reject(new Error('no file'));
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(JSON.parse(reader.result));
          } catch (e) {
            reject(e);
          }
        };
        reader.readAsText(f);
      };
      input.click();
    });
  }

  // ----------------------------- button inject ----------------------------
  function wireButtonHandler(btn, handler) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't toggle the collapsible
      e.preventDefault();
      btn.disabled = true;
      try {
        await handler();
      } catch (err) {
        if (!(err && err.name === 'AbortError')) toast('! ' + err.message, 'rs-row-err');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function makeActionButton(id, label, title, handler) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'rubric-action-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    wireButtonHandler(btn, handler);
    return btn;
  }

  // An icon-only Copy button matching Studio's native copy buttons.
  const COPY_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy h-3.5 w-3.5" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';

  function makeIconCopyButton(id, title, handler) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy');
    btn.title = title;
    btn.className =
      'inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-foreground opacity-60 hover:opacity-100 transition-opacity';
    btn.innerHTML = COPY_ICON_SVG;
    wireButtonHandler(btn, handler);
    return btn;
  }

  function injectButton() {
    if (!location.pathname.includes('/annotator/tasks/')) return;
    if (document.getElementById('rubric-sync-btn')) return;
    const header = getRubricHeader();
    if (!header) return;

    const importBtn = makeActionButton(
      'rubric-sync-btn',
      '⤓ Import Rubric',
      'Load a JSON file (flat array or {reasoning,completeness,style}) and sync the Build Rubric criteria',
      pickAndSync
    );
    const exportBtn = makeActionButton(
      'rubric-export-btn',
      '⤒ Export Rubric',
      'Save the current Build Rubric as JSON grouped by category',
      exportAndSave
    );

    // place into the header's right-hand control group if present
    const right = header.querySelector('div.flex.items-center.gap-2') || header;
    right.insertBefore(exportBtn, right.firstChild);
    right.insertBefore(importBtn, right.firstChild);
    LOG('buttons injected');
  }

  // Inject a simple copy icon into the Verifier header that copies the
  // currently open tab's results as JSON.
  function injectVerifierCopyControl() {
    if (document.getElementById('verifier-copy-btn')) return;
    const card = getVerifierCard();
    if (!card) return;
    const header = getCardHeader(card, CONFIG.verifierTitleIncludes);
    if (!header) return;
    // Wait until the result tabs are present before injecting.
    if (!getVerifierTabs(card).some((t) => t.name)) return;
    const right = header.querySelector('div.flex.items-center.gap-2') || header;

    const btn = makeIconCopyButton(
      'verifier-copy-btn',
      "Copy the open tab's verifier results as JSON",
      () => copyVerifierJSON(false)
    );
    right.insertBefore(btn, right.firstChild);
    LOG('verifier copy control injected');
  }

  // Inject a "Copy" button + a live score badge into a review panel's header,
  // and tint the result area by score tier. Re-run each tick so the badge/tint
  // refresh after the review is (re-)run. Idempotent per panel.
  function injectReviewControls(panel) {
    const copyId = `${panel.key}-copy-btn`;
    const scoreId = `${panel.key}-score`;
    const card = getReviewCard(panel.title);
    if (!card) return;
    const toolbar =
      card.querySelector('div.flex.items-center.gap-2.px-3') ||
      card.querySelector('div.flex.items-center.gap-2');
    if (!toolbar) return;

    const pre = card.querySelector('pre');
    const liveText = pre ? pre.textContent.trim() : '';
    // Cache the latest live result; reuse it while the panel is minimized.
    if (liveText) reviewCache[panel.key] = { text: liveText };
    const cached = reviewCache[panel.key];
    const text = liveText || (cached ? cached.text : '');

    const copyBtn = document.getElementById(copyId);
    const badge = document.getElementById(scoreId);
    const clearTint = () => {
      if (pre) pre.classList.remove('rs-score-red', 'rs-score-yellow', 'rs-score-green');
    };

    // Never had a result for this task: tear down our additions.
    if (!text) {
      if (copyBtn) copyBtn.remove();
      if (badge) badge.remove();
      clearTint();
      return;
    }

    // There is a result → show the Copy button.
    if (!copyBtn) {
      const btn = makeIconCopyButton(
        copyId,
        `Copy the ${panel.friendly} result`,
        () => copyReviewResult(panel)
      );
      toolbar.insertBefore(btn, toolbar.firstChild);
      LOG(`${panel.friendly} copy button injected`);
    }

    // Score badge + result tint — only when a FINAL_SCORE is present.
    const score = parseFinalScore(text);
    if (score == null) {
      if (badge) badge.remove();
      clearTint();
      return;
    }

    const tier = panel.tier(score);
    const tierClass = `rs-score-${tier}`;
    const label = `Score: ${score}/${panel.max}`;
    let b = badge;
    if (!b) {
      b = document.createElement('span');
      b.id = scoreId;
      b.className = 'rubric-score-badge';
      toolbar.insertBefore(b, toolbar.firstChild);
    }
    // Only touch the DOM when something actually changed — the MutationObserver
    // re-fires tick() on any childList change, so an unconditional textContent
    // write would loop and freeze the page.
    if (b.textContent !== label) b.textContent = label;
    if (!b.classList.contains(tierClass)) {
      b.classList.remove('rs-score-red', 'rs-score-yellow', 'rs-score-green');
      b.classList.add(tierClass);
    }
    if (pre && !pre.classList.contains(tierClass)) {
      pre.classList.remove('rs-score-red', 'rs-score-yellow', 'rs-score-green');
      pre.classList.add(tierClass);
    }
  }

  // Inject an icon Copy button into the QC Feedback header. Cached per task so
  // it survives the panel being collapsed.
  function injectQcFeedbackCopy() {
    const card = getQcCard();
    if (!card) return;
    const header = card.querySelector('.cursor-pointer');
    const toolbar =
      (header && header.querySelector('div.flex.items-center.gap-2')) || header;
    if (!toolbar) return;

    const liveText = qcText(card);
    if (liveText) reviewCache['qc-feedback'] = { text: liveText };
    const cached = reviewCache['qc-feedback'];
    const text = liveText || (cached ? cached.text : '');

    const btn = document.getElementById('qc-feedback-copy-btn');
    if (!text) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      const b = makeIconCopyButton(
        'qc-feedback-copy-btn',
        'Copy the QC Feedback',
        copyQcFeedback
      );
      toolbar.insertBefore(b, toolbar.firstChild);
      LOG('QC feedback copy button injected');
    }
  }

  // Inject a single "import from .md" button into a card's collapsible header.
  function injectTextImportButton(btnId, titleSub, label, friendlyName) {
    if (document.getElementById(btnId)) return;
    const card = getCardByTitle(titleSub);
    if (!card) return;
    const header = getCardHeader(card, titleSub);
    if (!header) return;
    const btn = makeActionButton(btnId, label, `Load a .md file into ${friendlyName}`,
      () => importTextIntoCard(titleSub, friendlyName));
    const right = header.querySelector('div.flex.items-center.gap-2') || header;
    right.insertBefore(btn, right.firstChild);
    LOG(`${friendlyName} import button injected`);
  }

  // ---------------------- observe SPA navigation --------------------------
  const tick = () => {
    if (busy) return; // don't mutate the DOM while we're scripting the page
    if (!location.pathname.includes('/annotator/tasks/')) return;
    try {
      injectButton();
      injectTextImportButton(
        'prompt-import-btn',
        CONFIG.promptTitleIncludes,
        '⤓ Import Prompt',
        'Prompt'
      );
      injectTextImportButton(
        'golden-import-btn',
        CONFIG.goldenTitleIncludes,
        '⤓ Import Golden Answer',
        'Golden Answer'
      );
      injectVerifierCopyControl();
      syncReviewTask();
      REVIEW_PANELS.forEach(injectReviewControls);
      injectQcFeedbackCopy();
    } catch (e) {
      /* ignore */
    }
  };
  const obs = new MutationObserver(() => tick());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1500);
  tick();
})();
