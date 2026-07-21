<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { LoaderCircle, Monitor, RefreshCcw, X } from "@lucide/svelte";

  import { commands, type CapturableMonitor } from "$lib/bindings";
  import { screenTargetChangedEvent, type ScreenTargetChanged } from "$lib/screenSelectionEvents";

  let screens = $state<CapturableMonitor[]>([]);
  let status = $state("Loading displays");
  let selectionPendingId = $state<number | null>(null);
  let selectionCancelling = $state(false);
  let targetedDisplayId = $state<number | null>(null);

  async function loadScreens() {
    status = "Loading displays";
    try {
      const result = await commands.listScreensForSelection();
      if (result.status === "error") {
        status = result.error || "Unable to list displays";
        return;
      }
      screens = result.data;
      status =
        screens.length === 0
          ? "No displays found"
          : `${screens.length} ${screens.length === 1 ? "display" : "displays"}`;
    } catch (error) {
      status = error instanceof Error ? error.message : "Unable to list displays";
    }
  }

  async function selectScreen(screen: CapturableMonitor) {
    if (selectionPendingId !== null || selectionCancelling) return;
    selectionPendingId = screen.id;
    targetedDisplayId = null;
    try {
      const result = await commands.finishScreenSelection(screen.id);
      if (result.status === "error") selectionPendingId = null;
    } catch {
      selectionPendingId = null;
    }
  }

  async function cancelSelection() {
    if (selectionPendingId !== null || selectionCancelling) return;
    selectionCancelling = true;
    targetedDisplayId = null;
    try {
      const result = await commands.cancelScreenSelection();
      if (result.status === "error") selectionCancelling = false;
    } catch {
      selectionCancelling = false;
    }
  }

  function displayName(screen: CapturableMonitor): string {
    return screen.friendlyName || screen.name || `Display ${screen.id}`;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      void cancelSelection();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeydown);
    void loadScreens();
    const unlistenTargetChanged = listen<ScreenTargetChanged>(screenTargetChangedEvent, (event) => {
      const { monitorId, hovered } = event.payload;
      if (hovered) {
        targetedDisplayId = monitorId;
      } else if (targetedDisplayId === monitorId) {
        targetedDisplayId = null;
      }
    });

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      void unlistenTargetChanged.then((unlisten) => unlisten());
    };
  });
</script>

<svelte:head>
  <title>ScreenPick Display</title>
</svelte:head>

<main>
  <header>
    <div>
      <h1>Screen Capture</h1>
      <span>{status}</span>
    </div>
    <div class="header-actions">
      <button type="button" title="Refresh" aria-label="Refresh" onclick={() => void loadScreens()}>
        <RefreshCcw size={17} />
      </button>
      <button type="button" title="Cancel" aria-label="Cancel" onclick={() => void cancelSelection()}>
        <X size={18} />
      </button>
    </div>
  </header>

  <section aria-label="Displays">
    {#each screens as screen}
      <button
        type="button"
        class:primary={screen.primary}
        class:targeted={targetedDisplayId === screen.id}
        class:pending={selectionPendingId === screen.id}
        disabled={selectionPendingId !== null || selectionCancelling}
        onclick={() => void selectScreen(screen)}
      >
        <span class="screen-icon">
          {#if selectionPendingId === screen.id}
            <span class="icon-loading"><LoaderCircle size={22} /></span>
          {:else}
            <Monitor size={22} />
          {/if}
        </span>
        <span class="screen-text">
          <strong>{displayName(screen)}</strong>
          <small>{screen.width} x {screen.height} • {(screen.scaleFactor ?? 1).toFixed(2)}x scale</small>
          <small>Origin {screen.x}, {screen.y}</small>
        </span>
        {#if screen.primary}
          <span class="badge">Primary</span>
        {/if}
      </button>
    {:else}
      <div class="empty">No displays available</div>
    {/each}
  </section>
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    color: #252a31;
    background: #f4f6f8;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  main {
    display: grid;
    grid-template-rows: auto 1fr;
    gap: 12px;
    min-height: 100vh;
    padding: 16px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  h1 {
    margin: 0;
    font-size: 18px;
    line-height: 24px;
  }

  header span,
  small {
    color: #66717f;
    font-size: 12px;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .header-actions button {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    color: #46515f;
    background: #ffffff;
    border: 1px solid #d9dee5;
    border-radius: 8px;
  }

  section {
    display: grid;
    align-content: start;
    gap: 8px;
    min-height: 0;
    overflow: auto;
  }

  section > button {
    display: grid;
    grid-template-columns: 44px 1fr auto;
    align-items: center;
    gap: 11px;
    width: 100%;
    min-height: 78px;
    padding: 10px;
    color: #252a31;
    background: #ffffff;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
    text-align: left;
  }

  section > button:hover:not(:disabled),
  section > button.primary {
    border-color: #1c7c6d;
  }

  section > button.targeted {
    border-color: #d73535;
    box-shadow:
      inset 0 0 0 1px rgba(215, 53, 53, 0.32),
      0 0 0 1px rgba(215, 53, 53, 0.18);
  }

  section > button.pending,
  section > button.pending:hover:not(:disabled) {
    border-color: #3b82f6;
    box-shadow:
      inset 0 0 0 1px rgba(59, 130, 246, 0.32),
      0 0 0 1px rgba(59, 130, 246, 0.18);
    background: linear-gradient(-45deg, #ffffff 0%, #eef6ff 50%, #ffffff 100%);
    background-size: 200% 200%;
    animation: pending-shimmer 1.6s ease-in-out infinite;
  }

  @keyframes pending-shimmer {
    0% {
      background-position: 0% 50%;
    }
    50% {
      background-position: 100% 50%;
    }
    100% {
      background-position: 0% 50%;
    }
  }

  section > button.pending {
    opacity: 1;
    cursor: wait;
  }

  section > button:disabled {
    cursor: wait;
    opacity: 0.68;
  }

  .screen-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 36px;
    color: #ffffff;
    background: #1c7c6d;
    border-radius: 8px;
  }

  .icon-loading {
    display: grid;
    place-items: center;
    animation: spin 1s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    section > button.pending,
    section > button.pending:hover:not(:disabled),
    .icon-loading {
      animation: none;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .screen-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    padding: 4px 6px;
    color: #1c7c6d;
    background: #e5f4f1;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
  }

  .empty {
    display: grid;
    place-items: center;
    min-height: 110px;
    color: #66717f;
    background: #ffffff;
    border: 1px dashed #cbd3dd;
    border-radius: 8px;
    font-size: 13px;
  }
</style>
