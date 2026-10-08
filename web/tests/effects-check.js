import * as THREE from 'three';
import { SparkViewer } from '../spark-viewer.js';

const root = document.getElementById('preview');
const results = document.getElementById('results');
const status = document.getElementById('status');
const button = document.getElementById('run');
const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
const asyncErrors = [];
window.addEventListener('unhandledrejection', e => { asyncErrors.push(e.reason?.message || String(e.reason)); });
let viewer;
let failed;
function check(ok, message) {
  const item = document.createElement('li');
  item.className = ok ? 'pass' : 'fail';
  item.textContent = `${ok ? 'PASS' : 'FAIL'} · ${message}`;
  results.appendChild(item);
  if (!ok) failed++;
}
async function frames(count, before) {
  for (let n = 0; n < count; n++) {
    before?.();
    viewer.effects.update(1 / 60);
    viewer.controls.update(1 / 60);
    viewer.renderCamera.copy(viewer.camera);
    viewer.renderer.render(viewer.scene, viewer.renderCamera);
    await raf();
  }
}
function capture() {
  viewer.renderer.render(viewer.scene, viewer.renderCamera);
  const gl = viewer.renderer.getContext();
  const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}
function changed(a, b) {
  let count = 0;
  for (let n = 0; n < a.length; n += 4) {
    if (Math.abs(a[n] - b[n]) + Math.abs(a[n + 1] - b[n + 1]) + Math.abs(a[n + 2] - b[n + 2]) > 6) count++;
  }
  return count;
}
button.addEventListener('click', async () => {
  button.disabled = true;
  results.replaceChildren(); failed = 0;
  asyncErrors.length = 0;
  status.textContent = '验证中';
  const errors = [];
  try {
    await viewer?.dispose();
    viewer = new SparkViewer({ rootElement: root });
    viewer.renderer.debug.onShaderError = () => { errors.push('Shader compile error'); };
    await viewer.addSplatScene('./interaction.ply');
    check(viewer.splatMesh.numSplats === 4800, '本地 PLY 解码成功');
    viewer.controls.target.copy(viewer.bounds.center);
    viewer.camera.position.set(0, -.65, -3);
    viewer.controls.update(); viewer.captureHome();
    viewer.parallax = false;
    viewer.effects.setMode(0);
    await frames(24);
    const original = capture();
    let lit = 0;
    for (let n = 0; n < original.length; n += 4) if (original[n] + original[n + 1] + original[n + 2] > 80) lit++;
    check(lit > 1000, `WebGL 实际绘制粒子（${lit} 个亮像素）`);
    const point = new THREE.Vector3(.2, 0, -.7);
    const axis = viewer.camera.getWorldDirection(new THREE.Vector3());
    const velocity = new THREE.Vector3(3, .5, 0);
    const names = ['局部排斥', '鼠标吸附', '流体绕行', '速度甩动', '扭曲', '涡旋', '呼吸', '噪声扰动'];
    viewer.effects.setStrength(1);
    viewer.effects.setRadius(.65);
    for (let mode = 1; mode <= 8; mode++) {
      viewer.effects.reset(); viewer.effects.setMode(mode);
      await frames(24, () => viewer.effects.setPointer(point, axis, mode === 4 ? velocity : new THREE.Vector3(), true));
      const diff = changed(original, capture());
      check(diff > 30, `${names[mode - 1]}改变 GPU 画面（${diff} 个像素）`);
    }
    viewer.effects.reset(); viewer.effects.setMode(0);
    await frames(30);
    check(changed(original, capture()) < 20, '恢复原状后，画面回到基准');
    for (const kind of ['explosion', 'ripple']) {
      viewer.effects.pulse(kind, point);
      await frames(18);
      check(changed(original, capture()) > 30, `${kind}脉冲改变实际画面`);
      await frames(245);
      check(changed(original, capture()) < 20, `${kind}脉冲结束后回归原位`);
    }
    viewer.effects.setMode(1);
    await frames(30, () => viewer.effects.setPointer(point, axis, new THREE.Vector3(), true));
    viewer.effects.leave();
    await frames(100);
    check(changed(original, capture()) < 20, '鼠标移开后局部排斥平滑回归');
    viewer.effects.reset(); viewer.effects.setMode(0);
    viewer.effects.setStrength(0);
    viewer.effects.setMode(5);
    await frames(24);
    check(changed(original, capture()) < 20, '强度为零时保持原始模型');
    viewer.effects.setStrength(1); viewer.effects.setMode(5); viewer.effects.setAmbient(true);
    viewer.effects.pulse('explosion', point);
    viewer.effects.setEnabled(false);
    await frames(24);
    check(changed(original, capture()) < 20, '特效总开关关闭后，扭曲、微动和脉冲全部回到原始 GPU 画面');
    const frozen = viewer.effects.uniforms.time.value;
    viewer.effects.pulse('ripple', point); viewer.effects.setPointer(point, axis, velocity, true);
    await frames(24);
    check(changed(original, capture()) < 20 && viewer.effects.uniforms.time.value === frozen,
      '关闭时点击、鼠标和时间更新不会重新激活特效');
    viewer.effects.setEnabled(true); await frames(24);
    check(viewer.effects.uniforms.mode.value === 5 && viewer.effects.uniforms.ambient.value === 1 &&
      changed(original, capture()) > 30, '开启总开关后恢复先前模式及微动参数');
    viewer.effects.reset(); viewer.effects.setMode(0); viewer.effects.setAmbient(false);
    const glError = viewer.renderer.getContext().getError();
    check(errors.length === 0 && glError === 0,
      `无 Shader 编译错误或 WebGL 错误${errors.length || glError ? `（${errors.join(', ')} WebGL=${glError}）` : ''}`);
    viewer.effects.setMode(0);
    const startAngle = viewer.controls.getAzimuthalAngle();
    viewer.controls.autoRotate = true;
    await frames(40);
    check(Math.abs(viewer.controls.getAzimuthalAngle() - startAngle) > .01, '自动环绕推进视角');
    viewer.controls.autoRotate = false;
    const offset = viewer.camera.position.clone().sub(viewer.controls.target);
    viewer.homeDirection.copy(offset).normalize().negate();
    viewer.returnHome = true;
    viewer.releaseTime = performance.now() - 3000;
    viewer.lastInteraction = viewer.releaseTime;
    const before = offset.normalize().distanceTo(viewer.homeDirection);
    viewer.start();
    for (let n = 0; n < 120; n++) await raf();
    const after = viewer.camera.position.clone().sub(viewer.controls.target).normalize().distanceTo(viewer.homeDirection);
    check(after < before * .75, '缓慢回正可跨越相反视角');
    const oldWidth = root.clientWidth;
    root.style.width = '540px';
    await raf(); await raf();
    check(Math.abs(viewer.camera.aspect - root.clientWidth / root.clientHeight) < .01, '画布和相机随容器尺寸更新');
    root.style.width = `${oldWidth}px`;
    await viewer.dispose();
    check(root.querySelectorAll('canvas').length === 0 && viewer.disposed, '释放画布、渲染循环和事件监听');
    await raf(); await raf();
    check(asyncErrors.length === 0, '释放时没有异步排序/回读异常');
    // A local blob PLY takes the same path as a user file import.
    const bytes = await (await fetch('./interaction.ply')).arrayBuffer();
    const blob = URL.createObjectURL(new Blob([bytes]));
    const abandoned = new SparkViewer({ rootElement: root });
    const load = abandoned.addSplatScene(blob);
    await abandoned.dispose();
    await load;
    check(abandoned.disposed && root.querySelectorAll('canvas').length === 0,
      '加载尚未完成时取消预览，不留下旧画布');
    // Exercise the real app's blob ownership when two replacements overlap.
    localStorage.removeItem('splat.viewPlaneUp');   // 同源共享：清掉上次运行/人工操作残留的默认平面
    const app = document.createElement('iframe');
    app.style.cssText = 'width:720px;height:900px';   // 与真实窗口同高，避免工具栏把画布挤成 0 高
    const appReady = new Promise(resolve => { app.onload = resolve; });
    app.src = '/'; document.body.appendChild(app); await appReady;
    const bridge = app.contentDocument.createElement('script');
    bridge.type = 'module';
    bridge.textContent = 'import { openViewer } from "/app.js"; window.previewForTest = openViewer;';
    app.contentDocument.head.appendChild(bridge);
    app.contentWindow.addEventListener('unhandledrejection', e => asyncErrors.push(e.reason?.message || String(e.reason)));
    for (let n = 0; n < 100 && !app.contentWindow.previewForTest; n++) await raf();
    // 默认视角平面：倾斜对准 → 保存 → 套用到预设视角 → 恢复默认。
    const host = new SparkViewer({ rootElement: root });
    await host.addSplatScene('./interaction.ply');
    host.setCameraUp(new THREE.Vector3(1, 0, 0));
    host.setViewPlane(new THREE.Vector3(0, 1, 0));
    check(host.viewPlaneUp.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6 &&
      host.camera.up.distanceTo(host.viewPlaneUp) < 1e-6 &&
      host.controls._quat.angleTo(new THREE.Quaternion()
        .setFromUnitVectors(host.camera.up, new THREE.Vector3(0, 1, 0))) < 1e-6,
      'setViewPlane 同步相机 up 与 OrbitControls 轨道基准');
    host.resetViewPlane();
    check(host.camera.up.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6, 'resetViewPlane 回到世界 −Y 朝上');
    await host.dispose();
    const urls = Array.from({ length: 3 }, () => URL.createObjectURL(new Blob([bytes])));
    const freshUrl = URL.createObjectURL(new Blob([bytes]));
    const tilt = new THREE.Vector3(0, -1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), .6).normalize();
    try {
      await app.contentWindow.previewForTest({ src: urls[0], local: true });
      app.contentWindow.__viewer.spark.readPause = 40;
      await raf(); await raf();
      await Promise.all([
        app.contentWindow.previewForTest({ src: urls[1], local: true }),
        app.contentWindow.previewForTest({ src: urls[2], local: true }),
      ]);
      check(app.contentWindow?.__viewer?.splatMesh.numSplats === 4800 &&
        app.contentDocument.querySelectorAll('#viewer canvas').length === 1 &&
        !app.contentDocument.querySelector('#fxPane .tp-rotv.tp-v-disabled'),
        '连续切换本地文件时，最新模型可用且只保留一个画布');
      const active = app.contentWindow.__viewer;
      const toggle = app.contentDocument.getElementById('fxEnabled');
      // Tweakpane 列表选项不写 value 属性（按 selectedIndex 解析），选模式要用索引。
      const fxPane = app.contentDocument.getElementById('fxPane');
      const modeSelect = fxPane.querySelector('select');
      modeSelect.selectedIndex = 5;
      modeSelect.dispatchEvent(new app.contentWindow.Event('change', { bubbles: true }));
      toggle.click();
      check(active.effects.uniforms.enabled.value === 0 && modeSelect.disabled && modeSelect.selectedIndex === 5 &&
        !app.contentDocument.getElementById('camHome').disabled, '页面总开关禁用特效控件并保留模式，相机控件仍可用');
      toggle.click();
      check(active.effects.uniforms.enabled.value === 1 && !modeSelect.disabled &&
        active.effects.uniforms.mode.value === 5, '页面总开关重新开启恢复已选模式');
      active.parallax = false; active.effects.reset(); active.effects.setMode(0);
      const key = (code, options = {}, target = app.contentWindow) => {
        const event = new app.contentWindow.KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...options });
        target.dispatchEvent(event); return event;
      };
      const settle = async () => { for (let n = 0; n < 24; n++) await raf(); };
      const canvas = active.renderer.domElement;
      const dragMouse = (button, dx, dy, screen = null) => {
        const setCapture = canvas.setPointerCapture, releaseCapture = canvas.releasePointerCapture;
        // Synthetic pointer IDs cannot be captured by the browser. Exercise the
        // real OrbitControls event handlers; suppress only the capture calls.
        canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {};
        try {
          const rect = canvas.getBoundingClientRect();
          const x = screen?.x ?? rect.left + rect.width / 2, y = screen?.y ?? rect.top + rect.height / 2;
          const send = (type, mx, my) => canvas.dispatchEvent(new app.contentWindow.PointerEvent(type, {
            pointerId: 101, pointerType: 'mouse', isPrimary: true, button,
            buttons: type === 'pointerup' ? 0 : button === 1 ? 4 : button === 2 ? 2 : 1,
            clientX: mx, clientY: my, bubbles: true, cancelable: true,
          }));
          send('pointerdown', x, y); send('pointermove', x + dx, y + dy); send('pointerup', x + dx, y + dy);
        } finally { canvas.setPointerCapture = setCapture; canvas.releasePointerCapture = releaseCapture; }
      };
      const midDefault = new app.contentWindow.MouseEvent('mousedown', { button: 1, cancelable: true });
      canvas.dispatchEvent(midDefault);
      check(midDefault.defaultPrevented, '中键操作阻止浏览器自动滚屏');
      const middleDistance = active.controls.getDistance();
      dragMouse(1, 0, 80); await settle();
      check(Math.abs(active.controls.getDistance() - middleDistance) > .01, '中键上下拖动推进/拉远透视相机');
      const rightTarget = active.controls.target.clone(); dragMouse(2, 60, 0); await settle();
      check(rightTarget.distanceTo(active.controls.target) > .001, '右键拖动平移画面');
      for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
        const target = active.controls.target.clone();
        key(code); await settle();
        check(target.distanceTo(active.controls.target) > .001, `${code.slice(3)} 键平移相机`);
      }
      const rotation = active.camera.quaternion.clone();
      key('KeyA', { shiftKey: true }); await settle();
      check(rotation.angleTo(active.camera.quaternion) > .001, 'Shift + WASD 复用 OrbitControls 旋转');
      key('KeyU'); check(active.controlPlane.visible, 'U 显示辅助平面');
      check(active.controlPlane.position.distanceTo(active.controls.target) < 1e-6 &&
        new THREE.Vector3(0, 1, 0).applyQuaternion(active.controlPlane.quaternion).distanceTo(active.camera.up) < 1e-6,
        'U 辅助平面跟随环绕中心和相机朝上方向');
      key('KeyU', { repeat: true }); check(active.controlPlane.visible, '按住切换键不会反复闪烁');
      key('KeyU'); check(!active.controlPlane.visible, 'U 再次隐藏辅助平面');
      key('KeyI'); check(!active.info.hidden && active.info.textContent.includes('4,800'), 'I 显示实际粒子数和相机信息');
      check(['相机位置', '目标位置', '相机朝上', '光标位置', '提交渲染', '排序任务', '画布'].every(label => active.info.textContent.includes(label)),
        'I 面板恢复相机、光标、渲染数量、排序任务和画布信息');
      key('KeyO'); await settle();
      check(active.camera.isOrthographicCamera && active.controls.object === active.camera &&
        active.renderCamera.isOrthographicCamera, 'O 切换正交相机并同步控制器、渲染相机');
      const orthoZoom = active.camera.zoom; dragMouse(1, 0, -80); await settle();
      check(Math.abs(active.camera.zoom - orthoZoom) > .01, '正交模式中键拖动仍可缩放');
      const orthoTarget = active.controls.target.clone(); key('KeyD'); await settle();
      check(orthoTarget.distanceTo(active.controls.target) > .001, '正交模式下 WASD 仍可平移');
      key('KeyO'); await settle();
      check(active.camera.isPerspectiveCamera && active.renderCamera.isPerspectiveCamera, 'O 恢复透视相机');
      const pixels = () => {
        active.renderer.render(active.scene, active.renderCamera);
        const gl = active.renderer.getContext();
        const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      };
      const gaussian = pixels(); key('KeyP'); await settle();
      check(active.pointCloud && changed(gaussian, pixels()) > 30, 'P 点云模式改变实际 GPU 画面');
      key('KeyP'); await settle();
      check(!active.pointCloud && changed(gaussian, pixels()) < 20, 'P 再次恢复高斯画面');
      key('Equal'); await settle();
      check(Math.abs(active.splatScale - 1.05) < 1e-6 && changed(gaussian, pixels()) > 30, '+ 增大粒子并改变画面');
      key('Minus'); check(Math.abs(active.splatScale - 1) < 1e-6, '− 恢复粒子大小');
      const focal = active.spark.focalAdjustment;
      key('KeyG'); check(Math.abs(active.spark.focalAdjustment - focal - .02) < 1e-6, 'G 增大焦距系数');
      const focalAfterG = active.spark.focalAdjustment;   // F 只管全屏，焦距停在 G 之后的值
      // F 已由网页层接管为全屏（见 docs/viewer-controls-audit.md），不再调整焦距。
      const fullCam = app.contentDocument.getElementById('camFull');
      const fsControls = app.contentDocument.getElementById('fsControls');
      const toolbar = app.contentDocument.querySelector('.viewer-toolbar');
      const canvasBox = () => { const r = active.renderer.domElement.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)]; };
      const beforeFullscreen = canvasBox();
      const enterKey = key('KeyF'); await settle();
      check(enterKey.defaultPrevented && Math.abs(active.spark.focalAdjustment - focalAfterG) < 1e-6,
        'F 由网页层接管为全屏，不再改变焦距系数');
      const entered = app.contentDocument.fullscreenElement?.id === 'viewerPanel';
      check(entered
        ? app.contentDocument.body.classList.contains('has-fullscreen') && fullCam.textContent === '退出全屏' &&
          !fsControls.hidden && !toolbar.classList.contains('expanded')
        : !app.contentDocument.body.classList.contains('has-fullscreen') && fullCam.textContent === '全屏' && fsControls.hidden,
        '全屏状态与按钮、浮层开关同步');
      if (entered) {
        const fsBox = canvasBox();
        check(getComputedStyle(toolbar).display === 'none' && fsBox[0] > beforeFullscreen[0] &&
          Math.abs(active.camera.aspect - fsBox[0] / fsBox[1]) < .01,
          '全屏后画布放大且相机比例与画布一致');
        fsControls.click();
        const toggleBox = fsControls.getBoundingClientRect();
        check(app.contentDocument.elementFromPoint(
          toggleBox.left + toggleBox.width / 2, toggleBox.top + toggleBox.height / 2) === fsControls,
          '展开的工具浮层不盖住“收起工具”按钮');
        check(toolbar.classList.contains('expanded') && getComputedStyle(toolbar).display !== 'none' &&
          canvasBox().join() === fsBox.join(),
          '全屏内“控制”浮层可展开且不挤压画布');
        fsControls.click();
        check(!toolbar.classList.contains('expanded') && getComputedStyle(toolbar).display === 'none' &&
          canvasBox().join() === fsBox.join(),
          '再次点击“收起工具”收回浮层且不改变画布尺寸');
        key('KeyF'); await settle();
        check(app.contentDocument.fullscreenElement === null &&
          !app.contentDocument.body.classList.contains('has-fullscreen') && fullCam.textContent === '全屏' &&
          fsControls.hidden && canvasBox().join() === beforeFullscreen.join() &&
          Math.abs(active.camera.aspect - beforeFullscreen[0] / beforeFullscreen[1]) < .01,
          '再按 F 退出全屏并还原画布尺寸与相机比例');
      } else {
        // 真实全屏需要用户激活；验证页在长流程后可能已过期，此时只核对能力与回退状态。
        check(app.contentDocument.fullscreenEnabled === true && !fullCam.disabled &&
          canvasBox().join() === beforeFullscreen.join(),
          '本次点击未被浏览器授予全屏激活，按钮仍可用且画布未受影响');
      }
      key('KeyC'); check(active.showCursor, 'C 开启鼠标光标');
      key('KeyC'); check(!active.showCursor, 'C 关闭鼠标光标');
      const up = active.camera.up.clone(); key('ArrowLeft');
      check(up.distanceTo(active.camera.up) > .001, '左方向键倾斜相机');
      key('ArrowRight'); check(up.distanceTo(active.camera.up) < 1e-6, '右方向键恢复相机倾斜');
      key('Digit0'); check(active.camera.up.distanceTo(up) < 1e-6, '源视角重置正确刷新相机 up');
      const input = app.contentDocument.createElement('input'); app.contentDocument.body.appendChild(input);
      const editor = app.contentDocument.createElement('div'); editor.contentEditable = 'true'; app.contentDocument.body.appendChild(editor);
      const target = active.controls.target.clone();
      check(!key('KeyW', {}, input).defaultPrevented && !key('KeyP', {}, input).defaultPrevented &&
        !key('KeyO', {}, editor).defaultPrevented && !key('KeyI', { ctrlKey: true }).defaultPrevented &&
        target.distanceTo(active.controls.target) === 0 && active.camera.isPerspectiveCamera && !active.pointCloud,
        '输入框、富文本及浏览器组合键不被模型快捷键截获');
      input.remove(); editor.remove();
      const checkbox = app.contentDocument.getElementById('camParallax');
      const beforeSettingKey = active.controls.target.clone(); key('KeyW', {}, checkbox); await settle();
      check(beforeSettingKey.distanceTo(active.controls.target) > .001, '操作复选框后，WASD 仍然生效');
      // Tweakpane 的滑杆是 div 轨道（不是原生 range），方向键由它自己吃下。
      const slider = app.contentDocument.querySelector('#fxPane .tp-sldv_t');
      check(!key('ArrowLeft', {}, slider).defaultPrevented, '滑杆仍保留方向键调节，不触发相机倾斜');
      const modifierRotation = active.camera.quaternion.clone();
      key('KeyA', { ctrlKey: true }, active.renderer.domElement); await settle();
      check(modifierRotation.angleTo(active.camera.quaternion) > .001, '模型视窗内 Ctrl + WASD 恢复旧版旋转操作');
      const findVisibleHit = () => {
        const rect = canvas.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        let result;
        active.splatMesh.forEachSplat((index, center) => {
          if (result || index % 80) return;
          const projected = center.clone().applyMatrix4(active.splatMesh.matrixWorld).project(active.renderCamera);
          if (Math.abs(projected.x) > .8 || Math.abs(projected.y) > .8 || Math.abs(projected.z) > 1) return;
          ray.setFromCamera(new THREE.Vector2(projected.x, projected.y), active.renderCamera);
          const hit = ray.intersectObject(active.splatMesh, false)[0];
          if (!hit || hit.point.distanceTo(active.controls.target) < .08) return;
          result = { x: rect.left + (projected.x + 1) * .5 * rect.width,
            y: rect.top + (1 - projected.y) * .5 * rect.height, point: hit.point.clone() };
        });
        if (!result) throw new Error('定位测试找不到可见的真实高斯命中点');
        return result;
      };
      active.clearDamping(); await settle();
      let visibleHit = findVisibleHit();
      const fixedCamera = active.camera.position.clone();
      dragMouse(1, 0, 0, visibleHit); await settle();
      check(active.controls.target.distanceTo(visibleHit.point) < 1e-5 &&
        active.camera.position.distanceTo(fixedCamera) < 1e-5,
        '中键单击真实点云，平滑改变旋转中心并保持相机位置');
      check(active.focusMarker.visible && active.focusStatus.textContent.startsWith('中键定位：') &&
        [0, 1, 2, 3].every(n => active.effects.uniforms[`pulse${n}`].value.w >= 4),
        '定位显示标记和坐标，不触发粒子爆散或波纹');
      const focusBeforeDrag = active.controls.target.clone();
      dragMouse(1, 0, 60, findVisibleHit()); await settle();
      check(active.controls.target.distanceTo(focusBeforeDrag) < 1e-5 && !active.focusTransition,
        '中键拖动只缩放，不误触定位');
      const raycast = active.splatMesh.raycast;
      active.splatMesh.raycast = () => {};
      const beforeMiss = active.controls.target.clone();
      try { dragMouse(1, 0, 0); await settle(); }
      finally { active.splatMesh.raycast = raycast; }
      check(beforeMiss.distanceTo(active.controls.target) < 1e-5 &&
        active.focusStatus.textContent.includes('未命中'), '点击空白不把悬停平面当作模型定位点');
      active.effects.setEnabled(false);
      visibleHit = findVisibleHit(); dragMouse(1, 0, 0, visibleHit); await settle();
      check(active.controls.target.distanceTo(visibleHit.point) < 1e-5 && active.effects.uniforms.enabled.value === 0,
        '粒子总开关关闭时，中键定位仍然可用');
      key('KeyO'); await settle();
      visibleHit = findVisibleHit(); dragMouse(1, 0, 0, visibleHit); await settle();
      check(active.camera.isOrthographicCamera && active.controls.target.distanceTo(visibleHit.point) < 1e-5,
        '正交模式下中键单击也能定位真实高斯点');
      key('KeyO'); await settle();
      visibleHit = findVisibleHit(); dragMouse(1, 0, 0, visibleHit);
      key('KeyW'); await settle();
      check(!active.focusTransition && active.controls.target.distanceTo(visibleHit.point) > .001,
        '新键盘操作取消定位过渡，避免抢夺相机控制');
      // —— 默认视角平面：Shift + U 保存 → 预设视角套用 → 刷新仍生效 → 恢复默认 ——
      const appStore = app.contentWindow.localStorage;
      const planeViewer = () => app.contentWindow.__viewer;
      const planeSave = app.contentDocument.getElementById('camPlaneSave');
      const planeReset = app.contentDocument.getElementById('camPlaneReset');
      const planeState = app.contentDocument.getElementById('camPlaneState');
      planeReset.click();   // 清掉上一次会话可能残留的保存值，从默认平面开始
      check(planeState.textContent === '默认' && planeReset.disabled && !planeSave.disabled &&
        planeViewer().camera.up.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6,
        '未保存默认平面时状态为默认、恢复按钮禁用且相机朝世界 −Y');
      planeViewer().setViewPlane(tilt);
      const shiftU = key('KeyU', { shiftKey: true });
      const stored = JSON.parse(appStore.getItem('splat.viewPlaneUp') || 'null');
      check(shiftU.defaultPrevented && Array.isArray(stored) && stored.length === 3 &&
        new THREE.Vector3(...stored).distanceTo(tilt) < 1e-6 && planeState.textContent === '已保存' &&
        !planeReset.disabled && !planeViewer().controlPlane.visible,
        'Shift + U 保存当前倾斜到 localStorage，且不切换辅助平面显示');
      app.contentDocument.querySelector('.cbtn[data-view="front"]').click();
      check(planeViewer().camera.up.distanceTo(tilt) < 1e-6, '切换预设视角后仍套用已保存的默认视角平面');
      const planeUpNow = planeViewer().camera.up.clone();
      key('KeyU');
      check(active.controlPlane.visible &&
        new THREE.Vector3(0, 1, 0).applyQuaternion(active.controlPlane.quaternion).distanceTo(planeUpNow) < 1e-6,
        'U 辅助平面对齐已保存的视角平面');
      key('KeyU');
      await app.contentWindow.__viewer?.dispose();
      key('KeyU'); key('KeyW'); check(!active.controlPlane.visible && !active.info.isConnected,
        '释放模型后键盘监听和信息面板被清理');
      check(asyncErrors.length === 0, '连续切换模型没有未处理的异步错误');
    } finally {
      urls.forEach(url => URL.revokeObjectURL(url)); app.remove();
    }
    // 刷新页面：localStorage 里的默认平面仍然生效，可用按钮清除。
    const fresh = document.createElement('iframe');
    fresh.style.cssText = 'width:720px;height:600px';
    const freshReady = new Promise(resolve => { fresh.onload = resolve; });
    fresh.src = '/'; document.body.appendChild(fresh); await freshReady;
    const freshBridge = fresh.contentDocument.createElement('script');
    freshBridge.type = 'module';
    freshBridge.textContent = 'import { openViewer } from "/app.js"; window.previewForTest = openViewer;';
    fresh.contentDocument.head.appendChild(freshBridge);
    for (let n = 0; n < 100 && !fresh.contentWindow.previewForTest; n++) await raf();
    await fresh.contentWindow.previewForTest({ src: freshUrl, local: true });
    const freshViewer = () => fresh.contentWindow.__viewer;
    check(freshViewer().camera.up.distanceTo(tilt) < 1e-6 &&
      fresh.contentDocument.getElementById('camPlaneState').textContent === '已保存',
      '刷新页面后仍读取已保存的默认视角平面');
    fresh.contentDocument.getElementById('camPlaneReset').click();
    check(localStorage.getItem('splat.viewPlaneUp') === null &&
      freshViewer().camera.up.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6 &&
      fresh.contentDocument.getElementById('camPlaneState').textContent === '默认',
      '恢复默认平面清除本地保存并回到世界 −Y 朝上');
    await freshViewer().dispose();
    fresh.remove();
    URL.revokeObjectURL(freshUrl);
    localStorage.removeItem('splat.viewPlaneUp');
    viewer = new SparkViewer({ rootElement: root });
    await viewer.addSplatScene(blob);
    URL.revokeObjectURL(blob);
    check(viewer.splatMesh.numSplats === 4800, '本地 blob PLY 导入成功');
    viewer.controls.target.copy(viewer.bounds.center);
    viewer.camera.position.set(0, -.65, -3); viewer.controls.update(); viewer.captureHome();
    viewer.start();
  } catch (error) {
    check(false, error.message);
    console.error(error);
  }
  status.textContent = failed ? `验证完成：${failed} 项失败` : '验证完成：全部通过';
  button.disabled = false;
});
