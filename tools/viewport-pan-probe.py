# Run against a freshly started `npm run dev` (no concurrent builds/sync):
# uv run --with playwright python tools/viewport-pan-probe.py
# Synthetic images only; this browser does not connect to the native app.
import json
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(os.environ.get('SCREENPICK_TEST_URL', 'http://localhost:1420/'))
    page.wait_for_selector('.canvas-stage')
    results = page.evaluate('''async () => {
      const {editor} = await import('/src/lib/editor.svelte.ts');
      const {tick} = await import('/node_modules/svelte/src/index-client.js');
      const results=[];
      for (const [width,height] of [[600,3000],[3000,600],[3000,3000]]) {
        editor.openCapture({mode:'region',title:'Synthetic pan test',path:`/pan-${width}-${height}.png`,assetUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',width,height});
        editor.setEditorZoom(1.31);
        await tick();
        const stage=document.querySelector('.canvas-stage').getBoundingClientRect();
        const center={x:stage.x+stage.width/2,y:stage.y+stage.height/2};
        const frame=()=>document.querySelector('.image-frame').getBoundingClientRect();
        const initial=frame();
        editor.panBy(-100000,-100000); await tick();
        const end=frame();
        editor.panBy(200000,200000); await tick();
        const start=frame();
        results.push({width,height,stage:{x:stage.x,y:stage.y,width:stage.width,height:stage.height},center,
          initial:{x:initial.x,y:initial.y,width:initial.width,height:initial.height},
          end:{right:end.right,bottom:end.bottom},start:{left:start.left,top:start.top}});
      }
      return results;
    }''')
    print(json.dumps(results, indent=2))
    for result in results:
        center, stage, initial = result['center'], result['stage'], result['initial']
        assert stage['y'] + stage['height'] <= 900, 'Stage extends below window'
        assert abs(initial['x'] + initial['width']/2 - center['x']) < 1, 'Image is not centered horizontally'
        assert abs(initial['y'] + initial['height']/2 - center['y']) < 1, 'Image is not centered vertically'
        if result['height']*1.31 > stage['height']:
            assert abs(result['end']['bottom'] - center['y']) < 1, 'Bottom cannot reach viewport center'
            assert abs(result['start']['top'] - center['y']) < 1, 'Top cannot reach viewport center'
        if result['width']*1.31 > stage['width']:
            assert abs(result['end']['right'] - center['x']) < 1, 'Right cannot reach viewport center'
            assert abs(result['start']['left'] - center['x']) < 1, 'Left cannot reach viewport center'
    print('[PASS] Every screenshot edge is reachable at 131% zoom')
    browser.close()
