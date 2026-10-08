import { SuperSplatPreview } from '../supersplat-preview.js';
const root = document.getElementById('preview');
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
let preview;
document.getElementById('run').addEventListener('click', async () => {
  const run = document.getElementById('run'), status = document.getElementById('status');
  run.disabled = true; status.textContent = '验证中';
  const report = { checks: [], samples: [] };
  const check = (ok, name) => {
    report.checks.push({ok: !!ok, name});
    const li = document.createElement('li'); li.className = ok ? 'pass' : 'fail';
    li.textContent = `${ok ? 'PASS' : 'FAIL'} · ${name}`; document.getElementById('results').append(li);
  };
  try {
    preview?.dispose(); document.getElementById('results').replaceChildren();
    preview = new SuperSplatPreview({rootElement: root});
    const handle = await preview.load('./interaction.ply', {modelKey: 'test:moving-render'});
    check(handle.app.graphicsDevice.deviceType === 'webgl2', '使用 WebGL2');
    check(handle.app.scene.gsplat.antiAlias, '启用高斯抗锯齿');
    const canvas = root.querySelector('canvas');
    const sampled = document.createElement('canvas'); sampled.width = 96; sampled.height = 64;
    const ctx = sampled.getContext('2d', {willReadFrequently: true});
    // Sample inside the rendered frame, before the browser discards the WebGL
    // backbuffer. captureFrame is deliberately avoided: it waits for sorting
    // and would hide transient failures during camera movement.
    let recording = false, counts = [];
    const record = () => {
      if (!recording) return;
      ctx.drawImage(canvas, 0, 0, 96, 64);
      const pixels = ctx.getImageData(0, 0, 96, 64).data;
      let lit = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i+1] + pixels[i+2] > 80) lit++;
      counts.push(lit);
    };
    handle.app.on('postrender', record);
    try {
      preview.legacy.enter(); preview.legacy.parallax = false;
      preview.legacy.camera.position.set(0, 0, preview.legacy.radius * 3);
      preview.legacy.controls.target.copy(preview.legacy.center);
      preview.legacy.controls.update(0);
      for (let i = 0; i < 8; i++) await frame();
      for (const motion of ['rotate', 'pan', 'zoom']) {
        counts = []; recording = true;
        for (let i = 0; i < 32; i++) {
          if (motion === 'rotate') preview.legacy.controls._rotateLeft(.015);
          if (motion === 'pan') preview.legacy.controls._pan(i < 16 ? 2 : -2, 0);
          if (motion === 'zoom') {
            const offset = preview.legacy.camera.position.clone().sub(preview.legacy.controls.target);
            preview.legacy.camera.position.copy(preview.legacy.controls.target).addScaledVector(offset, i < 16 ? .985 : 1/.985);
          }
          await frame();
        }
        recording = false;
        const min = Math.min(...counts), max = Math.max(...counts);
        report.samples.push({motion, frames: counts.length, minLitPixels: min, maxLitPixels: max});
        check(counts.length >= 24 && min > 100, `${motion} 连续屏幕帧存在模型（${counts.length} 帧，最少 ${min} 个亮像素）`);
      }
    } finally { handle.app.off('postrender', record); }
    check(preview.handle.state.loaded, '移动后模型保持可交互');
  } catch (error) { check(false, error.stack || String(error)); }
  finally {
    report.passed = report.checks.filter(check => check.ok).length;
    report.failed = report.checks.length - report.passed;
    document.getElementById('report').textContent = JSON.stringify(report, null, 2);
    status.textContent = `${report.passed} 项通过，${report.failed} 项失败`; run.disabled = false;
  }
});
window.addEventListener('pagehide', () => preview?.dispose());
