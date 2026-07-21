<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowUpRight,
    Blend,
    ClipboardCopy,
    Copy,
    Crop,
    Download,
    Eraser,
    FolderOpen,
    Hand,
    Highlighter,
    Image,
    Maximize,
    MousePointer2,
    PenLine,
    Pipette,
    Scissors,
    Settings,
    Shapes,
    SprayCan,
    TriangleAlert,
    Type,
    Redo2,
    Undo2,
    X,
    ZoomIn,
    ZoomOut
  } from "@lucide/svelte";

  import { commands } from "$lib/bindings";
  import { capture } from "$lib/captureOrchestration.svelte";
  import { editor, type RecentCapture, type Tool } from "$lib/editor.svelte";
  import { confirmDiscard } from "$lib/editorCommands";
  import { unlockCaptureSound } from "$lib/captureSound";
  import { suppressMiddleClickAutoscroll, targetIsEditable } from "$lib/domUtils";
  import EditorStage from "$lib/EditorStage.svelte";
  import SettingsPanel from "$lib/SettingsPanel.svelte";
  import ToolProperties from "$lib/ToolProperties.svelte";

  type ToolDescriptor = {
    id: Tool;
    label: string;
    icon: typeof MousePointer2;
  };

  const tools: ToolDescriptor[] = [
    { id: "select", label: "Select", icon: MousePointer2 },
    { id: "hand", label: "Hand (pan — or hold Space / middle-drag)", icon: Hand },
    { id: "crop", label: "Crop", icon: Crop },
    { id: "cut", label: "Cut", icon: Scissors },
    { id: "pen", label: "Pen", icon: PenLine },
    { id: "arrow", label: "Arrow", icon: ArrowUpRight },
    { id: "shape", label: "Shape", icon: Shapes },
    { id: "text", label: "Text", icon: Type },
    { id: "highlight", label: "Highlight", icon: Highlighter },
    { id: "blur", label: "Blur", icon: Blend },
    { id: "erase", label: "Eraser (remove annotations)", icon: Eraser },
    { id: "erase-area", label: "Erase area (erase the screenshot)", icon: SprayCan },
    { id: "color", label: "Color picker", icon: Pipette }
  ];

  // Right-click menu for Recent captures. Built inline (the app pulls in no
  // context-menu library) and anchored at the pointer; a full-screen backdrop
  // dismisses it on the next click. Opening it also suppresses the webview's
  // native menu, whose generic "Save as" would otherwise offer to save the
  // thumbnail's surrounding markup as HTML rather than the image.
  // The context menu's targets are the right-clicked capture, or — when that
  // capture is part of an active multi-selection — every selected capture.
  let recentMenu = $state<{
    x: number;
    y: number;
    targets: RecentCapture[];
  } | null>(null);

  // Multi-selection in the Recent list. Keyed the same way as the {#each} block
  // (documentId, falling back to path) so a key survives a capture being
  // re-listed. `selectionAnchorKey` is the pivot for SHIFT range-selection —
  // stored as a key, not an index, so it stays correct when `recentCaptures`
  // reorders (a new capture is prepended) or shrinks (a tab closes) mid-
  // selection. Plain clicks clear the set and open a capture as before;
  // CTRL/SHIFT clicks build a selection without opening, so the right-click menu
  // can act on the group.
  let selectedKeys = $state<Set<string>>(new Set());
  let selectionAnchorKey = $state<string | null>(null);

  function recentKey(recent: RecentCapture): string {
    return recent.documentId ?? recent.path;
  }

  function isRecentSelected(recent: RecentCapture): boolean {
    return selectedKeys.has(recentKey(recent));
  }

  function handleRecentClick(event: MouseEvent, recent: RecentCapture, index: number) {
    if (event.shiftKey && selectionAnchorKey !== null) {
      // Range-select from the anchor to here. Resolve the anchor key to its
      // current index now (the list may have changed since it was set); if it's
      // gone, fall back to anchoring on the clicked item. Leave the anchor key
      // put so the user can grow/shrink the range with further SHIFT clicks.
      const anchorIndex = editor.recentCaptures.findIndex(
        (item) => recentKey(item) === selectionAnchorKey
      );
      const from = anchorIndex >= 0 ? anchorIndex : index;
      const lo = Math.min(from, index);
      const hi = Math.max(from, index);
      const next = new Set<string>();
      for (let i = lo; i <= hi; i += 1) {
        const item = editor.recentCaptures[i];
        if (item) next.add(recentKey(item));
      }
      selectedKeys = next;
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      // Toggle this item in the selection without opening it.
      const next = new Set(selectedKeys);
      const key = recentKey(recent);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      selectedKeys = next;
      selectionAnchorKey = key;
      return;
    }
    // Plain click: drop any multi-selection and open the capture (prior behavior).
    selectedKeys = new Set();
    selectionAnchorKey = recentKey(recent);
    editor.openCapture(recent);
  }

  // Native drag-out: dragging a Recent thumbnail hands the OS the flattened
  // image file(s) so they can be dropped into other apps. Dragging a member of
  // the multi-selection drags the whole group; dragging anything else drags just
  // that capture. preventDefault suppresses the webview's own (text-only) drag so
  // the plugin's real file drag is the only one in flight.
  function handleRecentDragStart(event: DragEvent, recent: RecentCapture) {
    const selected = editor.recentCaptures.filter(isRecentSelected);
    const targets =
      selected.length > 1 && isRecentSelected(recent) ? selected : [recent];
    event.preventDefault();
    editor.dragCaptures(targets);
  }

  // Middle-click a Recent card to close it — the universal tab gesture (browsers,
  // VS Code, terminals). It's an accelerator layered on the visible X button, so
  // it routes through handleCloseRecent and keeps the dirty-document guard. The
  // matching mousedown preventDefault kills the webview's autoscroll puck that a
  // middle-press would otherwise pop up.
  function handleRecentAuxClick(event: MouseEvent, recent: RecentCapture) {
    if (event.button !== 1) return;
    event.preventDefault();
    void handleCloseRecent(recent);
  }

  function openRecentMenu(event: MouseEvent, recent: RecentCapture) {
    event.preventDefault();
    // Right-clicking a member of the multi-selection acts on the whole group;
    // right-clicking anything else acts on just that capture (and doesn't alter
    // the current selection).
    const selected = editor.recentCaptures.filter(isRecentSelected);
    const targets =
      selected.length > 1 && isRecentSelected(recent) ? selected : [recent];
    // Keep the menu fully on-screen. Sizes are upper-bound estimates; clamping
    // against them avoids overflow off the right/bottom edge (the last Recent
    // item sits near the viewport bottom). The multi-target menu is shorter.
    const menuWidth = 210;
    const menuHeight = targets.length > 1 ? 56 : 176;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
    recentMenu = { x, y, targets };
  }

  function closeRecentMenu() {
    recentMenu = null;
  }

  async function handleRevealRecent() {
    const recent = recentMenu?.targets[0];
    closeRecentMenu();
    if (!recent) return;
    const error = await editor.revealCapture(recent);
    if (error) capture.setActivity(error);
  }

  async function handleSaveRecent() {
    const recent = recentMenu?.targets[0];
    closeRecentMenu();
    if (!recent) return;
    const error = await editor.exportRecentCapture(recent);
    if (error) capture.setActivity(error);
  }

  // "Save N images as..." for a multi-selection: save every selected capture
  // into one chosen folder. Always surfaces the batch result (count / failures);
  // the single-image path stays quiet on success.
  async function handleSaveSelected() {
    const targets = recentMenu?.targets ?? [];
    closeRecentMenu();
    if (targets.length === 0) return;
    const message = await editor.exportRecentCaptures(targets);
    if (message) capture.setActivity(message);
  }

  async function handleCopyRecentImage() {
    const recent = recentMenu?.targets[0];
    closeRecentMenu();
    if (!recent) return;
    const error = await editor.copyCaptureImage(recent);
    capture.setActivity(error ?? "Copied image to clipboard.");
  }

  async function handleCopyRecentPath() {
    const recent = recentMenu?.targets[0];
    closeRecentMenu();
    if (!recent) return;
    const error = await editor.copyCapturePath(recent);
    capture.setActivity(error ?? "Copied path to the annotated image.");
  }

  // Close a Recent tab. Closing ends the annotation process and deletes the
  // document, so a tab carrying annotation work asks for confirmation first
  // (clean captures close without prompting — they're throwaway by default).
  async function handleCloseRecent(recent: RecentCapture) {
    if (editor.isDocumentDirty(recent)) {
      const confirmed = await confirmDiscard(
        `"${recent.title}" has annotations. Discard them and remove this screenshot?`
      );
      if (!confirmed) return;
    }
    editor.closeDocument(recent);
  }

  function selectTool(id: Tool) {
    if (editor.activeTool === "color" && id !== "color") {
      editor.clearColorSample();
    }
    editor.activeTool = id;
  }

  async function handleExport() {
    const error = await editor.exportCapture();
    if (error) capture.setActivity(error);
  }

  async function handleCopy() {
    const error = await editor.copyToClipboard();
    capture.setActivity(error ?? "Copied to clipboard.");
  }

  function handleFitZoom() {
    // setFitZoom already recomputes fitZoom and snaps zoom to it; no need to
    // call refreshFitZoom first (it would just rebuild the document twice).
    editor.setFitZoom();
  }

  // True when the event originated inside an editable field (the annotation
  // text input, a settings field, etc.). Every keyboard shortcut sub-handler
  // below MUST call this and bail when true, so typing never triggers a
  // shortcut; the Escape handlers in handleKeydown are the deliberate exception
  // (cancel/commit must work while editing). Also reused by the context-menu
  // suppressor. Event-to-EventTarget adapter over the shared predicate in
  // domUtils.ts (also used by EditorStage.svelte) — one implementation, so it
  // can't drift between the two call sites (N2 in the 2026-07 code review).
  function eventTargetIsEditable(event: Event): boolean {
    return targetIsEditable(event.target);
  }

  function handleZoomShortcut(event: KeyboardEvent): boolean {
    if (!editor.document || !(event.ctrlKey || event.metaKey)) return false;
    if (eventTargetIsEditable(event)) return false;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      editor.setEditorZoom(editor.document.zoom * 1.1);
      return true;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      editor.setEditorZoom(editor.document.zoom / 1.1);
      return true;
    }
    if (event.key === "0") {
      event.preventDefault();
      handleFitZoom();
      return true;
    }
    return false;
  }

  function handleCopyShortcut(event: KeyboardEvent): boolean {
    if (!editor.document || !(event.ctrlKey || event.metaKey)) return false;
    if (event.shiftKey || event.altKey) return false;
    if (eventTargetIsEditable(event)) return false;
    if (event.key.toLowerCase() !== "c") return false;
    event.preventDefault();
    void handleCopy();
    return true;
  }

  function handleHistoryShortcut(event: KeyboardEvent): boolean {
    if (!(event.ctrlKey || event.metaKey)) return false;
    if (eventTargetIsEditable(event)) return false;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      editor.undo();
      return true;
    }
    if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      editor.redo();
      return true;
    }
    return false;
  }

  function handleOrderShortcut(event: KeyboardEvent): boolean {
    if (!(event.ctrlKey || event.metaKey)) return false;
    if (eventTargetIsEditable(event)) return false;
    if (editor.activeTool !== "select" || editor.selectedAnnotationId === null) return false;
    if (event.code === "BracketRight") {
      event.preventDefault();
      if (event.shiftKey) editor.bringSelectedToFront();
      else editor.bringSelectedForward();
      return true;
    }
    if (event.code === "BracketLeft") {
      event.preventDefault();
      if (event.shiftKey) editor.sendSelectedToBack();
      else editor.sendSelectedBackward();
      return true;
    }
    return false;
  }

  // Dispatch order is intentional: Escape (menu → gesture) and Delete run first
  // and unconditionally; the remaining shortcut handlers are tried in priority
  // order and each returns true once it consumes the event. Every handler below
  // Escape must guard with eventTargetIsEditable so typing in a field can't
  // trigger a shortcut (Escape is the deliberate exception — it must cancel
  // while editing).
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && recentMenu) {
      closeRecentMenu();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && editor.cancelActiveGesture()) {
      event.preventDefault();
      return;
    }
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      editor.activeTool === "select" &&
      editor.selectedAnnotationId !== null
    ) {
      if (!eventTargetIsEditable(event)) {
        event.preventDefault();
        editor.deleteSelectedAnnotation();
        return;
      }
    }
    if (handleCopyShortcut(event)) return;
    if (handleHistoryShortcut(event)) return;
    if (handleOrderShortcut(event)) return;
    if (handleZoomShortcut(event)) return;
    // Don't let the capture fallback fire while focus is in a text field /
    // shortcut recorder, matching the editable guard the handlers above use.
    if (!eventTargetIsEditable(event) && capture.handleFallbackShortcut(event)) return;
  }

  // Suppress the webview's native right-click menu app-wide. Its generic
  // "Reload / Save as" entries are meaningless in a desktop app (and "Save as"
  // offers to save the page markup as HTML). Editable fields keep their native
  // menu so copy/paste/select-all still work; the Recent list opens its own
  // menu via openRecentMenu, which preventDefaults before this listener runs.
  function suppressNativeContextMenu(event: MouseEvent) {
    if (!eventTargetIsEditable(event)) event.preventDefault();
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("contextmenu", suppressNativeContextMenu);
    // Unlock the audio context on the first user gesture *after* the sound is
    // enabled, so a later background-hotkey capture can play it. Users who never
    // enable the sound never spin up an AudioContext. Persistent (not `once`) so
    // it still fires once the persisted setting finishes loading.
    const maybeUnlock = () => {
      if (!capture.settings.playCaptureSound) return;
      unlockCaptureSound();
      window.removeEventListener("pointerdown", maybeUnlock);
      window.removeEventListener("keydown", maybeUnlock);
    };
    window.addEventListener("pointerdown", maybeUnlock);
    window.addEventListener("keydown", maybeUnlock);
    editor.setupResize();
    // Repopulate the Recent strip from persisted annotation documents (the editor
    // opens empty; clicking a tab loads that document with its saved annotations).
    void editor.loadPersistedDocuments();
    const teardownCapture = capture.setup();

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("contextmenu", suppressNativeContextMenu);
      window.removeEventListener("pointerdown", maybeUnlock);
      window.removeEventListener("keydown", maybeUnlock);
      editor.teardownResize();
      teardownCapture();
    };
  });
</script>

<svelte:head>
  <title>ScreenPick</title>
</svelte:head>

<main class="app-shell">
  <aside class="capture-panel" aria-label="Capture modes">
    <div class="brand">
      <div class="brand-mark">
        <Scissors size={22} strokeWidth={2.4} />
      </div>
      <div>
        <h1>ScreenPick</h1>
        <span>{capture.status} • {capture.shortcutStatus}</span>
      </div>
    </div>

    {#if capture.showScreenRecordingNotice}
      <div class="permission-notice" role="alert">
        <div class="notice-header">
          <TriangleAlert size={16} />
          <span>Screen Recording is off</span>
          <button
            type="button"
            aria-label="Dismiss Screen Recording notice"
            onclick={() => capture.dismissScreenRecordingNotice()}
          >
            <X size={14} />
          </button>
        </div>
        <p>
          macOS hasn't granted ScreenPick permission to record the screen, so
          captures can't run. Enable it under Privacy &amp; Security &gt; Screen &amp;
          System Audio Recording, then return here (relaunch ScreenPick if
          captures still don't work).
        </p>
        <button
          type="button"
          class="notice-action"
          onclick={() => void capture.openScreenRecordingSettings()}
        >
          Open Screen Recording settings
        </button>
      </div>
    {/if}

    <div class="capture-list">
      <!-- "screen-pick" is a hotkey-only mode (its own accelerator opens the
           display picker); the Screen button already opens the picker on click,
           so a separate button would be redundant. It still appears in the
           shortcut editor for rebinding. -->
      {#each capture.captureModes.filter((mode) => mode.id !== "screen-pick") as mode}
        <button
          class:active={capture.activeCapture === mode.id}
          type="button"
          disabled={capture.capturePending}
          onclick={() => void capture.requestCapture(mode.id, "button")}
        >
          <span>{mode.label}</span>
          <kbd>{capture.formatShortcut(capture.activeAccelerator(mode))}</kbd>
        </button>
      {/each}
    </div>

    {#if capture.failedShortcuts.length > 0}
      <div class="shortcut-conflicts" aria-label="Shortcut registration failures">
        <div class="conflicts-header">
          <TriangleAlert size={16} />
          <span>Shortcut conflicts</span>
          <button type="button" aria-label="Dismiss shortcut conflict notice" onclick={() => capture.dismissShortcutConflicts()}>
            <X size={14} />
          </button>
        </div>
        <ul>
          {#each capture.failedShortcuts as failure (capture.statusKey(failure))}
            <li>
              <kbd>{capture.formatShortcut(failure.accelerator)}</kbd>
              <span class="conflict-mode">{failure.mode}</span>
              <span class="conflict-error" title={failure.error ?? "Unknown error"}>{capture.friendlyShortcutError(failure.error)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <button
      type="button"
      class="settings-toggle"
      class:active={capture.settingsPanelOpen}
      onclick={() => capture.toggleSettingsPanel()}
    >
      <Settings size={16} />
      <span>Settings</span>
    </button>

    {#if capture.settingsPanelOpen}
      <SettingsPanel />
    {/if}

    <section class="recents" aria-label="Recent captures">
      <div class="section-heading">
        <h2>Recent</h2>
      </div>
      {#each editor.recentCaptures as recent, recentIndex (recentKey(recent))}
        <div class="recent-row">
          <button
            type="button"
            class="recent-item"
            class:active={editor.currentCapture?.path === recent.path}
            class:selected={isRecentSelected(recent)}
            draggable="true"
            onclick={(event) => handleRecentClick(event, recent, recentIndex)}
            use:suppressMiddleClickAutoscroll
            onauxclick={(event) => handleRecentAuxClick(event, recent)}
            ondragstart={(event) => handleRecentDragStart(event, recent)}
            oncontextmenu={(event) => openRecentMenu(event, recent)}
          >
            <span class="thumb">
              <img src={recent.assetUrl} alt="" />
            </span>
            <span>
              <strong>{recent.title}</strong>
              <small>{recent.width} x {recent.height}{recent.dirty ? " • edited" : ""}</small>
            </span>
          </button>
          {#if recent.dirty}
            <span class="dirty-dot" title="Has annotations — baked into the copied/exported image"></span>
          {/if}
          <button
            type="button"
            class="recent-close"
            aria-label="Close {recent.title}"
            title="Close"
            onclick={() => handleCloseRecent(recent)}
          >
            <X size={13} />
          </button>
        </div>
      {:else}
        <div class="empty-recents">
          <Image size={18} />
          <span>No captures yet</span>
        </div>
      {/each}
    </section>
  </aside>

  <section class="workspace" aria-label="Editor workspace">
    <header class="topbar">
      <div class="document-title">
        <strong>{editor.document?.capture.title ?? "Untitled capture"}</strong>
        {#if editor.document}
          <span>
            PNG • {Math.round(editor.document.zoom * 100)}% •
            {editor.document.capture.width} x {editor.document.capture.height}
          </span>
        {/if}
      </div>
      <div class="window-actions">
        <button
          type="button"
          aria-label="Undo"
          title="Undo"
          disabled={!editor.canUndo}
          onclick={() => editor.undo()}
        >
          <Undo2 size={17} />
        </button>
        <button
          type="button"
          aria-label="Redo"
          title="Redo"
          disabled={!editor.canRedo}
          onclick={() => editor.redo()}
        >
          <Redo2 size={17} />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={!editor.document}
          onclick={() => editor.setEditorZoom((editor.document?.zoom ?? 1) - 0.1)}
        >
          <ZoomOut size={17} />
        </button>
        <button type="button" disabled={!editor.document} onclick={handleFitZoom}>
          <Maximize size={17} /> Fit
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={!editor.document}
          onclick={() => editor.setEditorZoom((editor.document?.zoom ?? 1) + 0.1)}
        >
          <ZoomIn size={17} />
        </button>
        <button
          type="button"
          disabled={!editor.document || editor.copyPending}
          onclick={handleCopy}
          title="Copy to clipboard"
        >
          <ClipboardCopy size={17} /> {editor.copyPending ? "Copying..." : "Copy"}
        </button>
        <button
          type="button"
          class="primary"
          disabled={!editor.document || editor.exportPending}
          onclick={handleExport}
        >
          <Download size={17} /> {editor.exportPending ? "Exporting..." : "Export"}
        </button>
      </div>
    </header>

    <div class="editor-row">
      <nav class="tool-rail" aria-label="Annotation tools">
        {#each tools as tool}
          {@const Icon = tool.icon}
          <button
            class:active={editor.activeTool === tool.id}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            onclick={() => selectTool(tool.id)}
          >
            <Icon size={20} />
          </button>
        {/each}
      </nav>

      <EditorStage />
    </div>
  </section>

  <aside class="properties" aria-label="Tool properties">
    <ToolProperties />
  </aside>

  <footer class="status-bar" aria-live="polite">
    <span class="status-message">{capture.captureActivity}</span>
    {#if editor.persistError}
      <span class="status-persist-error" title={editor.persistError}>
        <TriangleAlert size={13} /> Not saved: {editor.persistError}
      </span>
    {/if}
    {#if capture.shortcutLog.length > 0}
      <span class="status-shortcuts">{capture.shortcutLog.at(-1)}</span>
    {/if}
  </footer>
</main>

{#if recentMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="recent-menu-backdrop"
    onpointerdown={closeRecentMenu}
    oncontextmenu={(event) => {
      event.preventDefault();
      closeRecentMenu();
    }}
  ></div>
  <div class="recent-menu" role="menu" style="left: {recentMenu.x}px; top: {recentMenu.y}px;">
    {#if recentMenu.targets.length > 1}
      <button type="button" role="menuitem" onclick={handleSaveSelected}>
        <Download size={15} /> Save {recentMenu.targets.length} images as...
      </button>
    {:else}
      <button type="button" role="menuitem" onclick={handleRevealRecent}>
        <FolderOpen size={15} /> Show in folder
      </button>
      <button type="button" role="menuitem" onclick={handleSaveRecent}>
        <Download size={15} /> Save image as...
      </button>
      <button type="button" role="menuitem" onclick={handleCopyRecentImage}>
        <Copy size={15} /> Copy to clipboard
      </button>
      <button type="button" role="menuitem" onclick={handleCopyRecentPath}>
        <ClipboardCopy size={15} /> Copy path
      </button>
    {/if}
  </div>
{/if}

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    min-width: 980px;
    min-height: 680px;
    overflow: hidden;
    color: #20242a;
    background: #eef1f4;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0;
    /* Desktop-app feel: chrome text isn't selectable, so Cmd/Ctrl+A doesn't
       "select all" the UI labels/menu items. Re-enabled on editable fields and
       the copyable device ID below. */
    -webkit-user-select: none;
    user-select: none;
  }

  :global(input),
  :global(textarea),
  :global([contenteditable="true"]) {
    -webkit-user-select: text;
    user-select: text;
  }

  button {
    font: inherit;
  }

  button {
    border: 0;
    cursor: pointer;
  }

  /* Keep button glyphs at their intended size; SVGs are flex children and would
     otherwise squish when their button is compressed in a narrow window. */
  button :global(svg) {
    flex-shrink: 0;
  }

  .app-shell {
    display: grid;
    grid-template-columns: 264px minmax(520px, 1fr) 256px;
    grid-template-rows: minmax(0, 1fr) auto;
    height: 100vh;
    background: #eef1f4;
  }

  .status-bar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    height: 26px;
    padding: 0 14px;
    color: #5d6875;
    font-size: 12px;
    background: #ffffff;
    border-top: 1px solid #d9dee5;
  }

  .status-bar .status-message,
  .status-bar .status-shortcuts {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-bar .status-shortcuts {
    flex-shrink: 0;
    color: #8b95a1;
  }

  .status-bar .status-persist-error {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
    color: #b3261e;
  }

  .capture-panel,
  .properties {
    display: flex;
    flex-direction: column;
    gap: 22px;
    padding: 20px;
    background: #f9fafb;
    border-color: #d9dee5;
  }

  .capture-panel {
    border-right: 1px solid #d9dee5;
    /* Scroll the whole panel when content (incl. the never-auto-evicted dirty
       documents) exceeds the height, so the Recent list stays content-sized and
       anchored — it doesn't stretch/shift as the window is resized. */
    overflow-y: auto;
    min-height: 0;
  }

  .properties {
    border-left: 1px solid #d9dee5;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    color: #ffffff;
    background: #1c7c6d;
    border-radius: 8px;
  }

  h1,
  h2 {
    margin: 0;
  }

  h1 {
    font-size: 18px;
    line-height: 22px;
  }

  h2 {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    color: #5d6875;
  }

  .brand span,
  .document-title span,
  small {
    color: #66717f;
    font-size: 12px;
  }

  .capture-list,
  .recents,
  .window-actions {
    display: grid;
    gap: 8px;
  }

  .capture-list button,
  .recent-item,
  .window-actions button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 38px;
    padding: 9px 10px;
    color: #252a31;
    background: #ffffff;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  .capture-list button:disabled {
    cursor: wait;
    opacity: 0.68;
  }

  .window-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .capture-list button.active,
  .tool-rail button.active {
    color: #ffffff;
    background: #1c7c6d;
    border-color: #1c7c6d;
  }

  kbd {
    color: #6b7684;
    font-size: 11px;
    line-height: 1;
    background: #eef1f4;
    border: 1px solid #d9dee5;
    border-radius: 5px;
    padding: 4px 5px;
  }

  .capture-list button.active kbd {
    color: #e9fffb;
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.24);
  }

  .shortcut-conflicts {
    display: grid;
    gap: 8px;
    padding: 10px;
    background: #fef8f6;
    border: 1px solid #e6b0a3;
    border-radius: 8px;
  }

  .permission-notice {
    display: grid;
    gap: 9px;
    padding: 12px;
    background: #fef8f6;
    border: 1px solid #e6b0a3;
    border-radius: 8px;
  }

  .permission-notice .notice-header {
    display: flex;
    align-items: center;
    gap: 7px;
    color: #b42318;
    font-size: 12px;
    font-weight: 700;
  }

  .permission-notice .notice-header button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-left: auto;
    padding: 0;
    color: #b42318;
    background: transparent;
    border: 0;
    border-radius: 4px;
  }

  .permission-notice .notice-header button:hover {
    background: rgba(180, 35, 24, 0.08);
  }

  .permission-notice p {
    margin: 0;
    color: #3c4652;
    font-size: 11px;
    line-height: 17px;
  }

  .notice-action {
    min-height: 34px;
    padding: 8px 10px;
    color: #ffffff;
    background: #1c7c6d;
    border: 1px solid #1c7c6d;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
  }

  .notice-action:hover {
    background: #186b5f;
  }

  .conflicts-header {
    display: flex;
    align-items: center;
    gap: 7px;
    color: #b42318;
    font-size: 12px;
    font-weight: 700;
  }

  .conflicts-header button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-left: auto;
    padding: 0;
    color: #b42318;
    background: transparent;
    border: 0;
    border-radius: 4px;
  }

  .conflicts-header button:hover {
    background: rgba(180, 35, 24, 0.08);
  }

  .shortcut-conflicts ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .shortcut-conflicts li {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 4px 8px;
    color: #3c4652;
    font-size: 11px;
    line-height: 17px;
  }

  .conflict-mode {
    color: #5d6875;
    text-transform: capitalize;
  }

  .conflict-error {
    grid-column: 1 / -1;
    color: #b42318;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .shortcut-conflicts kbd {
    color: #5d6875;
    font-size: 10px;
    padding: 2px 4px;
  }

  .recent-item,
  .window-actions button {
    justify-content: flex-start;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .recent-row {
    position: relative;
  }

  .recent-item {
    width: 100%;
    text-align: left;
  }

  .recent-item.active {
    border-color: #1c7c6d;
    box-shadow: inset 3px 0 0 #1c7c6d;
  }

  /* Multi-selection (CTRL/SHIFT click) tint. A teal-tinted fill distinguishes
     selected-but-not-open items from the open one's left border, and the two
     can coexist (the open capture may also be in the selection). */
  .recent-item.selected {
    background: #e2f1ee;
    border-color: #1c7c6d;
  }

  .recent-item.active.selected {
    box-shadow: inset 3px 0 0 #1c7c6d;
  }

  /* Padding so the title/size text never slides under the dot / close button. */
  .recent-row .recent-item {
    padding-right: 30px;
  }

  /* Dirty marker: a teal dot in the top-right, shown when the document carries
     annotation work. Hidden on hover/focus so the close button can take its
     place in the same spot. */
  .dirty-dot {
    position: absolute;
    top: 8px;
    right: 10px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #1c7c6d;
    pointer-events: none;
  }

  .recent-close {
    position: absolute;
    top: 7px;
    right: 9px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    color: #60707c;
    background: #ffffff;
    border: 1px solid #dfe4ea;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .recent-row:hover .dirty-dot,
  .recent-row:focus-within .dirty-dot {
    opacity: 0;
  }

  .recent-row:hover .recent-close,
  .recent-row:focus-within .recent-close {
    opacity: 1;
  }

  .recent-close:hover,
  .recent-close:focus-visible {
    color: #b23b3b;
    border-color: #e2b3b3;
    background: #fdf3f3;
    outline: none;
  }

  .recent-item > span:last-child {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .recent-item strong,
  .recent-item small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
  }

  .recent-menu {
    position: fixed;
    z-index: 91;
    min-width: 180px;
    padding: 4px;
    display: grid;
    gap: 2px;
    background: #ffffff;
    border: 1px solid #d8dee3;
    border-radius: 8px;
    box-shadow: 0 10px 28px rgba(15, 23, 32, 0.18);
  }

  .recent-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    text-align: left;
    font-size: 13px;
    color: #2b3640;
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
  }

  .recent-menu button:hover,
  .recent-menu button:focus-visible {
    background: #eef1f4;
    outline: none;
  }

  .recent-menu button :global(svg) {
    flex: 0 0 auto;
    color: #60707c;
  }

  .thumb {
    display: grid;
    place-items: center;
    width: 40px;
    height: 32px;
    flex: 0 0 auto;
    color: #60707c;
    background: #e8ecef;
    border-radius: 6px;
    overflow: hidden;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .empty-recents {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 38px;
    padding: 9px 10px;
    color: #66717f;
    background: #f5f7f9;
    border: 1px dashed #cbd3dd;
    border-radius: 8px;
    font-size: 12px;
  }

  .workspace {
    display: grid;
    grid-template-rows: 62px 1fr;
    min-width: 0;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 18px;
    background: #ffffff;
    border-bottom: 1px solid #d9dee5;
  }

  .document-title {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .document-title strong,
  .document-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .window-actions {
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    /* Never compress the action cluster; the document title (min-width: 0 +
       ellipsis) absorbs the width loss when the window narrows. */
    flex-shrink: 0;
  }

  .window-actions button {
    min-width: 38px;
    height: 38px;
    padding: 0 12px;
    white-space: nowrap;
  }

  .window-actions .primary {
    color: #ffffff;
    background: #1c7c6d;
    border-color: #1c7c6d;
  }

  .editor-row {
    display: grid;
    grid-template-columns: 58px 1fr;
    min-height: 0;
  }

  .tool-rail {
    display: grid;
    align-content: start;
    gap: 8px;
    padding: 12px 10px;
    background: #ffffff;
    border-right: 1px solid #d9dee5;
  }

  .tool-rail button {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    color: #384350;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  @media (max-width: 1120px) {
    .app-shell {
      grid-template-columns: 236px minmax(520px, 1fr) 220px;
    }

    .window-actions button {
      padding: 0 10px;
    }
  }

  .settings-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 38px;
    padding: 9px 10px;
    color: #5d6875;
    background: #ffffff;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
    font-size: 13px;
  }

  .settings-toggle.active {
    color: #ffffff;
    background: #1c7c6d;
    border-color: #1c7c6d;
  }
</style>
