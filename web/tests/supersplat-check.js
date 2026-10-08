import { SuperSplatPreview } from '../supersplat-preview.js';
const root = document.getElementById('preview');
const results = document.getElementById('results');
const status = document.getElementById('status');
const run = document.getElementById('run');
let preview;
let report;
const errors = [];
const modesForTest = ['无形变','局部排斥','局部吸附','局部流动','拖拽甩动','高度扭转','局部涡旋','呼吸起伏','空间扰动'];
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
const frames = async (count = 12) => {
  for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve));
};
function check(ok, name) {
  report.checks.push({ ok: !!ok, name });
  const item = document.createElement('li');
  item.className = ok ? 'pass' : 'fail';
  item.textContent = `${ok ? 'PASS' : 'FAIL'} · ${name}`;
  results.append(item);
}
function position(handle) { return handle.app.root.findByName('camera').getPosition().clone(); }
function planeVertices(legacy) {
  const lines = [], original = legacy.app.drawLine;
  legacy.app.drawLine = (a, b) => lines.push([a.x, a.y, a.z, b.x, b.y, b.z]);
  try { legacy.grid(); } finally { legacy.app.drawLine = original; }
  return lines.flat();
}
const sameVertices = (a, b) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 1e-7);
async function imagePixels(handle) {
  const capture = await handle.captureFrame({ width: 320, height: 240, supersample: 1 });
  // The official capture API returns raw RGBA framebuffer bytes in base64.
  const pixels = Uint8Array.from(atob(capture.data), char => char.charCodeAt(0));
  if (pixels.length !== capture.width * capture.height * 4) throw new Error('捕获像素长度错误');
  return pixels;
}
async function rejects(promise) { try { await promise; return false; } catch { return true; } }
run.addEventListener('click', async () => {
  run.disabled = true; results.replaceChildren(); errors.length = 0;
  report = { checks: [], errors, renderer: null };
  status.textContent = '验证中';
  const urls = [];
  const preferences = ['splat.viewPlaneUp', 'splat.cameraMode', 'splat.view.v2.test%3Acamera-A', 'splat.view.v2.test%3Acamera-B'].map(key => [key, localStorage.getItem(key)]);
  localStorage.removeItem('splat.cameraMode');
  localStorage.removeItem('splat.viewPlaneUp');
  localStorage.removeItem('splat.view.v2.test%3Acamera-A');
  localStorage.removeItem('splat.view.v2.test%3Acamera-B');
  try {
    preview?.dispose();
    const bytes = await (await fetch('./interaction.ply')).arrayBuffer();
    const blob = URL.createObjectURL(new Blob([bytes])); urls.push(blob);
    preview = new SuperSplatPreview({ rootElement: root });
    const handle = await preview.load(blob);
    report.renderer = handle.app.graphicsDevice.deviceType;
    check(report.renderer === 'webgl2', 'HTTPS 与本地使用相同的 WebGL2 渲染路径');
    check(handle.app.scene.gsplat.antiAlias, '高斯抗锯齿默认开启');
    check(handle.state.loaded, '无后缀 blob PLY 加载到首帧');
    const entity = handle.app.root.findByName('gsplat');
    check(entity.gsplat.resource.gsplatData.numSplats === 4800, '原版引擎解码全部 4,800 个高斯');
    handle.state.animationPaused = true;
    const pixels = await imagePixels(handle);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 80) lit++;
    check(lit > 1000, `实际 GPU 画面存在模型（${lit} 个亮像素）`);
    // Re-submit a stationary scene repeatedly: it must neither disappear nor
    // change transparent blending between frames. This also exercises capture
    // restoration, used by the gallery while a visible model is open.
    await frames(30);
    const still = await imagePixels(handle);
    let maxChanged = 0;
    for (let frame = 0; frame < 6; frame++) {
      handle.app.renderNextFrame = true;
      await frames(4);
      const next = await imagePixels(handle);
      let changed = 0;
      for (let i = 0; i < next.length; i += 4) {
        if (Math.abs(next[i] - still[i]) + Math.abs(next[i + 1] - still[i + 1]) + Math.abs(next[i + 2] - still[i + 2]) > 12) changed++;
      }
      maxChanged = Math.max(maxChanged, changed);
    }
    check(maxChanged < still.length / 4 * .001, `静止模型重复渲染与封面捕获保持稳定（最多 ${maxChanged} 个变化像素）`);
    root.querySelector('.sse-play').click(); await frames(12);
    check(handle.state.cameraMode === 'anim' && !handle.state.animationPaused && handle.state.animationTime > 0, '原版播放按钮推进动画时间轴');
    root.querySelector('.sse-pause').click();
    const pausedTime = handle.state.animationTime; await frames(12);
    check(handle.state.animationPaused && handle.state.animationTime === pausedTime, '原版暂停按钮停止时间轴');
    root.querySelector('.sse-orbitCamera').click();
    check(handle.state.cameraMode === 'orbit', '原版环绕按钮切换相机模式');
    root.querySelector('.sse-flyCamera').click();
    check(handle.state.cameraMode === 'fly', '原版飞行按钮切换相机模式');
    const before = position(handle);
    handle.setMoveInput(0, 1); await frames(24); handle.setMoveInput(0, 0);
    check(position(handle).distance(before) > 0.01, '飞行移动实际改变相机位置');
    root.querySelector('.sse-settings').click();
    check(!root.querySelector('.sse-settingsPanel').classList.contains('sse-hidden'), '原版设置面板展开');
    root.querySelector('.sse-reset').click(); await frames(50);
    check(position(handle).distance(before) < 0.01, '原版重置恢复飞行入口机位');
    root.querySelector('.sse-frame').click(); await frames(50);
    check(handle.state.cameraMode === 'orbit', '原版适应切回环绕并重新取景');
    check(!handle.state.walkAllowed && root.querySelector('.sse-fpsCamera').classList.contains('sse-hidden'), '无碰撞数据时原版自动隐藏行走模式');
    document.getElementById('hostInput').focus();
    check(!handle.state.inputEnabled, '宿主输入框获得焦点时暂停模型键盘输入');
    preview.root.focus();
    check(handle.state.inputEnabled, '预览重新获得焦点时恢复键盘输入');
    const legacy = preview.legacy;
    const key = (code, options = {}) => legacy.surface.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...options }));
    legacy.button.click(); await frames();
    check(document.activeElement === legacy.surface, '进入旧模式时自动聚焦模型视窗');
    check(legacy.active && legacy.button.getAttribute('aria-pressed') === 'true' && !handle.state.inputEnabled, '第三种原有视角模式启用并隔离原版输入');
    const noPlanePixels = await imagePixels(handle);
    key('KeyU'); await frames();
    check(legacy.planeVisible && legacy.panel.querySelector('[data-action="plane"]').getAttribute('aria-pressed') === 'true', 'U 显示三维辅助水平面');
    const withPlanePixels = await imagePixels(handle);
    let planePixels = 0;
    for (let i = 0; i < withPlanePixels.length; i += 4) if (Math.abs(withPlanePixels[i] - noPlanePixels[i]) + Math.abs(withPlanePixels[i + 1] - noPlanePixels[i + 1]) + Math.abs(withPlanePixels[i + 2] - noPlanePixels[i + 2]) > 30) planePixels++;
    check(planePixels > 200, `三维辅助平面实际出现在 GPU 画面（${planePixels} 个变化像素）`);
    const fixedPlane = planeVertices(legacy), beforeStrafe = legacy.controls.target.clone();
    key('KeyA'); await frames(24);
    check(legacy.controls.target.distanceTo(beforeStrafe) > .01 && sameVertices(fixedPlane, planeVertices(legacy)), '左右平移实际移动相机，辅助水平面在模型坐标中保持固定');
    // Exercise the same OrbitControls pan path as mouse and touch gestures,
    // including a vertical component that previously changed plane height.
    legacy.controls._pan(45, 25); await frames(24);
    check(sameVertices(fixedPlane, planeVertices(legacy)), '斜向平移不会拖动辅助平面的位置或高度');
    legacy.preset(0); await frames();
    const up = legacy.up.clone(), rotation = legacy.entity.getRotation().clone();
    key('ArrowLeft'); await frames();
    const tilted = legacy.entity.getRotation();
    check(legacy.up.distanceTo(up) > .01 && Math.abs(tilted.x * rotation.x + tilted.y * rotation.y + tilted.z * rotation.z + tilted.w * rotation.w) < .99999, '左方向键实际改变水平面与渲染相机朝向');
    key('ArrowRight'); await frames();
    check(legacy.up.distanceTo(up) < 1e-5, '右方向键反向调平');
    key('ArrowLeft'); key('KeyU', { shiftKey: true });
    const saved = preview.preferences.read().up;
    check(Math.abs(saved[0] - legacy.up.x) < 1e-6 && Math.abs(saved[1] - legacy.up.y) < 1e-6 && Math.abs(saved[2] - legacy.up.z) < 1e-6 && legacy.planeVisible, 'Shift+U 按模型保存水平面且不误切辅助平面');
    const target = legacy.controls.target.clone();
    key('KeyW'); await frames(24);
    check(legacy.controls.target.distanceTo(target) > .01, '旧 WASD 平移实际移动旋转中心');
    const direction = legacy.camera.getWorldDirection(up.clone());
    key('KeyW', { shiftKey: true }); await frames(24);
    check(legacy.camera.getWorldDirection(up.clone()).distanceTo(direction) > .01, 'Shift+W 使用旧旋转操作');
    key('Digit2'); await frames();
    check(legacy.controls.target.distanceTo(legacy.center) < 1e-5, '数字预设恢复模型中心');
    key('KeyR'); const spinPosition = position(handle); await frames(24);
    check(legacy.controls.autoRotate && position(handle).distance(spinPosition) > .01, 'R 开关自动环绕并实际移动相机');
    key('KeyR'); key('KeyO'); await frames();
    check(legacy.camera.isOrthographicCamera && legacy.entity.camera.projection === 1, 'O 切换真实正交投影');
    key('KeyO'); await frames();
    check(legacy.camera.isPerspectiveCamera && legacy.entity.camera.projection === 0, 'O 恢复真实透视投影');
    key('KeyI'); await frames();
    check(!legacy.info.hidden && legacy.info.textContent.includes('相机朝上'), 'I 展示当前相机与水平面信息');
    // Pick an actual bright model pixel from the GPU capture. The same picker
    // as the native viewer returns model depth, including in orthographic mode.
    legacy.action('plane'); legacy.preset(0); await frames();
    const pickPixels = await imagePixels(handle);
    const rect = legacy.surface.getBoundingClientRect();
    let picked = false;
    const pickCamera = position(handle), planeBeforePick = planeVertices(legacy);
    for (let y = 90; y < 150 && !picked; y += 8) for (let x = 80; x < 240 && !picked; x += 8) {
      const offset = (y * 320 + x) * 4;
      if (pickPixels[offset] + pickPixels[offset + 1] + pickPixels[offset + 2] < 160) continue;
      const oldTarget = legacy.controls.target.clone();
      await legacy.focusAt(rect.left + x / 320 * rect.width, rect.top + y / 240 * rect.height);
      picked = legacy.controls.target.distanceTo(oldTarget) > .01;
    }
    check(picked && position(handle).distance(pickCamera) < .001, '中键定位使用真实模型深度，保持相机位置');
    check(sameVertices(planeBeforePick, planeVertices(legacy)), '重新定位旋转中心不会移动辅助水平面');
    const pickedTarget = legacy.controls.target.clone();
    await legacy.focusAt(rect.left + 1, rect.top + 1);
    check(legacy.controls.target.distanceTo(pickedTarget) < .001, '定位空白区域不会改变旋转中心');
    legacy.preset(0);
    const basePosition = legacy.camera.position.clone();
    legacy.surface.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + rect.width * .85, clientY: rect.top + rect.height * .6, bubbles: true }));
    await frames(24);
    check(legacy.camera.position.distanceTo(basePosition) < 1e-6 && position(handle).distance(legacy.pcStart.clone().set(basePosition.x, basePosition.y, basePosition.z)) > .005, '鼠标视差只偏移渲染相机，不累积到基础机位');
    legacy.panel.querySelector('[data-option="parallax"]').click(); await frames(90);
    check(position(handle).distance(legacy.pcStart.clone().set(basePosition.x, basePosition.y, basePosition.z)) < .001, '关闭鼠标视差后平滑恢复基础机位');
    legacy.surface.focus(); key('KeyW', { shiftKey: true }); await frames(24);
    const distanceBeforeHome = legacy.controls.getDistance();
    const errorBeforeHome = legacy.camera.position.clone().sub(legacy.controls.target).normalize().distanceTo(legacy.homeDirection);
    legacy.panel.querySelector('[data-option="returnHome"]').click();
    legacy.releaseTime = legacy.lastInteraction = performance.now() - 1300;
    await frames(40);
    const errorAfterHome = legacy.camera.position.clone().sub(legacy.controls.target).normalize().distanceTo(legacy.homeDirection);
    check(errorAfterHome < errorBeforeHome * .8 && Math.abs(legacy.controls.getDistance() - distanceBeforeHome) < .001, '松手回正缓慢恢复最近预设方向并保持距离');
    legacy.panel.querySelector('[data-option="returnHome"]').click();
    document.getElementById('hostInput').focus();
    const planeVisible = legacy.planeVisible;
    document.getElementById('hostInput').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyU', bubbles: true }));
    check(legacy.planeVisible === planeVisible, '宿主输入框不触发旧视角快捷键');
    root.querySelector('.sse-orbitCamera').click(); await frames();
    check(!legacy.active && handle.state.cameraMode === 'orbit' && legacy.surface.hidden && legacy.entity.camera.projection === 0, '原版环绕按钮退出原有模式且恢复透视');
    preview.root.focus();
    check(handle.state.inputEnabled, '退出原有视角后原版键盘输入恢复');
    legacy.button.click();
    legacy.action('resetPlane');
    check(!preview.preferences.read().up && legacy.up.distanceTo(up.fromArray(preview.modelView.up)) < 1e-6, '恢复模型初始水平面并清除保存值');
    root.querySelector('.sse-flyCamera').click(); await frames();
    check(!legacy.active && handle.state.cameraMode === 'fly', '原版飞行按钮退出原有模式');
    legacy.button.click();
    key('KeyO'); key('KeyU'); legacy.button.click(); await frames();
    check(!legacy.active && handle.state.cameraMode === 'orbit' && legacy.button.getAttribute('aria-pressed') === 'false', '再次点击原有视角按钮可退出并返回环绕');
    check(handle.state.inputEnabled && legacy.entity.camera.projection === 0 && !localStorage.getItem('splat.cameraMode'), '退出恢复输入和透视并清除自动进入偏好');
    legacy.button.click();
    legacy.panel.open = false;
    legacy.panel.querySelector('[data-action="exit"]').click(); await frames();
    check(!legacy.active && legacy.panel.hidden && legacy.surface.hidden && handle.state.cameraMode === 'orbit', '面板收起时仍可使用标题栏退出按钮');
    legacy.panel.open = true;
    legacy.button.click(); key('Escape'); await frames();
    check(!legacy.active && handle.state.cameraMode === 'orbit' && handle.state.inputEnabled, 'Esc 退出原有模式并恢复原版输入');
    for (let i = 0; i < 3; i++) { legacy.button.click(); legacy.button.click(); }
    check(!legacy.active && handle.state.inputEnabled && root.querySelectorAll('.legacy-camera').length === 1, '连续进入退出不会卡住或重复创建操作层');
    legacy.button.click();
    legacy.action('left'); legacy.action('save');
    root.style.width = '400px'; root.style.height = '280px'; await frames();
    handle.app.renderNextFrame = true; await frames();
    check(Math.abs(handle.app.graphicsDevice.width / handle.app.graphicsDevice.height - 400 / 280) < 0.02, '收起侧栏后画布尺寸与相机比例更新');
    root.style.width = '720px'; root.style.height = '440px';
    preview.dispose(); preview.dispose();
    check(!root.querySelector('canvas') && await rejects(handle.captureFrame()), '重复销毁安全，释放画布与捕获等待');

    // Introduce 0.5% distant floaters into a real binary PLY fixture. A full
    // AABB would dwarf the subject; verify actual pixels as well as the bound.
    const outliers = bytes.slice(0);
    const header = new TextDecoder().decode(outliers.slice(0, 2048));
    const offset = header.indexOf('end_header\n') + 'end_header\n'.length;
    const data = new DataView(outliers);
    for (let i = 0; i < 24; i++) for (let axis = 0; axis < 3; axis++) data.setFloat32(offset + i * 56 + axis * 4, 100000, true);
    const outlierUrl = URL.createObjectURL(new Blob([outliers])); urls.push(outlierUrl);
    preview = new SuperSplatPreview({ rootElement: root });
    const robustHandle = await preview.load(outlierUrl);
    check(preview.legacy.active && !preview.preferences.read().up, '新模型不继承其他模型保存的水平面');
    preview.root.querySelector('.sse-orbitCamera').click();
    robustHandle.state.animationPaused = true;
    check(preview.subjectBounds.halfExtents.length() < 10, '远处飞点不会把初始取景拉远');
    const robustPixels = await imagePixels(robustHandle);
    let robustLit = 0;
    for (let i = 0; i < robustPixels.length; i += 4) if (robustPixels[i] + robustPixels[i + 1] + robustPixels[i + 2] > 80) robustLit++;
    check(robustLit > 1000, '含远处飞点的模型仍能清晰取景');
    check(robustHandle.app.root.findByName('gsplat').gsplat.resource.gsplatData.numSplats === 4800, '取景适配不删除模型粒子');
    preview.dispose();

    preview = new SuperSplatPreview({ rootElement: root });
    const pending = preview.load(blob); preview.dispose();
    check(await rejects(pending), '加载期间切换模型会取消旧实例');
    preview = new SuperSplatPreview({ rootElement: root });
    check(await rejects(preview.load('/api/artifact?id=not-a-real-job')), '无效产物地址明确失败并释放实例');
    const invalid = URL.createObjectURL(new Blob(['this is not a PLY'])); urls.push(invalid);
    preview = new SuperSplatPreview({ rootElement: root });
    check(await rejects(preview.load(invalid)), '损坏 PLY 明确失败并释放实例');
    preview = new SuperSplatPreview({ rootElement: root });
    const recovered = await preview.load(blob, { modelKey: 'test:camera-A' });
    check(recovered.state.loaded && root.querySelectorAll('canvas').length === 1, '失败后可重新导入，始终只保留一个画布');
    recovered.state.animationPaused = true;
    const camera = recovered.app.root.findByName('camera');
    const pose = () => ({ p: camera.getPosition().clone(), q: camera.getRotation().clone(), f: camera.camera.fov, h: camera.camera.horizontalFov });
    const samePose = (a,b) => a.p.distance(b.p) < .0001 && Math.abs(a.q.dot(b.q)) > .99999;
    await frames(20);
    const nativeBefore = pose();
    preview.saveDefaultView();
    const pausedSaved = preview.preferences.read().pose;
    recovered.setCameraState({ ...pausedSaved, position: pausedSaved.position.map(v => v + .2) });
    preview.restoreDefaultView(); await frames(3);
    check(samePose(nativeBefore, pose()), '暂停动画初始画面也能保存与恢复默认视角');
    preview.legacy.enter(); await frames(1);
    check(samePose(nativeBefore, pose()), '进入原有模式继承当前机位与旋转');
    const aspect = root.clientWidth / root.clientHeight;
    const oldVertical = nativeBefore.h ? 2*Math.atan(Math.tan(nativeBefore.f*Math.PI/360)/aspect)*180/Math.PI : nativeBefore.f;
    check(Math.abs(camera.camera.fov-oldVertical)<.0001, '交接相机同时转换水平/垂直视野角，保持画面比例');
    preview.legacy.parallax=false; preview.legacy.action('left'); preview.legacy.action('left'); preview.legacy.action('save');
    preview.legacy.tick(0); const handoffTilted = pose();
    root.querySelector('.sse-flyCamera').click(); await frames(6);
    check(samePose(handoffTilted,pose()) && recovered.state.cameraMode==='fly', '原有模式转飞行保持位置、方向与调平角度');
    const flyBefore = pose(); root.querySelector('.sse-orbitCamera').click(); await frames(18);
    check(samePose(flyBefore,pose()), '飞行转环绕保持当前机位');
    preview.legacy.enter(); preview.legacy.preset(3); preview.legacy.action('left'); preview.legacy.action('save'); preview.legacy.tick(0);
    check(preview.saveDefaultView(), '默认视角按模型持久化');
    const savedPose=preview.cameraSnapshot(), savedUp=preview.preferences.read().up;
    preview.legacy.preset(1); check(preview.restoreDefaultView(), '恢复按钮应用保存的默认视角');
    await frames(3);
    check(preview.legacy.camera.position.distanceTo(new preview.legacy.camera.position.constructor(...savedPose.position))<.0001 && preview.legacy.up.distanceTo(new preview.legacy.up.constructor(...savedPose.up))<.0001, '恢复默认视角还原调平和旋转中心');
    preview.dispose();
    preview=new SuperSplatPreview({rootElement:root});
    const reopened=await preview.load(blob,{modelKey:'test:camera-A'}); await frames(3);
    check(preview.legacy.active && preview.cameraSnapshot().position.every((v,i)=>Math.abs(v-savedPose.position[i])<.0001) && preview.preferences.read().up.every((v,i)=>v===savedUp[i]), '重新打开同一模型恢复保存的默认视角和水平面');
    preview.dispose();
    preview=new SuperSplatPreview({rootElement:root});
    const second=await preview.load(blob,{modelKey:'test:camera-B'}); await frames(3);
    check(!preview.preferences.read().pose && !preview.preferences.read().up, '另一模型的默认视角和水平面互相隔离');
    preview.legacy.returnToOrbit(); await frames(12);
    const fx=preview.effects;
    const switchInput=fx.panel.querySelector('[data-param="enabled"]');
    check(!switchInput.checked && !fx.params.enabled && fx.panel.querySelector('[data-state]').textContent==='已关闭' && fx.panel.querySelector('fieldset').disabled, '粒子特效默认关闭，复选框和面板状态一致');
    const original=await imagePixels(second);
    switchInput.click(); await frames(2);
    check(switchInput.checked && fx.params.enabled && !fx.panel.querySelector('fieldset').disabled, '实际点击复选框可以手动开启特效');
    const changes=(a,b)=> {let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>30)n++;return n;};
    fx.set('enabled',true); fx.set('strength',2); fx.set('radius',1.2);
    for(let mode=1;mode<=8;mode++) {
      fx.clear(); fx.set('mode',mode); fx.inside=true; fx.lastHit=performance.now(); fx.target.set(.1,.1,.1); fx.pointer.copy(fx.target);
      if(mode===4)fx.targetVelocity.set(5,2,0);
      await frames(mode===4?3:20);
      const changed=changes(original,await imagePixels(second));
      check(changed>50, `${modesForTest[mode]}真实改变 GPU 画面（${changed} 个像素）`);
    }
    fx.clear();fx.set('mode',9);fx.pulse(fx.origin,1);await frames(8);
    check(changes(original,await imagePixels(second))>50,'爆散脉冲真实改变模型画面');
    fx.clear();fx.set('mode',10);fx.pulse(fx.origin,2);await frames(20);
    check(changes(original,await imagePixels(second))>10,'扩散波纹真实改变模型画面');
    const retained={...fx.params}; switchInput.click(); await frames(8);
    check(changes(original,await imagePixels(second))<10,'关闭特效完全还原原始粒子，形变不累积');
    switchInput.click();
    check(fx.params.mode===retained.mode&&fx.params.strength===retained.strength&&fx.params.radius===retained.radius,'重新开启保留模式、强度和范围');
    fx.set('pointCloud',true);await frames(4);
    check(changes(original,await imagePixels(second))>100,'P 点云切换真实改变高斯尺寸与朝向');
    fx.set('pointCloud',false); fx.reset(); await frames(15);
    check(fx.splat.workBufferUpdate===0,'静止时停止特效工作缓冲更新');
    check(fx.params.mode===1&&fx.params.strength===.65&&fx.pulses.every(p=>p.age>=4),'恢复原状清空脉冲并恢复默认参数');

    preview.dispose();
    await frames();
    check(errors.length === 0, '加载、切换与销毁均无未处理的异步异常');
  } catch (error) {
    check(false, error.stack || String(error)); preview?.dispose();
  } finally {
    preferences.forEach(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
    urls.forEach(url => { localStorage.removeItem('splat.view.v2.'+encodeURIComponent(url)); URL.revokeObjectURL(url); });
    report.passed = report.checks.filter(check => check.ok).length;
    report.failed = report.checks.length - report.passed;
    document.getElementById('report').textContent = JSON.stringify(report, null, 2);
    status.textContent = `${report.passed} 项通过，${report.failed} 项失败`;
    run.disabled = false;
  }
});
