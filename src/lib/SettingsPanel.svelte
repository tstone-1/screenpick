<script lang="ts">
  import { FolderOpen, RotateCcw, X } from "@lucide/svelte";

  import { capture } from "$lib/captureOrchestration.svelte";
  import { unlockCaptureSound } from "$lib/captureSound";
  import { acceleratorFromKeyboardEvent } from "$lib/shortcutRecording";

  let recordingShortcut = $state<string | null>(null);

  function shortcutSlot(modeId: string, index: number) {
    return `${modeId}:${index}`;
  }

  function handleShortcutKeydown(event: KeyboardEvent, modeId: string, index: number) {
    event.stopPropagation();
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Escape") {
      (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      capture.setShortcutEntry(modeId, index, "");
      return;
    }
    const accelerator = acceleratorFromKeyboardEvent(event, capture.isMac);
    if (accelerator) capture.setShortcutEntry(modeId, index, accelerator);
  }

  function handleShortcutKeyup(event: KeyboardEvent, modeId: string, index: number) {
    if (event.code !== "PrintScreen") return;
    const accelerator = acceleratorFromKeyboardEvent(event, capture.isMac);
    if (accelerator) {
      event.preventDefault();
      event.stopPropagation();
      capture.setShortcutEntry(modeId, index, accelerator);
    }
  }
</script>

<section class="settings-panel" aria-label="Capture settings">
  <div class="section-heading">
    <h2>Capture Settings</h2>
  </div>

  <div class="settings-row">
    <span class="setting-label">Save folder</span>
    <div class="save-folder-input">
      <span class="folder-path">{capture.settings.saveDirectory ?? "Default (app cache)"}</span>
      <button type="button" onclick={() => void capture.pickSaveDirectory()} title="Choose folder">
        <FolderOpen size={15} />
      </button>
    </div>
  </div>

  <div class="settings-row">
    <span class="setting-label">Open editor after capture</span>
    <button
      type="button"
      class="toggle-switch"
      class:active={capture.settings.autoOpenEditor}
      onclick={() => void capture.toggleSetting("autoOpenEditor")}
      role="switch"
      aria-label={capture.settings.autoOpenEditor ? "Disable auto-open editor" : "Enable auto-open editor"}
      aria-checked={capture.settings.autoOpenEditor}
    >
      <span class="toggle-track"></span>
    </button>
  </div>

  <div class="settings-row">
    <span class="setting-label">Start ScreenPick at login</span>
    <button
      type="button"
      class="toggle-switch"
      class:active={capture.autostartEnabled}
      onclick={() => void capture.toggleAutostart()}
      role="switch"
      aria-label={capture.autostartEnabled ? "Disable start at login" : "Enable start at login"}
      aria-checked={capture.autostartEnabled}
    >
      <span class="toggle-track"></span>
    </button>
  </div>

  <div class="settings-row">
    <span class="setting-label">Bring ScreenPick to front after hotkey capture</span>
    <button
      type="button"
      class="toggle-switch"
      class:active={capture.settings.bringToFrontOnHotkeyCapture}
      onclick={() => void capture.toggleSetting("bringToFrontOnHotkeyCapture")}
      role="switch"
      aria-label={capture.settings.bringToFrontOnHotkeyCapture ? "Disable bring to front after hotkey capture" : "Enable bring to front after hotkey capture"}
      aria-checked={capture.settings.bringToFrontOnHotkeyCapture}
    >
      <span class="toggle-track"></span>
    </button>
  </div>

  <div class="settings-row">
    <span class="setting-label">Close to tray instead of quitting</span>
    <button
      type="button"
      class="toggle-switch"
      class:active={capture.settings.closeToTray}
      onclick={() => void capture.toggleSetting("closeToTray")}
      role="switch"
      aria-label={capture.settings.closeToTray ? "Disable close to tray" : "Enable close to tray"}
      aria-checked={capture.settings.closeToTray}
    >
      <span class="toggle-track"></span>
    </button>
  </div>

  {#if capture.settings.closeToTray}
    <div class="settings-row">
      <button type="button" class="quit-button" onclick={() => void capture.quitApp()}>
        Quit ScreenPick
      </button>
    </div>
  {/if}

  <div class="settings-row">
    <span class="setting-label">Copy to clipboard after capture</span>
    <button
      type="button"
      class="toggle-switch"
      class:active={capture.settings.copyToClipboard}
      onclick={() => void capture.toggleSetting("copyToClipboard")}
      role="switch"
      aria-label={capture.settings.copyToClipboard ? "Disable copy to clipboard" : "Enable copy to clipboard"}
      aria-checked={capture.settings.copyToClipboard}
    >
      <span class="toggle-track"></span>
    </button>
  </div>

  <div class="settings-row">
    <span class="setting-label">Play sound on hotkey capture</span>
    <button
      type="button"
      class="toggle-switch"
      class:active={capture.settings.playCaptureSound}
      onclick={() => {
        unlockCaptureSound();
        void capture.toggleSetting("playCaptureSound");
      }}
      role="switch"
      aria-label={capture.settings.playCaptureSound ? "Disable capture sound" : "Enable capture sound"}
      aria-checked={capture.settings.playCaptureSound}
    >
      <span class="toggle-track"></span>
    </button>
  </div>

  <div class="settings-row shortcut-section">
    <div class="section-heading">
      <span class="setting-label">Shortcut overrides</span>
      <button type="button" class="reset-shortcuts" title="Reset to defaults" onclick={() => void capture.resetShortcuts()}>
        <RotateCcw size={14} />
      </button>
    </div>
    {#each capture.captureModes as mode}
      <div class="shortcut-mode-group">
        <strong>{mode.label}</strong>
        {#each capture.getModeAccelerators(mode.id) as accelerator, i}
          <div class="shortcut-entry">
            <input
              type="text"
              readonly
              class="shortcut-input"
              class:recording={recordingShortcut === shortcutSlot(mode.id, i)}
              value={accelerator}
              placeholder={recordingShortcut === shortcutSlot(mode.id, i)
                ? "Press a shortcut..."
                : "Click, then press keys"}
              onkeydown={(event) => handleShortcutKeydown(event, mode.id, i)}
              onkeyup={(event) => handleShortcutKeyup(event, mode.id, i)}
              onfocus={() => (recordingShortcut = shortcutSlot(mode.id, i))}
              onblur={() => {
                if (recordingShortcut === shortcutSlot(mode.id, i)) recordingShortcut = null;
              }}
            />
            <button
              type="button"
              aria-label={`Remove ${mode.label} shortcut`}
              onclick={() => capture.removeShortcutEntry(mode.id, i)}
            >
              <X size={13} />
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="add-shortcut"
          onclick={() => capture.addShortcutEntry(mode.id)}
        >
          + Add shortcut
        </button>
      </div>
    {/each}
    <button
      type="button"
      class="apply-shortcuts"
      onclick={() => void capture.applyShortcutOverrides()}
    >
      Apply shortcuts
    </button>
  </div>
</section>

<style>
  button {
    border: 0;
    cursor: pointer;
    font: inherit;
  }

  button :global(svg) {
    flex-shrink: 0;
  }

  h2 {
    margin: 0;
    color: #5d6875;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .settings-panel {
    display: grid;
    gap: 10px;
    padding: 10px;
    background: #ffffff;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  .settings-row {
    display: grid;
    align-items: start;
    gap: 6px;
  }

  .setting-label {
    color: #5d6875;
    font-size: 12px;
    font-weight: 700;
  }

  .save-folder-input {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 4px 6px;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 6px;
  }

  .save-folder-input .folder-path {
    color: #3c4652;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .save-folder-input button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    color: #5d6875;
    background: #e8ecef;
    border: 1px solid #ccd3dc;
    border-radius: 5px;
  }

  .toggle-switch {
    position: relative;
    width: 40px;
    height: 22px;
    padding: 0;
    background: #cbd3dd;
    border: 0;
    border-radius: 11px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .toggle-switch.active {
    background: #1c7c6d;
  }

  .toggle-track {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    background: #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    transition: transform 0.15s;
  }

  .toggle-switch.active .toggle-track {
    transform: translateX(18px);
  }

  .shortcut-section {
    gap: 8px;
  }

  .shortcut-mode-group {
    display: grid;
    gap: 5px;
  }

  .shortcut-mode-group strong {
    color: #3c4652;
    font-size: 11px;
    text-transform: capitalize;
  }

  .shortcut-entry {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px;
  }

  .shortcut-entry input {
    min-height: 28px;
    padding: 2px 8px;
    color: #20242a;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 5px;
    font-family: inherit;
    font-size: 11px;
  }

  .shortcut-entry input.shortcut-input {
    cursor: pointer;
  }

  .shortcut-entry input.shortcut-input.recording {
    color: #1c7c6d;
    background: #ffffff;
    border-color: #1c7c6d;
    box-shadow: 0 0 0 2px rgba(28, 124, 109, 0.15);
    outline: none;
  }

  .shortcut-entry input.shortcut-input::placeholder {
    color: #97a2b0;
  }

  .shortcut-entry button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    color: #8794a3;
    background: transparent;
    border: 0;
    border-radius: 5px;
  }

  .shortcut-entry button:hover {
    color: #b42318;
    background: rgba(180, 35, 24, 0.08);
  }

  .add-shortcut,
  .apply-shortcuts {
    min-height: 28px;
    padding: 4px 10px;
    color: #5d6875;
    background: #f5f7f9;
    border: 1px dashed #cbd3dd;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
  }

  .apply-shortcuts {
    color: #ffffff;
    background: #1c7c6d;
    border: 1px solid #1c7c6d;
    margin-top: 4px;
  }

  .quit-button {
    min-height: 30px;
    padding: 5px 10px;
    color: #b42318;
    background: rgba(180, 35, 24, 0.08);
    border: 1px solid rgba(180, 35, 24, 0.3);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
  }

  .quit-button:hover {
    color: #ffffff;
    background: #b42318;
    border-color: #b42318;
  }

  .reset-shortcuts {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: #8794a3;
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }

  .reset-shortcuts:hover {
    color: #1c7c6d;
    background: rgba(28, 124, 109, 0.08);
  }
</style>
