<script lang="ts">
  import { onMount } from "svelte";
  import { emit } from "@tauri-apps/api/event";

  import { commands } from "$lib/bindings";
  import { screenTargetChangedEvent } from "$lib/screenSelectionEvents";

  // Parse explicitly: Number("") and Number(null) are both 0 (a valid finite
  // number), which would mask a missing/garbled param as monitor 0. Require an
  // all-digits string so an absent param yields NaN and the Number.isFinite
  // guards below correctly reject it.
  const monitorIdParam = new URLSearchParams(location.search).get("monitorId");
  const monitorId = monitorIdParam !== null && /^\d+$/.test(monitorIdParam) ? Number(monitorIdParam) : NaN;

  let hovered = $state(false);
  let selectionPending = $state(false);
  let selectionCancelling = $state(false);

  function setHovered(nextHovered: boolean) {
    hovered = nextHovered;
    if (Number.isFinite(monitorId) && !selectionPending) {
      void emit(screenTargetChangedEvent, { monitorId, hovered: nextHovered });
    }
  }

  async function selectScreen() {
    if (selectionPending || selectionCancelling || !Number.isFinite(monitorId)) return;
    void emit(screenTargetChangedEvent, { monitorId, hovered: false });
    selectionPending = true;
    try {
      const result = await commands.finishScreenSelection(monitorId);
      if (result.status === "error") selectionPending = false;
    } catch {
      selectionPending = false;
    }
  }

  async function cancelSelection() {
    if (selectionPending || selectionCancelling) return;
    selectionCancelling = true;
    try {
      const result = await commands.cancelScreenSelection();
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
  <title>ScreenPick Display Overlay</title>
</svelte:head>

<main aria-label="Screen capture overlay">
  <button
    type="button"
    class:hovered={hovered && !selectionPending}
    aria-label="Capture this display"
    disabled={selectionPending || selectionCancelling}
    onpointerenter={() => setHovered(true)}
    onpointerleave={() => setHovered(false)}
    onclick={() => void selectScreen()}
  ></button>
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
    background: transparent;
  }

  button {
    position: fixed;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    cursor: crosshair;
    appearance: none;
    outline: none;
    background: transparent;
    border: 4px solid transparent;
    user-select: none;
  }

  button.hovered {
    border-color: #d73535;
    box-shadow:
      inset 0 0 0 2px rgba(255, 255, 255, 0.92),
      0 0 0 1px rgba(215, 53, 53, 0.72);
  }

  button:disabled {
    cursor: wait;
  }
</style>
