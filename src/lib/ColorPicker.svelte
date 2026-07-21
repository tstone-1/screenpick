<script lang="ts">
  // Reusable color control shared by every color-bearing tool (pen, arrow,
  // shape, text, highlight). Combines the curated presets with a full custom
  // picker (native OS color wheel + hex entry) and a recents row, so users are
  // no longer limited to the five presets. Defaults to the global `penColor`;
  // call sites can pass a value/change target for selected annotations.
  import { normalizeHexColor } from "$lib/annotations";
  import { editor, PEN_COLORS } from "$lib/editor.svelte";

  type ColorPickerProps = {
    label: string;
    value?: string;
    onchange?: (color: string, commitHistory?: boolean) => void;
    ongesturestart?: () => void;
    ongestureend?: () => void;
  };

  let {
    label,
    value,
    onchange,
    ongesturestart,
    ongestureend
  }: ColorPickerProps = $props();

  let hexDraft = $state("");
  const currentColor = $derived(value ?? editor.penColor);
  const hexInvalid = $derived(hexDraft.trim().length > 0 && normalizeHexColor(hexDraft) === null);

  function applyColor(color: string, commitHistory = true): boolean {
    const normalized = normalizeHexColor(color);
    if (!normalized) return false;
    if (onchange) {
      onchange(normalized, commitHistory);
      return true;
    }
    return editor.chooseColor(normalized);
  }

  function applyHex() {
    if (applyColor(hexDraft)) hexDraft = "";
  }

  function onHexKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      applyHex();
    }
  }
</script>

<div class="color-picker">
  <div class="swatches" aria-label={label}>
    {#each PEN_COLORS as color}
      <button
        class:active={currentColor === color}
        type="button"
        aria-label={`${label} ${color}`}
        style={`background: ${color};`}
        onclick={() => applyColor(color)}
      ></button>
    {/each}
    <label class="custom-swatch" title="Custom color">
      <span class="sr-only">Custom color</span>
      <input
        type="color"
        value={currentColor}
        aria-label={`${label} custom color`}
        onpointerdown={() => ongesturestart?.()}
        oninput={(event) => {
          ongesturestart?.();
          applyColor(event.currentTarget.value, onchange ? false : true);
        }}
        onchange={() => ongestureend?.()}
        onblur={() => ongestureend?.()}
      />
    </label>
  </div>

  {#if editor.recentColors.length > 0}
    <div class="swatches recent" aria-label="Recent colors">
      {#each editor.recentColors as color}
        <button
          class:active={currentColor === color}
          type="button"
          aria-label={`Recent color ${color}`}
          style={`background: ${color};`}
          onclick={() => applyColor(color)}
        ></button>
      {/each}
    </div>
  {/if}

  <div class="hex-row">
    <span class="hex-preview" style={`background: ${currentColor};`}></span>
    <input
      class="hex-input"
      class:invalid={hexInvalid}
      type="text"
      inputmode="text"
      spellcheck="false"
      autocomplete="off"
      maxlength="7"
      placeholder={currentColor}
      bind:value={hexDraft}
      onkeydown={onHexKeydown}
      onblur={applyHex}
      aria-invalid={hexInvalid}
      aria-label="Custom hex color"
    />
  </div>
</div>

<style>
  .color-picker {
    display: grid;
    gap: 8px;
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .swatches button {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 2px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px #ccd3dc;
    cursor: pointer;
  }

  .swatches button.active {
    box-shadow:
      0 0 0 2px #1c7c6d,
      0 0 0 5px #dbece9;
  }

  .custom-swatch:focus-within {
    box-shadow:
      0 0 0 2px #1c7c6d,
      0 0 0 5px #dbece9;
  }

  /* The custom-color entry point: a rainbow ring that opens the OS color wheel.
     The native input sits transparently on top so the ring shows through. */
  .custom-swatch {
    position: relative;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid #ffffff;
    box-shadow: 0 0 0 1px #ccd3dc;
    background: conic-gradient(
      red,
      #ff8a00,
      #f0b429,
      lime,
      aqua,
      blue,
      magenta,
      red
    );
    cursor: pointer;
    overflow: hidden;
  }

  .custom-swatch input[type="color"] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    opacity: 0;
    cursor: pointer;
  }

  .hex-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .hex-preview {
    width: 22px;
    height: 22px;
    flex: none;
    border: 1px solid #cbd3dd;
    border-radius: 6px;
  }

  .hex-input {
    flex: 1;
    min-width: 0;
    min-height: 30px;
    padding: 0 8px;
    color: #252a31;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  .hex-input:focus {
    outline: none;
    border-color: #1c7c6d;
    box-shadow: 0 0 0 2px #dbece9;
  }

  .hex-input.invalid {
    border-color: #d73535;
    box-shadow: 0 0 0 2px #f8d8d8;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
