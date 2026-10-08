const prefix = 'splat.view.v2.';
export class ViewPreferences {
  constructor(key) {
    this.key = prefix + encodeURIComponent(key);
    // An old global horizon has no reliable model identity. Do not assign it
    // to whichever model happens to open first. Existing per-model data stays.
  }
  read() {
    try { return JSON.parse(localStorage.getItem(this.key)) || {}; } catch { return {}; }
  }
  set(change) {
    try { localStorage.setItem(this.key, JSON.stringify({ ...this.read(), ...change })); return true; } catch { return false; }
  }
}
export const vectorValid = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
export const poseValid = p => p && vectorValid(p.position) && vectorValid(p.angles) && Number.isFinite(p.distance) && p.distance > 0 && Number.isFinite(p.fov) && p.fov > 0 && p.fov < 179 && ['orbit', 'fly', 'legacy'].includes(p.mode);
