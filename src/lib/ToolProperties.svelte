<script lang="ts">
  import {
    BringToFront,
    Image,
    MoveDown,
    MoveUp,
    SendToBack,
    SlidersHorizontal,
    Trash2
  } from "@lucide/svelte";

  import { capture } from "$lib/captureOrchestration.svelte";
  import ColorPicker from "$lib/ColorPicker.svelte";
  import {
    editor,
    BLUR_RADIUS_MAX,
    BLUR_RADIUS_MIN,
    ERASE_AREA_WIDTH_MAX,
    ERASE_AREA_WIDTH_MIN,
    ERASER_RADIUS_MAX,
    ERASER_RADIUS_MIN,
    HIGHLIGHT_OPACITY_MAX,
    HIGHLIGHT_OPACITY_MIN,
    HIGHLIGHT_OPACITY_STEP,
    PEN_WIDTH_MAX,
    PEN_WIDTH_MIN,
    SHAPE_FILL_OPACITY_MAX,
    SHAPE_FILL_OPACITY_MIN,
    SHAPE_FILL_OPACITY_STEP,
    SHAPE_KINDS,
    SHAPE_LABELS,
    TEXT_BACKGROUND_OPACITY_MAX,
    TEXT_BACKGROUND_OPACITY_MIN,
    TEXT_BACKGROUND_OPACITY_STEP,
    TEXT_FONT_SIZE_MAX,
    TEXT_FONT_SIZE_MIN
  } from "$lib/editor.svelte";

  const hasToolPanel = $derived(
    editor.activeTool === "crop" ||
      editor.activeTool === "cut" ||
      editor.activeTool === "pen" ||
      editor.activeTool === "arrow" ||
      editor.activeTool === "shape" ||
      editor.activeTool === "text" ||
      editor.activeTool === "highlight" ||
      editor.activeTool === "blur" ||
      editor.activeTool === "color" ||
      editor.activeTool === "erase" ||
      editor.activeTool === "erase-area" ||
      (editor.activeTool === "select" && editor.selectedAnnotation !== null)
  );

  async function handleApplyCrop() {
    const message = await editor.applyCrop();
    if (message) capture.setActivity(message);
  }

  async function handleApplyCut() {
    const message = await editor.applyCut();
    if (message) capture.setActivity(message);
  }

  async function handleCopyColor() {
    const message = await editor.copyCurrentColor();
    if (message) capture.setActivity(message);
  }
</script>

{#snippet colorRow(label: string, color: string)}
  <ColorPicker
    {label}
    value={color}
    onchange={(nextColor, commitHistory) =>
      editor.updateSelectedAnnotation({ color: nextColor }, commitHistory)}
    ongesturestart={() => editor.beginSelectionEdit()}
    ongestureend={() => editor.endSelectionEdit()}
  />
{/snippet}

{#snippet rangeRow(
  labelText: string,
  value: number,
  suffix: string,
  min: number,
  max: number,
  step: number,
  update: (value: number) => void
)}
  <label>
    <span>{labelText}</span>
    <input
      type="range"
      {min}
      {max}
      {step}
      {value}
      onpointerdown={() => editor.beginSelectionEdit()}
      oninput={(event) => {
        editor.beginSelectionEdit();
        update(event.currentTarget.valueAsNumber);
      }}
      onchange={() => editor.endSelectionEdit()}
      onblur={() => editor.endSelectionEdit()}
    />
    <small>{suffix}</small>
  </label>
{/snippet}

<div class="section-heading">
  <h2>Properties</h2>
  <SlidersHorizontal size={17} />
</div>

{#if editor.document}
  <div class="image-meta">
    <div>
      <span>Image</span>
      <strong>{editor.document.capture.width} x {editor.document.capture.height}</strong>
    </div>
    <div>
      <span>Zoom</span>
      <strong>{Math.round(editor.document.zoom * 100)}%</strong>
    </div>
    <div>
      <span>Fit</span>
      <strong>{Math.round(editor.document.fitZoom * 100)}%</strong>
    </div>
  </div>

  {#if editor.activeTool === "crop"}
    <div class="crop-panel">
      <div>
        <span>Crop</span>
        <strong>
          {editor.cropRect
            ? `${Math.round(editor.cropRect.width)} x ${Math.round(editor.cropRect.height)}`
            : "Drag on image"}
        </strong>
      </div>
      <div class="crop-actions">
        <button
          type="button"
          disabled={!editor.cropRect || editor.cropPending}
          onclick={handleApplyCrop}
        >
          {editor.cropPending ? "Applying..." : "Apply"}
        </button>
        <button
          type="button"
          disabled={!editor.cropRect && !editor.cropDraft}
          onclick={() => editor.cancelCrop()}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  {#if editor.activeTool === "cut"}
    <div class="crop-panel">
      <div>
        <span>Cut</span>
        <strong>
          {editor.cutBand
            ? `${Math.round(editor.cutAxis === "horizontal" ? editor.cutBand.height : editor.cutBand.width)}px`
            : "Drag on image"}
        </strong>
      </div>
      <div class="shape-options" aria-label="Cut orientation">
        <button
          class:active={editor.cutAxis === "horizontal"}
          type="button"
          aria-pressed={editor.cutAxis === "horizontal"}
          onclick={() => {
            editor.cutAxis = "horizontal";
            editor.cancelCut();
          }}
        >
          Horizontal
        </button>
        <button
          class:active={editor.cutAxis === "vertical"}
          type="button"
          aria-pressed={editor.cutAxis === "vertical"}
          onclick={() => {
            editor.cutAxis = "vertical";
            editor.cancelCut();
          }}
        >
          Vertical
        </button>
      </div>
      <div class="crop-actions">
        <button
          type="button"
          disabled={!editor.cutBand || editor.cutPending}
          onclick={handleApplyCut}
        >
          {editor.cutPending ? "Applying..." : "Apply"}
        </button>
        <button
          type="button"
          disabled={!editor.cutBand && !editor.cutDraft}
          onclick={() => editor.cancelCut()}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  {#if editor.activeTool === "select" && editor.selectedAnnotation}
    <div class="selection-panel">
      <div>
        <span>Selected</span>
        <strong>{editor.annotationTypeLabel(editor.selectedAnnotation)}</strong>
      </div>

      {#if editor.selectedAnnotation.kind === "shape"}
        {@render colorRow("Annotation color", editor.selectedAnnotation.color)}
        {@render rangeRow(
          "Annotation width",
          editor.selectedAnnotation.width,
          `${editor.selectedAnnotation.width}px`,
          PEN_WIDTH_MIN,
          PEN_WIDTH_MAX,
          1,
          (value) => editor.updateSelectedAnnotation({ width: value }, false)
        )}

        <label class="checkbox-row">
          <span>Fill</span>
          <input
            type="checkbox"
            checked={editor.selectedAnnotation.fill}
            onchange={(event) =>
              editor.updateSelectedAnnotation({ fill: event.currentTarget.checked }, true)}
          />
        </label>

        {#if editor.selectedAnnotation.fill}
          {@render rangeRow(
            "Fill opacity",
            editor.selectedAnnotation.fillOpacity,
            `${Math.round(editor.selectedAnnotation.fillOpacity * 100)}%`,
            SHAPE_FILL_OPACITY_MIN,
            SHAPE_FILL_OPACITY_MAX,
            SHAPE_FILL_OPACITY_STEP,
            (value) => editor.updateSelectedAnnotation({ fillOpacity: value }, false)
          )}
        {/if}

      {:else if editor.selectedAnnotation.kind === "arrow" || editor.selectedAnnotation.kind === "pen"}
        {@render colorRow("Annotation color", editor.selectedAnnotation.color)}
        {@render rangeRow(
          "Annotation width",
          editor.selectedAnnotation.width,
          `${editor.selectedAnnotation.width}px`,
          PEN_WIDTH_MIN,
          PEN_WIDTH_MAX,
          1,
          (value) => editor.updateSelectedAnnotation({ width: value }, false)
        )}

      {:else if editor.selectedAnnotation.kind === "highlight"}
        {@render colorRow("Highlight color", editor.selectedAnnotation.color)}
        {@render rangeRow(
          "Opacity",
          editor.selectedAnnotation.opacity,
          `${Math.round(editor.selectedAnnotation.opacity * 100)}%`,
          HIGHLIGHT_OPACITY_MIN,
          HIGHLIGHT_OPACITY_MAX,
          HIGHLIGHT_OPACITY_STEP,
          (value) => editor.updateSelectedAnnotation({ opacity: value }, false)
        )}

      {:else if editor.selectedAnnotation.kind === "text"}
        <!-- TODO(ROADMAP "Technical debt log"): re-editing placed text CONTENT
             (vs. style) needs its own draft/commit flow. -->
        {@render colorRow("Text color", editor.selectedAnnotation.color)}
        {@render rangeRow(
          "Font size",
          editor.selectedAnnotation.fontSize,
          `${editor.selectedAnnotation.fontSize}px`,
          TEXT_FONT_SIZE_MIN,
          TEXT_FONT_SIZE_MAX,
          1,
          (value) => editor.updateSelectedAnnotation({ fontSize: value }, false)
        )}
        <label class="checkbox-row">
          <span>Background</span>
          <input
            type="checkbox"
            checked={editor.selectedAnnotation.background}
            onchange={(event) =>
              editor.updateSelectedAnnotation({ background: event.currentTarget.checked }, true)}
          />
        </label>
        {#if editor.selectedAnnotation.background}
          {@render rangeRow(
            "Background opacity",
            editor.selectedAnnotation.backgroundOpacity,
            `${Math.round(editor.selectedAnnotation.backgroundOpacity * 100)}%`,
            TEXT_BACKGROUND_OPACITY_MIN,
            TEXT_BACKGROUND_OPACITY_MAX,
            TEXT_BACKGROUND_OPACITY_STEP,
            (value) => editor.updateSelectedAnnotation({ backgroundOpacity: value }, false)
          )}
        {/if}

      {:else if editor.selectedAnnotation.kind === "blur"}
        {@render rangeRow(
          "Radius",
          editor.selectedAnnotation.radius,
          `${editor.selectedAnnotation.radius}px`,
          BLUR_RADIUS_MIN,
          BLUR_RADIUS_MAX,
          1,
          (value) => editor.updateSelectedAnnotation({ radius: value }, false)
        )}
      {/if}

      <div class="order-actions" role="group" aria-label="Stacking order">
        <!-- Frontmost means both "front" and one-step "forward" are no-ops. -->
        <button
          type="button"
          title="Bring to Front"
          aria-label="Bring to Front"
          onclick={() => editor.bringSelectedToFront()}
          disabled={editor.selectionCanBringForward === false}
        >
          <BringToFront size={16} />
        </button>
        <button
          type="button"
          title="Bring Forward"
          aria-label="Bring Forward"
          onclick={() => editor.bringSelectedForward()}
          disabled={editor.selectionCanBringForward === false}
        >
          <MoveUp size={16} />
        </button>
        <button
          type="button"
          title="Send Backward"
          aria-label="Send Backward"
          onclick={() => editor.sendSelectedBackward()}
          disabled={editor.selectionCanSendBackward === false}
        >
          <MoveDown size={16} />
        </button>
        <button
          type="button"
          title="Send to Back"
          aria-label="Send to Back"
          onclick={() => editor.sendSelectedToBack()}
          disabled={editor.selectionCanSendBackward === false}
        >
          <SendToBack size={16} />
        </button>
      </div>

      <button type="button" onclick={() => editor.deleteSelectedAnnotation()}>
        <Trash2 size={16} /> Delete
      </button>
    </div>
  {/if}

  {#if editor.activeTool === "text"}
    <div class="annotation-panel">
      <label>
        <span>Font size</span>
        <input
          type="range"
          min={TEXT_FONT_SIZE_MIN}
          max={TEXT_FONT_SIZE_MAX}
          bind:value={editor.textFontSize}
        />
        <small>{editor.textFontSize}px</small>
      </label>
      <ColorPicker label="Text color" />
      <label class="checkbox-row">
        <span>Background</span>
        <input type="checkbox" bind:checked={editor.textBackground} />
      </label>
      {#if editor.textBackground}
        <label>
          <span>Background opacity</span>
          <input
            type="range"
            min={TEXT_BACKGROUND_OPACITY_MIN}
            max={TEXT_BACKGROUND_OPACITY_MAX}
            step={TEXT_BACKGROUND_OPACITY_STEP}
            bind:value={editor.textBackgroundOpacity}
          />
          <small>{Math.round(editor.textBackgroundOpacity * 100)}%</small>
        </label>
      {/if}
    </div>
  {/if}

  {#if editor.activeTool === "pen" || editor.activeTool === "arrow" || editor.activeTool === "shape"}
    <div class="annotation-panel">
      <label>
        <span>Annotation width</span>
        <input
          type="range"
          min={PEN_WIDTH_MIN}
          max={PEN_WIDTH_MAX}
          bind:value={editor.penWidth}
        />
        <small>{editor.penWidth}px</small>
      </label>
      <ColorPicker label="Annotation color" />

      {#if editor.activeTool === "shape"}
        <div class="shape-options" aria-label="Shape type">
          {#each SHAPE_KINDS as kind}
            <button
              class:active={editor.shapeKind === kind}
              type="button"
              aria-pressed={editor.shapeKind === kind}
              onclick={() => (editor.shapeKind = kind)}
            >
              {SHAPE_LABELS[kind]}
            </button>
          {/each}
        </div>
        <label class="checkbox-row">
          <span>Fill</span>
          <input type="checkbox" bind:checked={editor.shapeFill} />
        </label>
        {#if editor.shapeFill}
          <label>
            <span>Fill opacity</span>
            <input
              type="range"
              min={SHAPE_FILL_OPACITY_MIN}
              max={SHAPE_FILL_OPACITY_MAX}
              step={SHAPE_FILL_OPACITY_STEP}
              bind:value={editor.shapeFillOpacity}
            />
            <small>{Math.round(editor.shapeFillOpacity * 100)}%</small>
          </label>
        {/if}
      {/if}
    </div>
  {/if}

  {#if editor.activeTool === "highlight"}
    <div class="annotation-panel">
      <ColorPicker label="Highlight color" />
      <label>
        <span>Opacity</span>
        <input
          type="range"
          min={HIGHLIGHT_OPACITY_MIN}
          max={HIGHLIGHT_OPACITY_MAX}
          step={HIGHLIGHT_OPACITY_STEP}
          bind:value={editor.highlightOpacity}
        />
        <small>{Math.round(editor.highlightOpacity * 100)}%</small>
      </label>
    </div>
  {/if}

  {#if editor.activeTool === "blur"}
    <div class="annotation-panel">
      <label>
        <span>Radius</span>
        <input
          type="range"
          min={BLUR_RADIUS_MIN}
          max={BLUR_RADIUS_MAX}
          bind:value={editor.blurRadius}
        />
        <small>{editor.blurRadius}px</small>
      </label>
    </div>
  {/if}

  {#if editor.activeTool === "erase"}
    <div class="annotation-panel">
      <p class="tool-hint">Removes annotations you've added — not the screenshot.</p>
      <label>
        <span>Radius</span>
        <input
          type="range"
          min={ERASER_RADIUS_MIN}
          max={ERASER_RADIUS_MAX}
          bind:value={editor.eraserRadius}
        />
        <small>{editor.eraserRadius}px</small>
      </label>
    </div>
  {/if}

  {#if editor.activeTool === "erase-area"}
    <div class="annotation-panel">
      <p class="tool-hint">Erases the screenshot itself. Brush over an area to remove it.</p>
      <div class="fill-toggle" role="group" aria-label="Erase fill">
        <button
          type="button"
          class:active={editor.eraseAreaTransparent}
          aria-pressed={editor.eraseAreaTransparent}
          onclick={() => (editor.eraseAreaTransparent = true)}
        >
          Transparent
        </button>
        <button
          type="button"
          class:active={!editor.eraseAreaTransparent}
          aria-pressed={!editor.eraseAreaTransparent}
          onclick={() => (editor.eraseAreaTransparent = false)}
        >
          Color
        </button>
      </div>
      {#if !editor.eraseAreaTransparent}
        <ColorPicker
          label="Erase color"
          value={editor.eraseAreaColor}
          onchange={(color) => (editor.eraseAreaColor = color)}
        />
      {/if}
      <label>
        <span>Brush size</span>
        <input
          type="range"
          min={ERASE_AREA_WIDTH_MIN}
          max={ERASE_AREA_WIDTH_MAX}
          bind:value={editor.eraseAreaWidth}
        />
        <small>{editor.eraseAreaWidth}px</small>
      </label>
    </div>
  {/if}

  {#if editor.activeTool === "color"}
    <div class="annotation-panel">
      <div class="sampled-color">
        <span style={`background: ${editor.penColor};`}></span>
        <strong>{editor.penColor}</strong>
      </div>
      <button type="button" onclick={() => void handleCopyColor()}>
        Copy hex
      </button>
      {#if editor.recentColors.length > 0}
        <div class="swatches" aria-label="Recent sampled colors">
          {#each editor.recentColors as color}
            <button
              class:active={editor.penColor === color}
              type="button"
              aria-label={`Recent color ${color}`}
              style={`background: ${color};`}
              onclick={() => (editor.penColor = color)}
            ></button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/if}

{#if !hasToolPanel}
  <div class="tool-placeholder">
    <Image size={18} />
    <span>Tool properties unavailable</span>
  </div>
{/if}

<style>
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    color: #5d6875;
  }

  .image-meta,
  .crop-panel,
  .selection-panel,
  .annotation-panel {
    display: grid;
    gap: 10px;
    padding: 10px;
    color: #3c4652;
    background: #ffffff;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  .image-meta {
    gap: 8px;
  }

  .image-meta div,
  .crop-panel > div:first-child,
  .selection-panel > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .image-meta span,
  .crop-panel span,
  .selection-panel span {
    color: #66717f;
    font-size: 12px;
  }

  .image-meta strong,
  .crop-panel strong,
  .selection-panel strong {
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .crop-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .crop-actions button {
    min-height: 34px;
    color: #252a31;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  .crop-actions button:first-child {
    color: #ffffff;
    background: #1c7c6d;
    border-color: #1c7c6d;
  }

  .crop-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .selection-panel > button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 34px;
    color: #ffffff;
    background: #b42318;
    border: 1px solid #b42318;
    border-radius: 8px;
  }

  .annotation-panel label,
  .selection-panel label {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px 12px;
    font-size: 12px;
    color: #66717f;
  }

  .annotation-panel label input[type="range"],
  .selection-panel label input[type="range"] {
    grid-column: 1 / -1;
    width: 100%;
    accent-color: #1c7c6d;
  }

  .annotation-panel label small,
  .selection-panel label small {
    color: #3c4652;
    font-size: 12px;
    font-weight: 700;
    justify-self: end;
  }

  .shape-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .shape-options button {
    min-height: 32px;
    color: #384350;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
  }

  .shape-options button.active {
    color: #ffffff;
    background: #1c7c6d;
    border-color: #1c7c6d;
  }

  .tool-hint {
    margin: 0;
    color: #5b6573;
    font-size: 12px;
    line-height: 1.4;
  }

  .fill-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .fill-toggle button {
    min-height: 32px;
    color: #384350;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
  }

  .fill-toggle button.active {
    color: #ffffff;
    background: #1c7c6d;
    border-color: #1c7c6d;
  }

  .order-actions {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }

  .order-actions button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    color: #384350;
    background: #f5f7f9;
    border: 1px solid #dfe4ea;
    border-radius: 8px;
  }

  .order-actions button:hover:not(:disabled) {
    color: #1c7c6d;
    background: #eef3f2;
    border-color: #1c7c6d;
  }

  .order-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .annotation-panel label.checkbox-row,
  .selection-panel label.checkbox-row {
    grid-template-columns: 1fr auto;
  }

  .annotation-panel label.checkbox-row input,
  .selection-panel label.checkbox-row input {
    width: 16px;
    height: 16px;
    accent-color: #1c7c6d;
  }

  .annotation-panel .swatches {
    display: grid;
    grid-auto-flow: column;
    justify-content: start;
    gap: 8px;
  }

  .annotation-panel .swatches button {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 2px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px #ccd3dc;
  }

  .annotation-panel .swatches button.active {
    box-shadow:
      0 0 0 2px #1c7c6d,
      0 0 0 5px #dbece9;
  }

  .tool-placeholder {
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

  .sampled-color {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 34px;
    font-size: 12px;
  }

  .sampled-color span {
    width: 24px;
    height: 24px;
    border: 1px solid #cbd3dd;
    border-radius: 50%;
  }
</style>
