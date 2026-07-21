<script lang="ts">
  import { onMount } from "svelte";

  import { commands } from "$lib/bindings";
  import {
    finishWindowPointSelection,
    windowRectAtPoint,
    type StrictWindowBounds
  } from "$lib/windowPickerCommands";

  let selectionPending = $state(false);
  let highlight = $state<StrictWindowBounds | null>(null);

  // Latest pointer position and a single-flight guard so rapid pointermove
  // events don't flood the backend (each query enumerates all windows). When a
  // query returns and the pointer has moved since, we issue one trailing query
  // so the highlight keeps up without overlapping requests.
  let pointerX = 0;
  let pointerY = 0;
  let queryInFlight = false;
  let queriedX = Number.NaN;
  let queriedY = Number.NaN;
  let rafScheduled = false;

  async function refreshHighlight() {
    if (selectionPending || queryInFlight) return;
    if (pointerX === queriedX && pointerY === queriedY) return;

    queryInFlight = true;
    const x = pointerX;
    const y = pointerY;
    queriedX = x;
    queriedY = y;
    try {
      const result = await windowRectAtPoint(x, y);
      if (result.status === "ok" && !selectionPending) {
        highlight = result.data;
      }
    } catch {
      // Transient enumeration errors shouldn't break selection; keep last box.
    } finally {
      queryInFlight = false;
      if (!selectionPending && (pointerX !== x || pointerY !== y)) void refreshHighlight();
    }
  }

  function handlePointerMove(event: PointerEvent) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    // Coalesce bursts of pointermove into at most one query per animation frame.
    // The trailing query in refreshHighlight still guarantees the final resting
    // position is queried, so this throttles without dropping the last move.
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      void refreshHighlight();
    });
  }

  async function selectWindow(event: PointerEvent) {
    if (selectionPending) return;
    selectionPending = true;
    highlight = null;
    try {
      const result = await finishWindowPointSelection(event.clientX, event.clientY);
      if (result.status === "error") selectionPending = false;
    } catch {
      selectionPending = false;
    }
  }

  async function cancelSelection() {
    if (selectionPending) return;
    selectionPending = true;
    try {
      const result = await commands.cancelWindowSelection();
      if (result.status === "error") selectionPending = false;
    } catch {
      selectionPending = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      void cancelSelection();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });
</script>

<svelte:head>
  <title>ScreenPick Window</title>
</svelte:head>

<main class:pending={selectionPending} onpointerdown={selectWindow} onpointermove={handlePointerMove}>
  {#if highlight && !selectionPending}
    <div
      class="highlight"
      style="left: {highlight.x}px; top: {highlight.y}px; width: {highlight.width}px; height: {highlight.height}px;"
    ></div>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent;
  }

  main {
    position: fixed;
    inset: 0;
    cursor: crosshair;
    background: rgba(10, 16, 22, 0.08);
    user-select: none;
  }

  main.pending {
    cursor: wait;
  }

  .highlight {
    position: fixed;
    border: 3px solid #d73535;
    box-shadow:
      inset 0 0 0 2px rgba(255, 255, 255, 0.92),
      0 0 0 1px rgba(215, 53, 53, 0.72);
    pointer-events: none;
  }
</style>
