<script lang="ts">
  import { onMount } from "svelte";
  import { capture } from "$lib/captureOrchestration.svelte";
  import {
    editor,
    type Annotation,
    type ArrowAnnotation,
    type BlurAnnotation,
    type CutSeamAnnotation,
    type EraseStroke,
    type HighlightAnnotation,
    type PenStroke,
    type ShapeAnnotation
  } from "$lib/editor.svelte";
  import {
    annotationsInPaintOrder,
    cutSeamPoints,
    polygonShapePoints,
    CUT_SEAM_CASING_COLOR,
    CUT_SEAM_CASING_EXTRA_WIDTH
  } from "$lib/annotations";
  import {
    cropStyle,
    eraserStyle,
    samplePreviewStyle,
    selectionStyle
  } from "$lib/editorStyles";
  import { suppressMiddleClickAutoscroll, targetIsEditable } from "$lib/domUtils";

  // Drive the on-screen SVG paint order from the same helper the canvas
  // export uses, so adding a new kind only requires touching the per-kind
  // {#snippet} below — not a parallel hand-coded paint order.
  // Text is rendered as HTML in a sibling .text-annotation-layer, so we
  // filter it out here.
  const svgAnnotations = $derived(
    annotationsInPaintOrder(
      [
        ...editor.annotations,
        editor.blurDraft,
        editor.highlightDraft,
        editor.penDraft,
        editor.arrowDraft,
        editor.shapeDraft
      ].filter((a): a is Annotation => a !== null)
    ).filter((a) => a.kind !== "text" && a.kind !== "cut" && a.kind !== "erase")
  );
  const cutAnnotations = $derived(
    editor.annotations.filter((annotation): annotation is CutSeamAnnotation => annotation.kind === "cut")
  );
  // Image-eraser strokes (committed + in-flight draft) live in their own bottom
  // layer directly over the screenshot, below every other annotation.
  const eraseAnnotations = $derived(
    [
      ...editor.annotations.filter((a): a is EraseStroke => a.kind === "erase"),
      ...(editor.eraseAreaDraft ? [editor.eraseAreaDraft] : [])
    ]
  );

  function erasePath(points: { x: number; y: number }[]): string {
    const [first, ...rest] = points;
    if (!first) return "";
    return rest.reduce((path, p) => `${path} L ${p.x} ${p.y}`, `M ${first.x} ${first.y}`);
  }

  // Instance-scoped id for the transparent-erase checkerboard pattern. A global
  // id would collide if two EditorStage components ever mount at once (the app
  // shows one editor today, but this keeps `url(#...)` resolving to *our* defs).
  const checkerPatternId = $props.id();

  let ignoreNextTextBlur = false;

  // Crop and cut are drag-a-rect-from-the-edge gestures, so grabbing the
  // outermost pixel row/column means starting the press exactly on the image
  // border — fiddly, because .image-frame is sized to the pixel. This gutter is
  // a transparent, larger interaction surface sitting just behind .image-frame:
  // presses in the image area still hit .image-frame (it stacks on top), while
  // presses in the surrounding margin land here and forward to the same crop/cut
  // handlers. #pointInImage clamps to [0,width]/[0,height], so an off-image
  // start resolves to the edge — you can sweep in from outside instead of
  // pixel-hunting the border. Only mounted for the two tools that need it.
  const DRAG_GUTTER = 48;

  // Holding Space temporarily turns any tool into a hand/pan gesture (the
  // Photoshop/Figma convention), so the user can reposition the preview without
  // leaving the tool they're drawing with. Tracked here rather than in the
  // editor because it's purely a view affordance of this component.
  let spaceHeld = $state(false);

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (!editor.document || targetIsEditable(event.target)) return;
      // Stop Space from scrolling the page or activating a focused button.
      event.preventDefault();
      spaceHeld = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld = false;
    };
    // Releasing the key while another window has focus would otherwise leave
    // the pan gesture armed forever.
    const onWindowBlur = () => {
      spaceHeld = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  });

  // Pan when the middle button is used, or when Space is held with the left
  // button — neither collides with a tool's own left-button draw gesture.
  function isPanTrigger(event: PointerEvent): boolean {
    return event.button === 1 || (spaceHeld && event.button === 0);
  }

  // suppressMiddleClickAutoscroll (imported from domUtils) is used as an
  // action here rather than an `onmousedown` attribute, which Svelte's a11y
  // lint flags on a non-interactive element (pointer-event attributes are
  // exempt, plain mouse ones aren't) — same reason +page.svelte's Recent list
  // uses it as an action too (N2 in the 2026-07 code review).

  function handleCanvasWheel(event: WheelEvent) {
    if (!event.ctrlKey || !editor.document) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const factor = direction > 0 ? 1.1 : 1 / 1.1;
    editor.setEditorZoom(editor.document.zoom * factor);
  }

  function suppressBrowserContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  // Two tools have caller-side wrapping concerns that don't belong in the
  // editor's pointer handlers: text needs to track focus-blur intent for the
  // <input>, and color needs to route the sample-result message through the
  // capture orchestrator. Everything else dispatches straight through the
  // editor's `tools` registry.
  function handleImagePointerDown(event: PointerEvent) {
    if (isPanTrigger(event)) {
      event.preventDefault();
      editor.startPan(event);
      return;
    }
    if (editor.activeTool === "text") {
      const hadTextDraft = !!editor.textDraft;
      editor.startTextDraft(event);
      ignoreNextTextBlur = hadTextDraft && !!editor.textDraft;
      return;
    }
    if (editor.activeTool === "color") {
      void editor.commitColorSample(event).then((message) => {
        if (message) capture.setActivity(message);
      });
      return;
    }
    void editor.tools[editor.activeTool].onPointerDown?.(event);
  }

  function handleImagePointerMove(event: PointerEvent) {
    if (editor.panning) {
      editor.updatePan(event);
      return;
    }
    void editor.tools[editor.activeTool].onPointerMove?.(event);
  }

  function handleImagePointerUp(event: PointerEvent) {
    if (editor.panning) {
      editor.finishPan();
      return;
    }
    editor.tools[editor.activeTool].onPointerUp?.(event);
  }

  function handleImagePointerCancel() {
    if (editor.panning) {
      editor.finishPan();
      return;
    }
    editor.tools[editor.activeTool].onPointerCancel?.();
  }

  function handleTextInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    editor.updateTextDraft(target.value);
  }

  function handleTextKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      editor.commitTextDraft();
    }
  }

  function handleTextBlur() {
    if (!editor.textDraft) return;
    if (ignoreNextTextBlur) {
      ignoreNextTextBlur = false;
      return;
    }
    editor.commitTextDraft();
  }

  function keepTextDraftFocus(event: PointerEvent) {
    event.stopPropagation();
  }

  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

<div class="canvas-stage" bind:this={editor.canvasStage} onwheel={handleCanvasWheel}>
  <div class="ruler horizontal"></div>
  <div class="ruler vertical"></div>
  {#if editor.document}
    {@const visibleCrop = editor.cropDraft ?? editor.cropRect}
    <div class="canvas">
      {#if editor.activeTool === "crop" || editor.activeTool === "cut"}
        <div
          class="drag-gutter"
          aria-hidden="true"
          style={`width: ${editor.document.capture.width * editor.document.zoom + DRAG_GUTTER * 2}px; height: ${editor.document.capture.height * editor.document.zoom + DRAG_GUTTER * 2}px; transform: translate(${editor.document.panX}px, ${editor.document.panY}px);`}
          onpointerdown={handleImagePointerDown}
          onpointermove={handleImagePointerMove}
          onpointerup={handleImagePointerUp}
          onpointercancel={handleImagePointerCancel}
        ></div>
      {/if}
      <div
        class="image-frame"
        class:select-active={editor.activeTool === "select"}
        class:crop-active={editor.activeTool === "crop"}
        class:cut-active={editor.activeTool === "cut"}
        class:pen-active={editor.activeTool === "pen"}
        class:arrow-active={editor.activeTool === "arrow"}
        class:shape-active={editor.activeTool === "shape"}
        class:highlight-active={editor.activeTool === "highlight"}
        class:blur-active={editor.activeTool === "blur"}
        class:text-active={editor.activeTool === "text"}
        class:color-active={editor.activeTool === "color"}
        class:erase-active={editor.activeTool === "erase"}
        class:erase-area-active={editor.activeTool === "erase-area"}
        class:hand-active={editor.activeTool === "hand"}
        class:pan-armed={spaceHeld || editor.activeTool === "hand"}
        class:panning={editor.panning}
        role="application"
        aria-label="Capture editor image"
        bind:this={editor.imageFrame}
        style={`width: ${editor.document.capture.width * editor.document.zoom}px; height: ${editor.document.capture.height * editor.document.zoom}px; transform: translate(${editor.document.panX}px, ${editor.document.panY}px);`}
        use:suppressMiddleClickAutoscroll
        onpointerdown={handleImagePointerDown}
        onpointermove={handleImagePointerMove}
        onpointerup={handleImagePointerUp}
        onpointercancel={handleImagePointerCancel}
        onpointerleave={() => {
          if (editor.activeTool === "color") editor.clearColorSample();
          if (editor.activeTool === "erase") editor.clearEraserPointer();
          if (editor.activeTool === "erase-area") editor.clearEraseAreaPointer();
        }}
        oncontextmenu={suppressBrowserContextMenu}
      >
        <img
          class="capture-preview"
          src={editor.document.capture.assetUrl}
          alt={editor.document.capture.title}
        />
        {#snippet renderErase(erase: EraseStroke)}
          {@const paint = erase.color ?? `url(#${checkerPatternId})`}
          {#if erase.points.length < 2}
            <circle cx={erase.points[0].x} cy={erase.points[0].y} r={erase.width / 2} fill={paint} />
          {:else}
            <path
              d={erasePath(erase.points)}
              fill="none"
              stroke={paint}
              stroke-width={erase.width}
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          {/if}
        {/snippet}
        {#if eraseAnnotations.length > 0}
          <svg
            class="erase-layer"
            viewBox={`0 0 ${editor.document.capture.width} ${editor.document.capture.height}`}
            aria-hidden="true"
          >
            <defs>
              <pattern id={checkerPatternId} width="12" height="12" patternUnits="userSpaceOnUse">
                <rect width="12" height="12" fill="#ffffff" />
                <rect width="6" height="6" fill="#c9ced6" />
                <rect x="6" y="6" width="6" height="6" fill="#c9ced6" />
              </pattern>
            </defs>
            {#each eraseAnnotations as erase (erase.id)}
              {@render renderErase(erase)}
            {/each}
          </svg>
        {/if}
        {#snippet renderCutSeam(seam: CutSeamAnnotation)}
          {@const points = cutSeamPoints(seam)
            .map((p) => `${p.x},${p.y}`)
            .join(" ")}
          <polyline
            {points}
            stroke={CUT_SEAM_CASING_COLOR}
            stroke-width={seam.width + CUT_SEAM_CASING_EXTRA_WIDTH}
            fill="none"
            stroke-linejoin="round"
          />
          <polyline {points} stroke={seam.color} stroke-width={seam.width} fill="none" stroke-linejoin="round" />
        {/snippet}
        {#if cutAnnotations.length > 0}
          <svg
            class="cut-seam-layer"
            viewBox={`0 0 ${editor.document.capture.width} ${editor.document.capture.height}`}
            aria-hidden="true"
          >
            {#each cutAnnotations as seam (seam.id)}
              {@render renderCutSeam(seam)}
            {/each}
          </svg>
        {/if}
        {#if editor.annotations.some((a) => a.kind === "blur") || editor.blurDraft}
          <div class="blur-layer">
            {#each editor.annotations as annotation (annotation.id)}
              {#if annotation.kind === "blur"}
                <div
                  class="blur-rect"
                  style={`left:${annotation.rect.x * editor.document.zoom}px;top:${annotation.rect.y * editor.document.zoom}px;width:${annotation.rect.width * editor.document.zoom}px;height:${annotation.rect.height * editor.document.zoom}px;backdrop-filter:blur(${annotation.radius * editor.document.zoom}px);`}
                ></div>
              {/if}
            {/each}
            {#if editor.blurDraft}
              <div
                class="blur-rect draft"
                style={`left:${editor.blurDraft.rect.x * editor.document.zoom}px;top:${editor.blurDraft.rect.y * editor.document.zoom}px;width:${editor.blurDraft.rect.width * editor.document.zoom}px;height:${editor.blurDraft.rect.height * editor.document.zoom}px;backdrop-filter:blur(${editor.blurDraft.radius * editor.document.zoom}px);`}
              ></div>
            {/if}
          </div>
        {/if}
        {#snippet renderPen(stroke: PenStroke)}
          <path d={editor.strokePath(stroke)} stroke={stroke.color} stroke-width={stroke.width} />
        {/snippet}
        {#snippet renderArrow(arrow: ArrowAnnotation)}
          {@const geom = editor.arrowGeometry(arrow)}
          {#if geom.hasLine}
            <line
              x1={arrow.start.x}
              y1={arrow.start.y}
              x2={geom.base.x}
              y2={geom.base.y}
              stroke={arrow.color}
              stroke-width={arrow.width}
            />
          {/if}
          <polygon points={geom.head} fill={arrow.color} />
        {/snippet}
        {#snippet renderShape(shape: ShapeAnnotation)}
          {@const fillColor = shape.fill ? shape.color : "transparent"}
          {@const fillOpacity = shape.fill ? shape.fillOpacity : 0}
          {#if shape.shape === "rectangle"}
            <rect
              x={shape.rect.x}
              y={shape.rect.y}
              width={shape.rect.width}
              height={shape.rect.height}
              stroke={shape.color}
              stroke-width={shape.width}
              fill={fillColor}
              fill-opacity={fillOpacity}
            />
          {:else if shape.shape === "ellipse"}
            <ellipse
              cx={shape.rect.x + shape.rect.width / 2}
              cy={shape.rect.y + shape.rect.height / 2}
              rx={shape.rect.width / 2}
              ry={shape.rect.height / 2}
              stroke={shape.color}
              stroke-width={shape.width}
              fill={fillColor}
              fill-opacity={fillOpacity}
            />
          {:else}
            <polygon
              points={polygonShapePoints(shape.shape, shape.rect)
                .map((p) => `${p.x},${p.y}`)
                .join(" ")}
              stroke={shape.color}
              stroke-width={shape.width}
              stroke-linejoin="round"
              fill={fillColor}
              fill-opacity={fillOpacity}
            />
          {/if}
        {/snippet}
        {#snippet renderHighlight(highlight: HighlightAnnotation)}
          <rect
            x={highlight.rect.x}
            y={highlight.rect.y}
            width={highlight.rect.width}
            height={highlight.rect.height}
            fill={highlight.color}
            fill-opacity={highlight.opacity}
            stroke="none"
          />
        {/snippet}
        {#snippet renderBlur(blur: BlurAnnotation)}
          <rect
            x={blur.rect.x}
            y={blur.rect.y}
            width={blur.rect.width}
            height={blur.rect.height}
            fill="none"
            stroke="#6b7280"
            stroke-width="1"
          />
        {/snippet}
        {#if svgAnnotations.length > 0}
          <svg
            class="annotation-layer"
            viewBox={`0 0 ${editor.document.capture.width} ${editor.document.capture.height}`}
            aria-hidden="true"
          >
            {#each svgAnnotations as annotation (annotation.id)}
              {#if annotation.kind === "blur"}
                {@render renderBlur(annotation)}
              {:else if annotation.kind === "highlight"}
                {@render renderHighlight(annotation)}
              {:else if annotation.kind === "pen"}
                {@render renderPen(annotation)}
              {:else if annotation.kind === "arrow"}
                {@render renderArrow(annotation)}
              {:else if annotation.kind === "shape"}
                {@render renderShape(annotation)}
              {/if}
            {/each}
          </svg>
        {/if}
        {#if editor.textDraft || editor.annotations.some((a) => a.kind === "text")}
          <div class="text-annotation-layer">
            {#each editor.annotations as annotation (annotation.id)}
              {#if annotation.kind === "text"}
                <div
                  class="text-annotation"
                  class:has-background={annotation.background}
                  style={editor.textStyle(annotation)}
                >
                  {annotation.text}
                </div>
              {/if}
            {/each}
            {#if editor.textDraft}
              {@const draft = editor.textDraft}
              <input
                type="text"
                class="text-draft-input"
                class:has-background={draft.background}
                style={editor.textStyle(draft)}
                size={Math.max(8, draft.text.length + 2)}
                value={draft.text}
                onpointerdown={keepTextDraftFocus}
                oninput={handleTextInput}
                onkeydown={handleTextKeydown}
                onblur={handleTextBlur}
                use:autofocus
              />
            {/if}
          </div>
        {/if}
        {#if editor.activeTool === "color" && editor.colorSample}
          <div class="color-sample-preview" style={samplePreviewStyle(editor.colorSample, editor.document.zoom)}>
            <span style={`background: ${editor.colorSample.color};`}></span>
          </div>
        {/if}
        {#if editor.activeTool === "erase" && editor.eraserPointer}
          <div class="eraser-preview" style={eraserStyle(editor.eraserPointer, editor.eraserRadius, editor.document.zoom)}></div>
        {/if}
        {#if editor.activeTool === "erase-area" && editor.eraseAreaPointer}
          <div class="eraser-preview" style={eraserStyle(editor.eraseAreaPointer, editor.eraseAreaWidth / 2, editor.document.zoom)}></div>
        {/if}
        {#if editor.activeTool === "select" && editor.selectedAnnotationBounds}
          <div class="selection-outline" style={selectionStyle(editor.selectedAnnotationBounds, editor.document.zoom)}>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
          </div>
        {/if}
        {#if visibleCrop && editor.activeTool === "crop"}
          <div class="crop-selection" style={cropStyle(visibleCrop, editor.document.zoom)}>
            <span>{Math.round(visibleCrop.width)} x {Math.round(visibleCrop.height)}</span>
          </div>
        {/if}
        {#if (editor.cutDraft ?? editor.cutBand) && editor.activeTool === "cut"}
          {@const visibleCut = editor.cutDraft ?? editor.cutBand}
          {#if visibleCut}
            <div class="cut-selection" style={cropStyle(visibleCut, editor.document.zoom)}>
              <svg
                viewBox={`0 0 ${visibleCut.width} ${visibleCut.height}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <polyline
                  points={editor.cutPreviewSeamPoints(visibleCut, "start")
                    .map((p) => `${p.x - visibleCut.x},${p.y - visibleCut.y}`)
                    .join(" ")}
                />
                <polyline
                  points={editor.cutPreviewSeamPoints(visibleCut, "end")
                    .map((p) => `${p.x - visibleCut.x},${p.y - visibleCut.y}`)
                    .join(" ")}
                />
              </svg>
              <span>{editor.cutAxis === "horizontal" ? Math.round(visibleCut.height) : Math.round(visibleCut.width)}px</span>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .canvas-stage {
    position: relative;
    display: grid;
    place-items: center;
    overflow: hidden;
    min-width: 0;
    background:
      linear-gradient(#d7dde4 1px, transparent 1px),
      linear-gradient(90deg, #d7dde4 1px, transparent 1px);
    background-size: 24px 24px;
  }

  .ruler {
    position: absolute;
    z-index: 1;
    background: rgba(255, 255, 255, 0.72);
  }

  .ruler.horizontal {
    top: 0;
    left: 0;
    right: 0;
    height: 22px;
    border-bottom: 1px solid #ccd3dc;
  }

  .ruler.vertical {
    top: 0;
    bottom: 0;
    left: 0;
    width: 22px;
    border-right: 1px solid #ccd3dc;
  }

  /* Only rendered once a capture is open (see the {#if editor.document} guard);
     an empty editor shows just the grid stage, not a blank white placeholder. */
  .canvas {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .capture-preview {
    position: relative;
    z-index: 0;
    display: block;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    object-fit: fill;
    background: #101418;
  }

  .image-frame {
    position: relative;
    grid-area: 1 / 1;
    overflow: hidden;
    border: 1px solid #8794a3;
    box-shadow: 0 18px 44px rgba(35, 44, 56, 0.2);
    user-select: none;
  }

  /* Transparent crop/cut interaction margin. Shares .canvas's single grid cell
     with .image-frame (both pinned to 1/1, place-items:center), so it centers on
     the same point and extends DRAG_GUTTER px past the image on every side.
     Declared before .image-frame in the markup so the frame paints on top over
     the image area; only the surrounding margin ring is hit here. */
  .drag-gutter {
    grid-area: 1 / 1;
    background: transparent;
    cursor: crosshair;
    user-select: none;
    touch-action: none;
  }

  .image-frame.select-active {
    cursor: default;
  }

  .image-frame.crop-active,
  .image-frame.cut-active,
  .image-frame.pen-active,
  .image-frame.arrow-active,
  .image-frame.shape-active,
  .image-frame.highlight-active,
  .image-frame.blur-active,
  .image-frame.color-active {
    cursor: crosshair;
  }

  .image-frame.text-active {
    cursor: text;
  }

  .image-frame.erase-active,
  .image-frame.erase-area-active {
    cursor: none;
  }

  /* Pan affordances win over the per-tool cursors above (equal specificity, so
     declared later) whenever Space is held or the Hand tool is active. */
  .image-frame.pan-armed {
    cursor: grab;
  }

  .image-frame.panning {
    cursor: grabbing;
  }

  .eraser-preview {
    position: absolute;
    z-index: 5;
    border: 1px solid #b42318;
    background: rgba(180, 35, 24, 0.08);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.92);
    border-radius: 50%;
    pointer-events: none;
  }

  .text-annotation-layer {
    position: absolute;
    z-index: 4;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }

  .text-annotation {
    position: absolute;
    white-space: pre;
    font-family: inherit;
    line-height: 1.2;
    pointer-events: none;
  }

  .text-draft-input {
    position: absolute;
    margin: 0;
    padding: 0;
    font-family: inherit;
    line-height: 1.2;
    background: transparent;
    border: 1px dashed #1c7c6d;
    border-radius: 3px;
    outline: none;
    pointer-events: auto;
  }

  .annotation-layer {
    position: absolute;
    z-index: 3;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .annotation-layer path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .cut-seam-layer {
    position: absolute;
    z-index: 1;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .cut-seam-layer polyline,
  .annotation-layer line,
  .annotation-layer rect,
  .annotation-layer ellipse {
    vector-effect: non-scaling-stroke;
  }

  .blur-layer {
    position: absolute;
    z-index: 2;
    inset: 0;
    pointer-events: none;
  }

  /* Sits directly above the screenshot and below every other overlay, so the
     image eraser only ever removes picture pixels (a checkerboard fill marks a
     transparent hole; a solid fill paints over). It shares z-index 1 with
     .cut-seam-layer; the tie is broken by DOM order — this <svg> is emitted
     before the cut layer, so erase paints *below* cut. This matches the export
     paint order (erase first). If you reorder these layers in the markup, this
     stacking flips, so keep erase ahead of cut. */
  .erase-layer {
    position: absolute;
    z-index: 1;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .blur-rect {
    position: absolute;
    overflow: hidden;
    border: 1px solid #6b7280;
  }

  .blur-rect.draft {
    border: 1px dashed #6b7280;
  }

  .selection-outline {
    position: absolute;
    z-index: 5;
    pointer-events: none;
    border: 1px solid #1c7c6d;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.88);
  }

  .selection-outline span {
    position: absolute;
    width: 7px;
    height: 7px;
    background: #ffffff;
    border: 1px solid #1c7c6d;
    border-radius: 2px;
  }

  .selection-outline span:nth-child(1) {
    top: -4px;
    left: -4px;
  }

  .selection-outline span:nth-child(2) {
    top: -4px;
    right: -4px;
  }

  .selection-outline span:nth-child(3) {
    right: -4px;
    bottom: -4px;
  }

  .selection-outline span:nth-child(4) {
    bottom: -4px;
    left: -4px;
  }

  .crop-selection {
    position: absolute;
    pointer-events: none;
    border: 2px solid #ffffff;
    box-shadow:
      0 0 0 9999px rgba(17, 24, 39, 0.34),
      0 0 0 1px #1c7c6d;
  }

  .crop-selection span {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 3px 6px;
    color: #ffffff;
    background: rgba(28, 124, 109, 0.94);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
  }

  .cut-selection {
    position: absolute;
    pointer-events: none;
    background: rgba(240, 180, 41, 0.2);
    border: 1px solid rgba(32, 36, 42, 0.32);
    box-shadow: 0 0 0 9999px rgba(17, 24, 39, 0.16);
  }

  .cut-selection svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .cut-selection polyline {
    fill: none;
    stroke: #ffffff;
    stroke-width: 2;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .cut-selection span {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 3px 6px;
    color: #20242a;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid rgba(32, 36, 42, 0.18);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
  }

  .color-sample-preview {
    position: absolute;
    z-index: 5;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 2px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(32, 36, 42, 0.5);
    pointer-events: none;
  }

  .color-sample-preview span {
    width: 18px;
    height: 18px;
    border: 1px solid rgba(32, 36, 42, 0.32);
    border-radius: 50%;
  }
</style>
