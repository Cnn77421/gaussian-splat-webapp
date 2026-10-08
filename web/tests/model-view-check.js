import { SuperSplatPreview } from '../supersplat-preview.js';
const root = document.getElementById('preview'), results = document.getElementById('results');
const run = document.getElementById('run'), status = document.getElementById('status');
run.addEventListener('click', async () => {
  run.disabled = true; results.replaceChildren(); status.textContent = '验证中';
  const key = `test:source-view:${Date.now()}`, storageKey = 'splat.view.v2.' + encodeURIComponent(key);
  const oldMode = localStorage.getItem('splat.cameraMode');
  let preview, blob, failed = 0;
  const check = (ok, name) => {
    const row = document.createElement('li'); row.className = ok ? 'pass' : 'fail';
    row.textContent = `${ok ? 'PASS' : 'FAIL'} · ${name}`; results.append(row); failed += !ok;
  };
  try {
    blob = URL.createObjectURL(await (await fetch('./interaction.ply')).blob());
    const sourceView = { coordinateSpace: 'colmap', position: [0, .6, -3], forward: [0, -.12, 1], up: [.2, -1, -.12], fov: 42 };
    preview = new SuperSplatPreview({ rootElement: root });
    const handle = await preview.load(blob, { modelKey: key, sourceView });
    const pos = handle.getCameraState().position;
    check(preview.modelView.source === 'camera' && Math.hypot(pos[0], pos[1] + .6, pos[2] + 3) < 1e-5, '原版初始相机使用本模型拍摄位置');
    check(preview.legacy.panel.querySelector('.legacy-presets button').textContent.includes('源视角'), '有拍摄数据时使用源视角标签');
    preview.legacy.enter(); preview.legacy.preset(0);
    check(Math.hypot(...preview.legacy.camera.position.toArray().map((v,i) => v - [0,-.6,-3][i])) < 1e-5 && Math.abs(preview.legacy.camera.fov - 42) < 1e-5, '原有控制源视角恢复同一位置和焦距');
    const expectedUp = [-.2, 1, -.12], length = Math.hypot(...expectedUp);
    check(Math.hypot(...preview.legacy.up.toArray().map((v,i) => v - expectedUp[i]/length)) < 1e-5, '源视角水平面使用拍摄相机朝上方向');
    preview.legacy.action('left'); preview.legacy.action('save');
    const saved = preview.preferences.read().up;
    preview.dispose(); preview = new SuperSplatPreview({ rootElement: root });
    await preview.load(blob, { modelKey: key, sourceView });
    check(preview.preferences.read().up.every((v,i) => v === saved[i]), '重新打开同一模型保留其水平面');
    preview.dispose(); preview = new SuperSplatPreview({ rootElement: root });
    await preview.load(blob, { modelKey: key + ':other' });
    check(!preview.preferences.read().up && preview.modelView.source === 'geometry', '另一模型不继承保存平面，无相机数据时使用几何取景');
    check(preview.legacy.panel.querySelector('.legacy-presets button').textContent.includes('初始视角'), '缺少拍摄数据时不冒充源视角');
  } catch (error) { check(false, error.stack || String(error)); }
  finally {
    preview?.dispose(); if (blob) URL.revokeObjectURL(blob);
    localStorage.removeItem(storageKey); localStorage.removeItem(storageKey + '%3Aother');
    if (oldMode === null) localStorage.removeItem('splat.cameraMode'); else localStorage.setItem('splat.cameraMode', oldMode);
    status.textContent = failed ? `验证失败（${failed} 项）` : '全部通过'; run.disabled = false;
  }
});
