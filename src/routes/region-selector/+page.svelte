<script lang="ts">
  import { onMount } from "svelte";

  import { commands } from "#lib/bindings.ts";

  type Point = {
    x: number;
    y: number;
  };

  let start = $state<Point | null>(null);
  let current = $state<Point | null>(null);
  let dragging = $state(false);
  // Two flags, as in the other three overlays: a confirm in flight and a
  // cancel in flight each block the other, and each is released again only if
  // its own command fails.
  let selectionPending = $state(false);
  let selectionCancelling = $state(false);
  let locked = $derived(selectionPending || selectionCancelling);

  let selection = $derived.by(() => {
    if (!start || !current) return null;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    return { x, y, width, height };
  });

  function pointFromEvent(event: PointerEvent): Point {
    return {
      x: event.clientX,
      y: event.clientY
    };
  }

  function beginSelection(event: PointerEvent) {
    if (locked) return;
    const point = pointFromEvent(event);
    start = point;
    current = point;
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function updateSelection(event: PointerEvent) {
    if (!dragging || locked) return;
    current = pointFromEvent(event);
  }

  async function endSelection(event: PointerEvent) {
    if (!dragging || locked) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);

    if (!selection || selection.width < 8 || selection.height < 8) {
      await cancelSelection();
      return;
    }

    selectionPending = true;
    // On success Rust ends the session and closes this overlay, so the flag
    // stays up. It is released when the command reports an error and when the
    // IPC call itself throws: in both cases the overlay may still be on
    // screen, and it would otherwise be wedged with no way to select or cancel.
    try {
      const result = await commands.finishRegionSelection({
        ...selection,
        scaleFactor: window.devicePixelRatio
      });
      if (result.status === "error") selectionPending = false;
    } catch {
      selectionPending = false;
    }
  }

  async function cancelSelection() {
    if (locked) return;
    selectionCancelling = true;
    try {
      const result = await commands.cancelRegionSelection();
      if (result.status === "error") selectionCancelling = false;
    } catch {
      selectionCancelling = false;
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
  <title>ScreenPick Region</title>
</svelte:head>

<main
  class:pending={locked}
  onpointerdown={beginSelection}
  onpointermove={updateSelection}
  onpointerup={endSelection}
>
  {#if selection && selection.width > 0 && selection.height > 0}
    <div
      class="selection"
      style={`left: ${selection.x}px; top: ${selection.y}px; width: ${selection.width}px; height: ${selection.height}px;`}
    >
      <span>{Math.round(selection.width * window.devicePixelRatio)} x {Math.round(selection.height * window.devicePixelRatio)}</span>
    </div>
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
    background: rgba(10, 16, 22, 0.24);
    user-select: none;
  }

  main.pending {
    cursor: wait;
  }

  .selection {
    position: absolute;
    border: 2px solid #1c7c6d;
    background: rgba(28, 124, 109, 0.12);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.92),
      0 0 0 9999px rgba(10, 16, 22, 0.34);
  }

  .selection span {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    min-width: max-content;
    padding: 5px 7px;
    color: #ffffff;
    background: #1c7c6d;
    border-radius: 6px;
    font: 12px/1.2 system-ui, sans-serif;
  }
</style>
