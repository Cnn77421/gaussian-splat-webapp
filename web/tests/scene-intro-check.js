import * as THREE from 'three';
import { SparkViewer } from '../spark-viewer.js';
import { INTRO_DURATION } from '../scene-intro.js';

const root = document.getElementById('preview');
const results = document.getElementById('results');
const status = document.getElementById('status');
const run = document.getElementById('run');
const filmstrip = document.getElementById('filmstrip');
let viewer;
const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
function capture() {
  viewer.renderer.render(viewer.scene, viewer.renderCamera);
  const gl = viewer.renderer.getContext();
  const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}
function difference(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) count++;
  }
  return count;
}
function lit(pixels) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 80) count++;
  return count;
}
async function frames(n) {
  for (let i = 0; i < n; i++) {
    viewer.controls.update(1 / 60);
    if (viewer.intro.active) viewer.intro.update(1 / 60);
    else viewer.effects.update(1 / 60);
    viewer.renderCamera.copy(viewer.camera);
    if (viewer.intro.active) viewer.intro.applyCamera(viewer.renderCamera);
    viewer.renderer.render(viewer.scene, viewer.renderCamera);
    await raf();
  }
}
function snapshot(title) {
  viewer.renderer.render(viewer.scene, viewer.renderCamera);
  const figure = document.createElement('figure');
  const img = new Image();
  img.src = viewer.renderer.domElement.toDataURL('image/png');
  const caption = document.createElement('figcaption');
  caption.textContent = title;
  figure.append(img, caption); filmstrip.appendChild(figure);
}
run.addEventListener('click', async () => {
  run.disabled = true;
  results.replaceChildren(); filmstrip.replaceChildren();
  const checks = [];
  const errors = [];
  const onError = event => errors.push(event.reason?.message || String(event.reason));
  window.addEventListener('unhandledrejection', onError);
  function check(ok, name) {
    checks.push({ passed: !!ok, name });
    const li = document.createElement('li');
    li.className = ok ? 'pass' : 'fail'; li.textContent = `${ok ? 'PASS' : 'FAIL'} · ${name}`;
    results.appendChild(li);
  }
  try {
    status.textContent = '验证中…';
    await viewer?.dispose();
    viewer = new SparkViewer({ rootElement: root });
    viewer.renderer.debug.onShaderError = () => errors.push('Shader 编译错误');
    const id = new URLSearchParams(location.search).get('job');
    await viewer.addSplatScene(id ? `/api/artifact?id=${encodeURIComponent(id)}` : './interaction.ply', { intro: true });
    viewer.effects.setMode(0); viewer.parallax = false;
    const { center, radius } = viewer.bounds;
    viewer.controls.target.copy(center);
    viewer.camera.position.copy(center).addScaledVector(new THREE.Vector3(.331, -.299, -.895).normalize(), radius * 2.8);
    viewer.controls.update();
    viewer.intro.skip(); await frames(24);
    const original = capture();
    check(lit(original) > 1000, `原场景 GPU 实际绘制（${viewer.splatMesh.numSplats} 个高斯）`);
    viewer.intro.replay(); await frames(16);
    const nucleus = capture(); snapshot('01 · 中心聚合');
    check(viewer.intro.phase === 'waiting' && !viewer.controls.enabled, '等待点击，锁定相机手势');
    check(lit(nucleus) > 30 && lit(nucleus) < lit(original) * .6,
      `原场景粒子聚合成紧凑光团（亮像素 ${lit(nucleus)} / ${lit(original)}）`);
    await frames(90);
    check(viewer.intro.phase === 'waiting' && difference(nucleus, capture()) > 80,
      '等待点击时，光核流动、闪烁和轨道粒子持续改变 GPU 画面');
    const cameraBefore = viewer.camera.position.clone();
    root.querySelector('.scene-intro-trigger').click();
    check(viewer.intro.phase === 'running' && !viewer.intro.play(), '点击立即启动，重复触发不重置进度');
    await frames(14);
    const burst = capture(); snapshot('02 · 爆开 / 0.23 秒');
    check(viewer.renderCamera.position.distanceTo(viewer.camera.position) > 0,
      '爆开瞬间仅渲染相机轻微后退，基础机位保持不变');
    check(difference(nucleus, burst) > 200 && difference(original, burst) > 200, 'GPU 中间态确实展开，未直接切换模型');
    await frames(22); snapshot('03 · 空间成形 / 0.60 秒');
    await frames(Math.ceil(INTRO_DURATION * 60) + 24);
    const settled = capture(); snapshot('04 · 完整场景');
    check(viewer.intro.phase === 'complete' && viewer.controls.enabled, '展开完成后恢复相机操作');
    check(difference(original, settled) < 30, '动画结束精确回到原场景 GPU 画面');
    check(viewer.camera.position.distanceTo(cameraBefore) < 1e-7, '基础机位无累计漂移');
    viewer.intro.replay(); await frames(8); viewer.intro.play(); await frames(5);
    root.querySelector('.scene-intro-skip').click(); await frames(24);
    check(viewer.intro.phase === 'complete' && difference(original, capture()) < 30, '播放中可跳过，并准确恢复原场景');
    viewer.controls.autoRotate = true;
    viewer.intro.replay(); viewer.intro.skip();
    check(viewer.controls.autoRotate, '重播结束恢复之前的自动旋转设置');
    viewer.controls.autoRotate = false;
    const offset = viewer.camera.position.clone().sub(viewer.controls.target);
    viewer.controls.target.add(new THREE.Vector3(radius * .2, 0, 0));
    viewer.camera.position.copy(viewer.controls.target).add(offset);
    viewer.intro.replay();
    check(viewer.controls.target.distanceTo(center) < 1e-7 &&
      viewer.camera.position.clone().sub(center).distanceTo(offset) < 1e-7,
      '平移或定位后重播，将光团置中并保留观看方向和距离');
    viewer.intro.skip();
    const glError = viewer.renderer.getContext().getError();
    check(errors.length === 0 && glError === 0,
      `无 Shader / WebGL / 未处理异步错误（GL=${glError}, ${errors.join(';') || '无异步错误'}）`);
    viewer.intro.replay(); await viewer.dispose();
    check(!root.querySelector('canvas, .scene-intro, .scene-intro-replay'), '等待点击时切换模型，清理画布和入场控件');
    const matchMedia = window.matchMedia;
    try {
      window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ?
        { matches: true } : matchMedia.call(window, query);
      viewer = new SparkViewer({ rootElement: root });
      await viewer.addSplatScene('./interaction.ply', { intro: true });
      check(viewer.intro.phase === 'complete' && viewer.controls.enabled &&
        root.querySelector('.scene-intro').hidden && root.querySelector('.scene-intro-replay').hidden,
        '系统减少动态效果时直接展示场景，并隐藏动画入口');
    } finally {
      window.matchMedia = matchMedia;
      await viewer?.dispose();
    }
  } catch (error) {
    check(false, error.stack || String(error));
    await viewer?.dispose();
  } finally {
    window.removeEventListener('unhandledrejection', onError);
    window.sceneIntroResults = checks;
    status.textContent = checks.every(c => c.passed) ? `全部通过（${checks.length} 项）` : '验证失败';
    run.disabled = false;
  }
});
