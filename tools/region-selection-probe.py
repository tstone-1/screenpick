# Run `npm run dev -- --host 127.0.0.1` first, then:
# uv run --with playwright --with pillow python tools/region-selection-probe.py
# Use a freshly started dev server; builds and Svelte sync can reload the page
# and invalidate the editor instance, so run those before this probe.
# Uses synthetic pixels and a mocked native clipboard; no installed app or user
# captures are touched. Verifies live rendering independently of canvas export.
import json
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    page.goto(os.environ.get('SCREENPICK_TEST_URL', 'http://127.0.0.1:1420/'))
    page.wait_for_selector('.canvas-stage')
    page.evaluate('''async () => {
      const {editor} = await import('/src/lib/editor.svelte.ts');
      window.testEditor = editor;
      window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
        if (cmd === 'copy_png_bytes_to_clipboard') { window.copiedBytes = Array.from(args.bytes); return null; }
        throw new Error('Native command unavailable in browser probe: ' + cmd);
      }};
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 600, 400);
      ctx.fillStyle = '#ff0000'; ctx.fillRect(50, 50, 80, 60);
      editor.openCapture({mode:'region', title:'Synthetic selection test', path:'/synthetic.png', assetUrl:canvas.toDataURL(), width:600, height:400});
      editor.setEditorZoom(1);
    }''')
    page.get_by_role('button', name='Rectangular selection', exact=True).click()
    frame = page.locator('.image-frame').bounding_box()
    def drag(x1, y1, x2, y2):
        page.mouse.move(frame['x'] + x1, frame['y'] + y1)
        page.mouse.down()
        page.mouse.move(frame['x'] + x2, frame['y'] + y2, steps=5)
        page.mouse.up()
    drag(130, 110, 50, 50)
    assert page.evaluate('testEditor.regionRect') == dict(x=50, y=50, width=80, height=60)
    page.keyboard.press('Control+c')
    page.wait_for_function('testEditor.regionClipboard !== null && !testEditor.regionPending')
    assert page.evaluate('copiedBytes.length') > 0
    page.keyboard.press('Control+v')
    page.wait_for_selector('.pasted-section')
    drag(95, 90, 295, 190)
    bounds = page.evaluate('testEditor.annotations[0].rect')
    assert bounds == dict(x=266, y=166, width=80, height=60), bounds
    # Cut another copy using the visible properties controls.
    page.get_by_role('button', name='Rectangular selection', exact=True).click()
    drag(50, 50, 130, 110)
    page.locator('.crop-actions').get_by_role('button', name='Cut', exact=True).click()
    page.wait_for_selector('.cut-source')
    page.locator('.crop-actions').get_by_role('button', name='Paste', exact=True).click()
    page.wait_for_function('testEditor.annotations.length === 3')
    drag(95, 90, 445, 240)
    # Add a mark over the pasted object; it must be painted after the image.
    page.evaluate('''() => {
      testEditor.annotations = [...testEditor.annotations, {kind:'shape', id:999, shape:'rectangle', rect:{x:420,y:220,width:20,height:20}, color:'#0000ff', width:0, fill:true, fillOpacity:1}];
      testEditor.clearSelection();
    }''')
    result = page.evaluate('''async () => {
      const {renderFlattenedPng, renderSelectionPng} = await import('/src/lib/annotationRendering.ts');
      const {serializeAnnotations, deserializeAnnotations} = await import('/src/lib/annotations.ts');
      const saved = serializeAnnotations(testEditor.annotations);
      const restored = deserializeAnnotations(saved);
      const bytes = await renderFlattenedPng(testEditor.document.capture, restored);
      const image = await createImageBitmap(new Blob([bytes], {type:'image/png'}));
      const canvas = document.createElement('canvas'); canvas.width=600; canvas.height=400;
      const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
      const pixel=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
      const crop = await renderSelectionPng(testEditor.document.capture, restored, {x:416,y:216,width:80,height:60});
      const cropImage = await createImageBitmap(await (await fetch(crop)).blob());
      const cropCanvas = document.createElement('canvas'); cropCanvas.width=80; cropCanvas.height=60;
      const cropCtx = cropCanvas.getContext('2d'); cropCtx.drawImage(cropImage,0,0);
      if (Array.from(cropCtx.getImageData(9,9,1,1).data).join() !== '0,0,255,255') throw new Error('Selection omitted annotation pixels');
      return {source:pixel(70,70), copied:pixel(290,190), moved:pixel(460,250), annotation:pixel(425,225), restored:restored.length, crop:[cropImage.width,cropImage.height]};
    }''')
    assert result == dict(source=[255,255,255,255], copied=[255,0,0,255], moved=[255,0,0,255], annotation=[0,0,255,255], restored=4, crop=[80,60]), result
    # Pixel checks on the actual live preview, independent of the export renderer.
    shot = page.locator('.image-frame').screenshot()
    from PIL import Image
    from io import BytesIO
    live = Image.open(BytesIO(shot)).convert('RGB')
    assert live.getpixel((71,71)) == (255,255,255)
    assert live.getpixel((291,191)) == (255,0,0)
    assert live.getpixel((461,251)) == (255,0,0)
    assert live.getpixel((426,226)) == (0,0,255)
    assert all(live.getpixel((x,y)) == (255,255,255) for x in range(48,132) for y in range(48,112)), 'Cut left source-edge pixels behind'
    print('[PASS] rectangle drag, Copy/Cut/Paste controls and shortcuts, moving, PNG pixels, live preview pixels, annotation restore:', json.dumps(result))
    browser.close()
