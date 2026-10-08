import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

export const INTRO_DURATION = 1.75;

// A final modifier in Spark's generator: the actual scene splats become the
// nucleus, burst outward, and settle. Inactive means an exact passthrough.
export function createSceneIntro({ mesh, bounds, root, controls, effects, onPrepare }) {
  const doc = root.ownerDocument;
  if (!doc.getElementById('scene-intro-style')) {
    const style = doc.createElement('link');
    style.id = 'scene-intro-style';
    style.rel = 'stylesheet';
    style.href = new URL('./scene-intro.css', import.meta.url).href;
    doc.head.appendChild(style);
  }
  const reducedMotion = doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const u = {
    active: dyno.dynoInt(0), age: dyno.dynoFloat(-1), clock: dyno.dynoFloat(0),
    origin: dyno.dynoVec3(bounds.center.clone()), radius: dyno.dynoFloat(bounds.radius),
  };
  const inTypes = { gsplat: dyno.Gsplat };
  for (const [key, uniform] of Object.entries(u)) inTypes[key] = uniform.type;
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const transform = new dyno.Dyno({
      inTypes, outTypes: { gsplat: dyno.Gsplat },
      globals: () => [/* glsl */ `
        float introHash(float n) { return fract(sin(n * 12.9898 + 78.233) * 43758.5453); }
      `],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(/* glsl */ `
        ${o.gsplat} = ${i.gsplat};
        if (${i.active} != 0) {
          float id = float(${i.gsplat}.index);
          float seed = introHash(id + 1.0);
          float latitude = introHash(id + 19.0) * 2.0 - 1.0;
          float longitude = introHash(id + 83.0) * 6.283185;
          float equator = sqrt(max(0.0, 1.0 - latitude * latitude));
          vec3 direction = vec3(equator * cos(longitude), latitude, equator * sin(longitude));
          vec3 original = (${i.gsplat}.center - ${i.origin}) / ${i.radius};
          float clock = ${i.clock};
          float orbit = step(.84, introHash(id + 113.0));
          float band = floor(introHash(id + 157.0) * 3.0);
          float spin = clock * (.32 + latitude * .55);
          float breathe = 1.0 + .035 * sin(clock * 1.8);
          float current = .5 + .5 * sin(longitude * 3.0 + latitude * 11.0 - clock * 2.1);
          vec3 nucleus = direction * (.024 + .11 * pow(seed, .333333)) * breathe;
          nucleus.xz = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * nucleus.xz;
          nucleus += direction * (current - .5) * .006;
          // Three thin streams orbit the core using the scene's own splats.
          float angle = longitude + clock * mix(.65, -.8, step(1.5, band));
          float tilt = band * 1.0472 + .35 + sin(clock * .24) * .12;
          vec3 stream = vec3(cos(angle), sin(angle) * .32, sin(angle) * .9474);
          stream.xy = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * stream.xy;
          stream *= (.169 + band * .016 + (seed - .5) * .005) * breathe;
          nucleus = mix(nucleus, stream, orbit);
          float progress = ${i.age} < 0.0 ? 0.0 :
            clamp((${i.age} - seed * .07) / ${INTRO_DURATION - .07}, 0.0, 1.0);
          // Very fast release, a gentle overshoot, then an exact landing.
          float expansion = (1.0 - exp(-8.0 * progress)) / (1.0 - exp(-8.0));
          expansion += .38 * sin(progress * 3.14159265) * exp(-2.3 * progress);
          float flight = sin(progress * 3.14159265) * exp(-3.0 * progress);
          vec3 position = mix(nucleus, original, expansion);
          position += cross(vec3(0.0, 1.0, 0.0), original) * flight * .22;
          position += direction * flight * .18;
          ${o.gsplat}.center = ${i.origin} + position * ${i.radius};
          float reveal = smoothstep(.06, .65, progress);
          float tint = introHash(id + 211.0);
          float spark = pow(.5 + .5 * sin(clock * 3.6 + tint * 93.0), 24.0);
          float vein = pow(current, 7.0);
          float streamLight = .35 + .65 * pow(.5 + .5 * cos(angle - clock * 1.2), 4.0);
          vec3 starlight = mix(vec3(.20, .46, .95), vec3(1.0, .77, .38), pow(tint, 4.0));
          starlight *= mix(.48 + vein * .65, streamLight, orbit);
          starlight += vec3(.5, .72, 1.0) * spark * .8;
          ${o.gsplat}.rgba.rgb = mix(starlight, ${i.gsplat}.rgba.rgb, reveal);
          ${o.gsplat}.rgba.a *= mix(mix(.85, .6, orbit), 1.0, reveal);
          float grain = mix(.0015, .001, orbit) * (.6 + tint);
          ${o.gsplat}.scales = mix(vec3(${i.radius} * grain),
                                   ${i.gsplat}.scales, reveal);
          vec4 orientation = ${i.gsplat}.quaternion;
          if (orientation.w < 0.0) orientation = -orientation;
          ${o.gsplat}.quaternion = normalize(mix(vec4(0.0, 0.0, 0.0, 1.0),
                                                orientation, reveal));
        }
      `),
    });
    return transform.apply({ gsplat, ...u });
  });
  mesh.objectModifiers = [...(mesh.objectModifiers || []), modifier];
  mesh.updateGenerator();

  const overlay = doc.createElement('div');
  overlay.className = 'scene-intro';
  overlay.dataset.phase = 'complete';
  overlay.innerHTML = `
    <div class="scene-intro-aura" aria-hidden="true"></div>
    <div class="scene-intro-orbit" aria-hidden="true"></div>
    <div class="scene-intro-flash" aria-hidden="true"></div>
    <div class="scene-intro-wave" aria-hidden="true"></div>
    <button class="scene-intro-trigger" type="button" aria-label="展开完整三维场景"></button>
    <button class="scene-intro-skip" type="button">跳过动画</button>
    <span class="scene-intro-status" role="status" aria-live="polite"></span>`;
  const replay = doc.createElement('button');
  replay.type = 'button';
  replay.className = 'scene-intro-replay';
  replay.textContent = '↻ 重播入场';
  replay.title = '重新聚合场景，点击后爆开成形';
  root.append(overlay, replay);
  const trigger = overlay.querySelector('.scene-intro-trigger');
  const skip = overlay.querySelector('.scene-intro-skip');
  const status = overlay.querySelector('.scene-intro-status');
  let phase = 'complete';
  let restore = null;
  const handlers = [];
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    handlers.push(() => target.removeEventListener(type, callback));
  }
  function show(next) {
    phase = next;
    overlay.dataset.phase = next;
    overlay.hidden = next === 'complete';
    trigger.hidden = next !== 'waiting';
    skip.hidden = next === 'complete';
    replay.hidden = reducedMotion || next !== 'complete';
    status.textContent = next === 'waiting' ? '场景已聚合，点击展开' :
      next === 'running' ? '场景正在展开' : '场景已展开';
  }
  function finish() {
    if (phase === 'disposed' || phase === 'complete') return;
    u.active.value = 0;
    u.age.value = INTRO_DURATION;
    effects.leave();
    if (restore) {
      controls.enabled = restore.enabled;
      controls.autoRotate = restore.autoRotate;
      restore = null;
    }
    mesh.updateVersion();
    const hadFocus = overlay.contains(doc.activeElement);
    show('complete');
    if (hadFocus) root.querySelector('canvas')?.focus({ preventScroll: true });
  }
  const intro = {
    uniforms: u,
    get phase() { return phase; },
    get active() { return phase === 'waiting' || phase === 'running'; },
    replay() {
      if (phase === 'disposed' || intro.active || reducedMotion) return false;
      onPrepare?.();
      restore = { enabled: controls.enabled, autoRotate: controls.autoRotate };
      controls.enabled = false;
      controls.autoRotate = false;
      effects.reset();
      effects.leave();
      u.active.value = 1;
      u.age.value = -1;
      u.clock.value = 0;
      mesh.updateVersion();
      show('waiting');
      return true;
    },
    play() {
      if (phase !== 'waiting') return false;
      u.age.value = 0;
      mesh.updateVersion();
      show('running');
      return true;
    },
    skip: finish,
    update(dt) {
      if (!intro.active) return;
      const step = Math.max(0, Math.min(dt, .05));
      u.clock.value += step;
      if (phase === 'running') {
        u.age.value = Math.min(INTRO_DURATION, u.age.value + step);
        if (u.age.value >= INTRO_DURATION) { finish(); return; }
      }
      mesh.updateVersion();
    },
    applyCamera(camera) {
      if (phase !== 'running' || u.age.value > .4) return;
      const age = u.age.value;
      const kick = Math.sin(Math.min(1, age / .3) * Math.PI) * Math.exp(-age * 7);
      camera.translateZ(bounds.radius * .07 * kick);
    },
    dispose() {
      if (phase === 'disposed') return;
      if (restore) {
        controls.enabled = restore.enabled;
        controls.autoRotate = restore.autoRotate;
      }
      handlers.forEach(remove => remove());
      overlay.remove();
      replay.remove();
      phase = 'disposed';
    },
  };
  listen(trigger, 'click', e => { e.stopPropagation(); intro.play(); });
  listen(skip, 'click', e => { e.stopPropagation(); finish(); });
  listen(replay, 'click', e => { e.stopPropagation(); if (intro.replay()) trigger.focus({ preventScroll: true }); });
  show('complete');
  intro.replay();
  return intro;
}
