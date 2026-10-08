import { SuperSplatPreview } from '../supersplat-preview.js';
const root = document.getElementById('preview'), results = document.getElementById('results');
const status = document.getElementById('status'), prepare = document.getElementById('prepare');
const frames = async (count = 45) => {
  for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve));
};
function check(ok, text) {
  const row = document.createElement('li'); row.className = ok ? 'pass' : 'fail';
  row.textContent = `${ok ? 'PASS' : 'FAIL'} · ${text}`; results.append(row);
}
let preview, blob;
try {
  blob = URL.createObjectURL(await (await fetch('./interaction.ply')).blob());
  preview = new SuperSplatPreview({ rootElement: root });
  const handle = await preview.load(blob, { auxiliary: true, modelKey: 'test:fly-rotation' });
  const entity = handle.app.root.findByName('camera');
  const rotation = entity.getRotation().clone().setFromEulerAngles(75, 0, 90);
  const forward = rotation.transformVector(entity.forward.clone().set(0, 0, -1));
  const up = rotation.transformVector(forward.clone().set(0, 1, 0));
  const right = rotation.transformVector(forward.clone().set(1, 0, 0));
  const pose = { position: forward.clone().mulScalar(-3).toArray(), angles: [75,0,90], distance: 3, fov: 60, mode: 'fly' };
  let startX = null, preparing = false;
  async function setup() {
    preparing = true;
    handle.setCameraState({ ...pose, mode: 'orbit' });
    handle.setCameraState(pose);
    handle.state.gamingControls = false; handle.state.inputEnabled = true;
    await frames();
    check(entity.up.distance(up) < 1e-5, '进入飞行保持原有倾斜角');
    check(handle.getCameraState().fov === 60, '进入飞行保持焦距');
    preparing = false; status.textContent = '可以拖动画布';
  }
  prepare.disabled = false;
  prepare.addEventListener('click', setup);
  const canvas = root.querySelector('canvas');
  canvas.addEventListener('pointerdown', event => { if (event.button === 0) startX = event.clientX; });
  canvas.addEventListener('pointerup', async event => {
    if (startX === null || Math.abs(event.clientX - startX) < 20 || preparing) { startX = null; return; }
    const dx = event.clientX - startX; startX = null;
    await frames();
    check(entity.up.distance(up) < 1e-5, '实际鼠标水平拖动不滚转画面');
    check(Math.abs(entity.forward.dot(up)) < 1e-5, '实际鼠标转向保持水平');
    check(entity.forward.dot(right) * dx > 0, '转向与鼠标左右方向一致');
    check(entity.getPosition().distance(forward.clone().mulScalar(-3)) < 1e-5, '转头保持飞行相机位置');
    status.textContent = results.querySelector('.fail') ? '验证失败' : '鼠标拖动验证通过';
  });
  root.querySelector('.sse-reset').addEventListener('click', async () => {
    // Native reset transitions take a full second, including the final roll.
    await frames(90);
    const actual = entity.getRotation();
    check(Math.abs(actual.dot(rotation)) > .99999 && entity.getPosition().distance(forward.clone().mulScalar(-3)) < 1e-5,
      '原版重置恢复飞行入口的完整姿态');
    status.textContent = results.querySelector('.fail') ? '验证失败' : '重置验证通过';
  });
  await setup();
} catch (error) { check(false, error.stack || String(error)); status.textContent = '验证失败'; }
window.addEventListener('pagehide', () => { preview?.dispose(); if (blob) URL.revokeObjectURL(blob); });
