import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

// Uses Spark's official shader-effects example's Dyno modifier pattern.
// Each frame starts from the original splat, so no displacement accumulates.
// The generated positions participate in Spark's sorting pipeline.
// https://github.com/sparkjsdev/spark/tree/main/examples/splat-shader-effects
export function createSplatEffects(mesh, bounds) {
  const u = {
    enabled: dyno.dynoInt(1),
    time: dyno.dynoFloat(0), mode: dyno.dynoInt(0), strength: dyno.dynoFloat(0.65),
    radius: dyno.dynoFloat(0.28), hover: dyno.dynoFloat(0), ambient: dyno.dynoFloat(0),
    origin: dyno.dynoVec3(bounds.center.clone()), scale: dyno.dynoFloat(bounds.radius),
    pointCloud: dyno.dynoInt(0), splatScale: dyno.dynoFloat(1),
    pointer: dyno.dynoVec3(new THREE.Vector3()), velocity: dyno.dynoVec3(new THREE.Vector3()),
    axis: dyno.dynoVec3(new THREE.Vector3(0, 0, 1)),
    pulse0: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 99)),
    pulse1: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 99)),
    pulse2: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 99)),
    pulse3: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 99)),
    kinds: dyno.dynoVec4(new THREE.Vector4()),
  };
  const inTypes = { gsplat: dyno.Gsplat };
  for (const [key, value] of Object.entries(u)) inTypes[key] = value.type;
  mesh.objectModifiers = [dyno.dynoBlock(
    { gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const effect = new dyno.Dyno({
        inTypes, outTypes: { gsplat: dyno.Gsplat },
        globals: () => [/* glsl */ `
          vec3 fxSafeDir(vec3 p) { return p / max(length(p), 0.0001); }
          // Smooth divergence-free field; neighbouring splats move coherently.
          vec3 fxFlow(vec3 p, float t) {
            return vec3(sin(p.z + t) - cos(p.y - t * .7),
                        sin(p.x - t * .8) - cos(p.z + t * .6),
                        sin(p.y + t * .7) - cos(p.x - t));
          }
          vec4 fxQuatMul(vec4 a, vec4 b) {
            return vec4(a.w*b.xyz + b.w*a.xyz + cross(a.xyz,b.xyz),
                        a.w*b.w - dot(a.xyz,b.xyz));
          }
        `],
        statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(/* glsl */ `
          ${o.gsplat} = ${i.gsplat};
          vec3 base = (${i.gsplat}.center - ${i.origin}) / ${i.scale};
          vec3 p = base;
          vec3 delta = base - ${i.pointer};
          float dist = length(delta);
          float rad = max(${i.radius}, .03);
          float weight = 1.0 - smoothstep(0.0, rad, dist);
          weight *= weight;
          vec3 dir = fxSafeDir(delta);
          float power = ${i.enabled} != 0 ? ${i.strength} : 0.0;
          float hover = ${i.hover};
          float t = ${i.time};
          vec3 flow = fxFlow(base * 3.5, t * .45);

          if (${i.mode} == 1) { // Local repulsion
            p += dir * rad * .65 * weight * hover * power;
          } else if (${i.mode} == 2) { // Attraction, with a finite core
            p -= delta * .72 * weight * hover * power;
          } else if (${i.mode} == 3) { // Flow around the pointer
            vec3 tangent = cross(${i.axis}, delta);
            p += (fxSafeDir(tangent) * .65 + dir * .3 + flow * .12)
               * rad * weight * hover * power;
          } else if (${i.mode} == 4) { // Drag velocity, with a smooth release
            p += ${i.velocity} * .075 * weight * power;
            p += dir * length(${i.velocity}) * .018 * weight * power;
          } else if (${i.mode} == 5) { // Height-dependent twist
            float angle = sin(t * .8) * clamp(-base.y, -1.0, 1.0) * .55 * power;
            float c = cos(angle), s = sin(angle);
            p.xz = mat2(c, -s, s, c) * base.xz;
            vec4 rotation = vec4(0.0, sin(angle * .5), 0.0, cos(angle * .5));
            ${o.gsplat}.quaternion = fxQuatMul(rotation, ${i.gsplat}.quaternion);
          } else if (${i.mode} == 6) { // Local vortex
            float angle = 1.8 * weight * hover * power;
            vec3 axis = ${i.axis};
            vec3 rotated = delta * cos(angle) + cross(axis, delta) * sin(angle)
                         + axis * dot(axis, delta) * (1.0 - cos(angle));
            p += rotated - delta;
            ${o.gsplat}.quaternion = fxQuatMul(
              vec4(axis * sin(angle * .5), cos(angle * .5)), ${i.gsplat}.quaternion);
          } else if (${i.mode} == 7) {
            p += base * sin(t * 1.4) * .022 * power;
          } else if (${i.mode} == 8) {
            p += flow * .015 * power;
          }

          // Optional small ambient motion, independently adjustable.
          p += (base * sin(t * 1.4) * .008 + flow * .003) * ${i.ambient} * power;
          for (int n = 0; n < 4; n++) {
            vec4 event = n == 0 ? ${i.pulse0} : n == 1 ? ${i.pulse1}
                       : n == 2 ? ${i.pulse2} : ${i.pulse3};
            float kind = ${i.kinds}[n];
            float age = event.w;
            if (age < 4.0 && kind > 0.0) {
              vec3 away = base - event.xyz;
              float d = length(away);
              if (kind < 1.5) {
                float envelope = (1.0 - exp(-age * 14.0)) * exp(-age * 2.8);
                float local = 1.0 - smoothstep(0.0, rad * 1.8, d);
                p += (fxSafeDir(away) + fxFlow(base * 5.0, 0.0) * .12)
                   * rad * 2.4 * local * local * envelope * power;
              } else {
                float shell = exp(-pow((d - age * .8) / .09, 2.0));
                p += fxSafeDir(away) * shell * exp(-age * 1.7)
                   * .16 * power * smoothstep(0.0, .06, age);
              }
            }
          }
          ${o.gsplat}.center = ${i.origin} + p * ${i.scale};
          if (${i.pointCloud} != 0) {
            ${o.gsplat}.scales = vec3(${i.scale} * .006 * ${i.splatScale});
            ${o.gsplat}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
          } else {
            ${o.gsplat}.scales *= ${i.splatScale};
          }
        `),
      });
      return effect.apply({ gsplat, ...u });
    },
  )];
  mesh.updateGenerator();
  let nextPulse = 0;
  let dirty = true;
  const pulses = [u.pulse0, u.pulse1, u.pulse2, u.pulse3];
  const targetPointer = new THREE.Vector3();
  const targetVelocity = new THREE.Vector3();
  let hovering = false;
  const effects = {
    uniforms: u,
    setEnabled(value) {
      const enabled = value ? 1 : 0;
      if (u.enabled.value === enabled) return;
      u.enabled.value = enabled;
      effects.reset();
    },
    setMode(mode) {
      const value = Number(mode);
      if (u.mode.value !== value) {
        u.hover.value = 0; u.velocity.value.set(0, 0, 0);
        targetVelocity.set(0, 0, 0); hovering = false;
      }
      u.mode.value = value; dirty = true;
    },
    setStrength(value) { u.strength.value = Number(value); dirty = true; },
    setRadius(value) { u.radius.value = Number(value); dirty = true; },
    setAmbient(value) { u.ambient.value = value ? 1 : 0; dirty = true; },
    setPointCloud(value) { u.pointCloud.value = value ? 1 : 0; dirty = true; },
    setSplatScale(value) { u.splatScale.value = value; dirty = true; },
    setPointer(point, axis, velocity, active) {
      if (!u.enabled.value) return;
      targetPointer.copy(point).sub(bounds.center).divideScalar(bounds.radius);
      u.axis.value.copy(axis).normalize();
      targetVelocity.copy(velocity).divideScalar(bounds.radius).clampLength(0, 7);
      hovering = active;
    },
    leave() { hovering = false; targetVelocity.set(0, 0, 0); },
    pulse(kind, point) {
      if (!u.enabled.value) return;
      const p = point.clone().sub(bounds.center).divideScalar(bounds.radius);
      pulses[nextPulse].value.set(p.x, p.y, p.z, 0);
      u.kinds.value.setComponent(nextPulse, kind === 'explosion' ? 1 : 2);
      nextPulse = (nextPulse + 1) % 4;
      dirty = true;
    },
    reset() {
      u.hover.value = 0;
      u.velocity.value.set(0, 0, 0);
      targetVelocity.set(0, 0, 0);
      pulses.forEach(p => { p.value.w = 99; });
      hovering = false;
      dirty = true;
    },
    update(dt) {
      if (!u.enabled.value) {
        if (dirty) { mesh.updateVersion(); dirty = false; }
        return;
      }
      const continuous = (u.mode.value >= 5 && u.mode.value <= 8) || u.ambient.value > 0;
      const activePulse = pulses.some(p => p.value.w < 4);
      const local = [1, 2, 3, 4, 6].includes(u.mode.value);
      const active = (local && (hovering || u.hover.value > .0001 ||
        u.velocity.value.lengthSq() > 1e-8)) || continuous || activePulse;
      if (!active && !dirty) return;
      u.time.value += dt;
      u.pointer.value.lerp(targetPointer, 1 - Math.exp(-18 * dt));
      u.hover.value = THREE.MathUtils.lerp(u.hover.value, hovering ? 1 : 0, 1 - Math.exp(-7 * dt));
      if (!hovering && u.hover.value < .0001) u.hover.value = 0;
      u.velocity.value.lerp(targetVelocity, 1 - Math.exp(-9 * dt));
      targetVelocity.multiplyScalar(Math.exp(-5 * dt));
      if (u.velocity.value.lengthSq() < 1e-8) u.velocity.value.set(0, 0, 0);
      pulses.forEach(p => { p.value.w = Math.min(99, p.value.w + dt); });
      mesh.updateVersion();
      dirty = false;
    },
  };
  return effects;
}
