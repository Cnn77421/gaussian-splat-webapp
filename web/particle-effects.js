import * as THREE from './vendor/spark/three.core.js';
const modes = ['无形变', '局部排斥', '局部吸附', '局部流动', '拖拽甩动', '高度扭转', '局部涡旋', '呼吸起伏', '空间扰动', '点击爆散', '点击波纹'];
const hints = ['点击画面触发波纹。', '鼠标靠近时排斥，移开后回归。', '鼠标附近粒子向中心吸附。', '粒子沿鼠标周围流动。', '按住拖动，粒子随鼠标速度甩动。', '模型随高度缓慢扭转。', '鼠标附近形成局部涡旋。', '模型轻微呼吸起伏。', '连续空间扰动。', '单击模型局部爆散，随后回归。', '单击模型，从点击处扩散波纹。'];
const functions = `
vec3 fxSafe(vec3 p) { return p / max(length(p), 0.0001); }
vec3 fxFlow(vec3 p, float t) { return vec3(sin(p.z+t)-cos(p.y-0.7*t),sin(p.x-0.8*t)-cos(p.z+0.6*t),sin(p.y+0.7*t)-cos(p.x-t)); }
vec4 fxQmul(vec4 a, vec4 b) { return vec4(a.w*b.xyz+b.w*a.xyz+cross(a.xyz,b.xyz),a.w*b.w-dot(a.xyz,b.xyz)); }
vec3 fxTurn(vec3 p, vec3 axis, float angle) { return p*cos(angle)+cross(axis,p)*sin(angle)+axis*dot(axis,p)*(1.0-cos(angle)); }
float fxWeight(vec3 delta) { float w=1.0-smoothstep(0.0,fxSettings.y,length(delta)); return w*w; }
float fxAngle(vec3 base) {
  if (fxSettings.w == 5.0) { return sin(fxSettings.z*0.8)*clamp(-base.y,-1.0,1.0)*0.55*fxSettings.x*fxDisplay.x; }
  if (fxSettings.w == 6.0) { return 1.8*fxWeight(base-fxPointer.xyz)*fxPointer.w*fxSettings.x*fxDisplay.x; }
  return 0.0;
}
vec3 fxPulse(vec3 base, vec4 pulse, float kind) {
  if (pulse.w >= 4.0 || kind < 0.5) { return vec3(0.0); }
  vec3 away=base-pulse.xyz;
  float d=length(away);
  float age=pulse.w;
  if (kind < 1.5) {
    float envelope=(1.0-exp(-age*14.0))*exp(-age*2.8);
    float local=1.0-smoothstep(0.0,fxSettings.y*1.8,d);
    return (fxSafe(away)+fxFlow(base*5.0,0.0)*0.12)*fxSettings.y*2.4*local*local*envelope;
  }
  float shell=exp(-pow((d-age*0.8)/0.09,2.0));
  return fxSafe(away)*shell*exp(-age*1.7)*0.16*smoothstep(0.0,0.06,age);
}
vec3 fxDeform(vec3 base) {
  vec3 p=base;
  vec3 delta=base-fxPointer.xyz;
  float power=fxSettings.x*fxDisplay.x;
  float weight=fxWeight(delta);
  float hover=fxPointer.w;
  float radius=fxSettings.y;
  float t=fxSettings.z;
  float mode=fxSettings.w;
  if (mode == 1.0) { p+=fxSafe(delta)*radius*0.65*weight*hover*power; }
  if (mode == 2.0) { p-=delta*0.72*weight*hover*power; }
  if (mode == 3.0) { p+=(fxSafe(cross(fxAxis.xyz,delta))*0.65+fxSafe(delta)*0.3+fxFlow(base,t)*0.12)*radius*weight*hover*power; }
  if (mode == 4.0) { p+=fxVelocity.xyz*0.075*weight*power+fxSafe(delta)*length(fxVelocity.xyz)*0.018*weight*power; }
  if (mode == 5.0) { p=fxTurn(base,vec3(0.0,1.0,0.0),fxAngle(base)); }
  if (mode == 6.0) { p=fxPointer.xyz+fxTurn(delta,fxAxis.xyz,fxAngle(base)); }
  if (mode == 7.0) { p+=base*sin(t*1.4)*0.022*power; }
  if (mode == 8.0) { p+=fxFlow(base,t)*0.015*power; }
  p+=(base*sin(t*1.4)*0.008+fxFlow(base,t)*0.003)*fxAxis.w*power;
  p+=(fxPulse(base,fxPulse0,fxKinds.x)+fxPulse(base,fxPulse1,fxKinds.y)+fxPulse(base,fxPulse2,fxKinds.z)+fxPulse(base,fxPulse3,fxKinds.w))*power;
  return p;
}
`;
const uniforms = ['fxOrigin', 'fxSettings', 'fxPointer', 'fxVelocity', 'fxAxis', 'fxDisplay', 'fxPulse0', 'fxPulse1', 'fxPulse2', 'fxPulse3', 'fxKinds'];
const glsl = uniforms.map(n => `uniform vec4 ${n};`).join('\n') + functions + `
void modifySplatCenter(inout vec3 center) { center=fxOrigin.xyz+fxDeform((center-fxOrigin.xyz)/fxOrigin.w)*fxOrigin.w; }
void modifySplatRotationScale(vec3 originalCenter,vec3 modifiedCenter,inout vec4 rotation,inout vec3 scale) {
  vec3 base=(originalCenter-fxOrigin.xyz)/fxOrigin.w;
  float angle=fxAngle(base);
  vec3 axis=fxAxis.xyz;
  if (fxSettings.w == 5.0) { axis=vec3(0.0,1.0,0.0); }
  rotation=fxQmul(vec4(axis*sin(angle*0.5),cos(angle*0.5)),rotation);
  scale*=fxDisplay.z;
  if (fxDisplay.y > 0.5) { scale=vec3(fxOrigin.w*0.006*fxDisplay.z); rotation=vec4(0.0,0.0,0.0,1.0); }
}
void modifySplatColor(vec3 center,inout vec4 color) {}
`;
// Both backends use the same scalar/vector formulas. This deliberately small
// translation covers only the straight-line helper language above (no arrays).
const type = t => ({vec3:'vec3f', vec4:'vec4f', float:'f32'})[t];
let wgslFunctions = functions.replace(/(vec3|vec4|float) (fx\w+)\(([^)]*)\)\s*\{/g, (_, t, name, args) =>
  `fn ${name}(${args.split(',').map(a => { const [kind,key]=a.trim().split(/\s+/); return `${key}: ${type(kind)}`; }).join(',')}) -> ${type(t)} {`);
wgslFunctions = wgslFunctions.replace(/\b(vec3|vec4|float) (\w+)\s*=/g, (_,t,n) => `var ${n}: ${type(t)} =`).replace(/\bvec3\(/g,'vec3f(').replace(/\bvec4\(/g,'vec4f(');
for (const name of uniforms) wgslFunctions = wgslFunctions.replace(new RegExp(`\\b${name}\\b`, 'g'), `uniforms.${name}`);
const wgsl = uniforms.map(n => `uniform ${n}: vec4f;`).join('\n') + wgslFunctions + `
fn modifySplatCenter(center: ptr<function, vec3f>) { *center=uniforms.fxOrigin.xyz+fxDeform((*center-uniforms.fxOrigin.xyz)/uniforms.fxOrigin.w)*uniforms.fxOrigin.w; }
fn modifySplatRotationScale(originalCenter: vec3f,modifiedCenter: vec3f,rotation: ptr<function, vec4f>,scale: ptr<function, vec3f>) {
  let base=(originalCenter-uniforms.fxOrigin.xyz)/uniforms.fxOrigin.w;
  let angle=fxAngle(base);
  var axis=uniforms.fxAxis.xyz;
  if (uniforms.fxSettings.w == 5.0) { axis=vec3f(0.0,1.0,0.0); }
  *rotation=fxQmul(vec4f(axis*sin(angle*0.5),cos(angle*0.5)),*rotation);
  *scale*=uniforms.fxDisplay.z;
  if (uniforms.fxDisplay.y > 0.5) { *scale=vec3f(uniforms.fxOrigin.w*0.006*uniforms.fxDisplay.z); *rotation=vec4f(0.0,0.0,0.0,1.0); }
}
fn modifySplatColor(center: vec3f,color: ptr<function, vec4f>) {}
`;
export class ParticleEffects {
  constructor(preview) {
    this.preview=preview; this.handle=preview.handle; this.app=this.handle.app;
    this.splat=this.app.root.findByName('gsplat').gsplat;
    this.origin=preview.legacy.center.clone(); this.radius=preview.legacy.radius;
    this.params={enabled:false,mode:1,strength:.65,radius:.28,ambient:false,pointCloud:false,size:1};
    this.pointer=new THREE.Vector3(); this.target=new THREE.Vector3(); this.velocity=new THREE.Vector3(); this.targetVelocity=new THREE.Vector3(); this.axis=new THREE.Vector3(0,1,0);
    this.pulses=Array.from({length:4},()=>({point:new THREE.Vector3(),age:99,kind:0})); this.pulseIndex=0; this.time=0; this.hover=0;
    this.values=Object.fromEntries(uniforms.map(n=>[n,new Float32Array(4)]));
    this.splat.setWorkBufferModifier({glsl,wgsl});
    this.panel=document.createElement('details'); this.panel.className='particle-panel';
    this.panel.innerHTML=`<summary>粒子特效 <span data-state>已关闭</span></summary><div class="particle-content">
      <label class="fx-switch"><input type="checkbox" data-param="enabled"> 开启粒子特效</label>
      <fieldset><label>模式<select data-param="mode">${modes.map((n,i)=>`<option value="${i}">${n}</option>`).join('')}</select></label>
      <label>强度 <output data-value="strength">0.65</output><input type="range" data-param="strength" min="0" max="2" step=".01" value=".65"></label>
      <label>范围 <output data-value="radius">0.28</output><input type="range" data-param="radius" min=".02" max="1.2" step=".01" value=".28"></label>
      <label><input type="checkbox" data-param="ambient"> 叠加微动</label>
      <div class="fx-actions"><button data-fx="explode">爆散脉冲</button><button data-fx="ripple">波纹脉冲</button></div></fieldset>
      <div class="fx-actions"><button data-fx="reset">恢复原状 X</button><button data-fx="point">点云 P</button></div>
      <p data-hint></p><p>模型尺寸：− / + · 点击触发效果，拖动操作视角</p></div>`;
    this.panel.querySelector('[data-param="mode"]').value='1';
    this.stack=document.createElement('div');this.stack.className='host-control-stack';
    this.stack.append(preview.legacy.panel,this.panel);
    preview.root.querySelector('.sse-ui').append(this.stack);
    this.listeners=[];
    this.listen(this.panel,'input',e=>{
      const key=e.target.dataset.param; if (!key) return;
      const value=e.target.type==='checkbox'?e.target.checked:Number(e.target.value);
      this.set(key,value); this.sync();
    });
    this.listen(this.panel,'click',e=>{ e.stopPropagation(); const action=e.target.closest('[data-fx]')?.dataset.fx;
      if(action==='reset') this.reset();
      else if(action==='point') this.set('pointCloud',!this.params.pointCloud);
      else if(action) this.pulse(this.origin,action==='explode'?1:2);
      // Checkbox default activation happens before input/change. Do not
      // overwrite checked here before the input listener reads its new value.
      if(action) this.sync();
    });
    const surface=e=>e.target.tagName==='CANVAS'||e.target.classList.contains('legacy-surface');
    this.listen(preview.root,'pointermove',e=>{
      if(!surface(e)) {this.inside=false;return;}
      if(!this.params.enabled) return;
      this.inside=true;
      if (this.down) this.down.moved=Math.max(this.down.moved,Math.hypot(e.clientX-this.down.x,e.clientY-this.down.y));
      this.locate(e.clientX,e.clientY);
    });
    this.listen(preview.root,'pointerleave',()=>{this.inside=false;this.targetVelocity.set(0,0,0);});
    this.listen(preview.root,'pointerdown',e=>{ if(this.params.enabled&&surface(e)&&e.button===0){this.down={x:e.clientX,y:e.clientY,moved:0};this.locate(e.clientX,e.clientY,true);} });
    this.listen(window,'pointerup',e=>{ const down=this.down;this.down=null;
      if(down&&e.button===0&&down.moved<4&&this.params.enabled) this.locate(e.clientX,e.clientY,true).then(hit=>{
        if(hit&&!preview.disposed) this.pulse(hit,this.params.mode===9?1:2);
      }).catch(()=>{});
      this.targetVelocity.set(0,0,0);
    });
    this.listen(window,'pointercancel',()=>{this.down=null;this.targetVelocity.set(0,0,0);});
    this.listen(window,'keydown',e=>{
      if(!preview.root.contains(document.activeElement)||e.target.closest?.('input,select,textarea,button,summary,[contenteditable]')||e.ctrlKey||e.metaKey||e.altKey||e.repeat) return;
      if(!['KeyX','KeyP','Equal','Minus','NumpadAdd','NumpadSubtract'].includes(e.code)) return;
      e.preventDefault();e.stopImmediatePropagation();
      if(e.code==='KeyX') this.reset();
      else if(e.code==='KeyP') this.set('pointCloud',!this.params.pointCloud);
      else this.set('size',Math.max(.2,Math.min(4,this.params.size*(e.code==='Minus'||e.code==='NumpadSubtract' ? .9 : 1.1))));
      this.sync();
    },true);
    // Fold the other card so all three mode buttons stay reachable on phones.
    this.listen(this.panel,'toggle',()=>{ if(this.panel.open) { preview.legacy.panel.open=false;
      const settings=preview.root.querySelector('.sse-settingsPanel');
      if(settings&&!settings.classList.contains('sse-hidden')) preview.root.querySelector('.sse-settings').click();
    } });
    this.listen(preview.legacy.panel,'toggle',()=>{if(preview.legacy.panel.open&&preview.legacy.active)this.panel.open=false;});
    this.update=dt=>this.tick(Math.min(dt,.1));this.app.on('update',this.update);
    this.dirty=true;this.sync();this.tick(0);
  }
  listen(target,event,fn,options){target.addEventListener(event,fn,options);this.listeners.push(()=>target.removeEventListener(event,fn,options));}
  set(key,value){ this.params[key]=value; if(key==='enabled') this.clear();this.dirty=true; }
  clear(){this.ticket=(this.ticket||0)+1;this.down=null;this.hover=0;this.velocity.set(0,0,0);this.targetVelocity.set(0,0,0);this.pulses.forEach(p=>{p.age=99;p.kind=0;});this.inside=false;}
  reset(){Object.assign(this.params,{mode:1,strength:.65,radius:.28,ambient:false});this.clear();this.dirty=true;this.sync();}
  pulse(point,kind=2){if(!this.params.enabled) return;const p=this.pulses[this.pulseIndex++%4];p.point.copy(point).sub(this.origin).divideScalar(this.radius);p.age=0;p.kind=kind;this.dirty=true;}
  async locate(x,y,force=false){
    if(!this.params.enabled) return null;
    const now=performance.now();if(!force&&now-(this.lastPick||0)<75) return null;this.lastPick=now;
    const ticket=this.ticket=(this.ticket||0)+1,rect=this.preview.root.getBoundingClientRect();
    const hit=await this.preview.picker?.pick((x-rect.left)/rect.width,(y-rect.top)/rect.height);
    if(ticket!==this.ticket||this.preview.disposed) return null;
    if(!hit){this.inside=false;return null;}
    const point=new THREE.Vector3(hit.x,hit.y,hit.z),next=point.clone().sub(this.origin).divideScalar(this.radius);
    const elapsed=Math.max(.016,(now-(this.lastHit||now))/1000);
    if(this.down&&this.lastHit){this.targetVelocity.copy(next).sub(this.target).divideScalar(elapsed).clampLength(0,7);}
    this.target.copy(next);this.lastHit=now;this.dirty=true;return point;
  }
  sync(){
    this.panel.querySelector('[data-state]').textContent=this.params.enabled?'已开启':'已关闭';
    this.panel.querySelector('fieldset').disabled=!this.params.enabled;
    this.panel.querySelector('[data-hint]').textContent=this.params.enabled?hints[this.params.mode]:'特效已关闭，开启后恢复原来的模式与参数。';
    for(const [key,value] of Object.entries(this.params)){const input=this.panel.querySelector(`[data-param="${key}"]`);if(input){if(input.type==='checkbox')input.checked=value;else input.value=String(value);}const out=this.panel.querySelector(`[data-value="${key}"]`);if(out)out.textContent=Number(value).toFixed(2);}
    this.panel.querySelector('[data-fx="point"]').setAttribute('aria-pressed',String(this.params.pointCloud));
  }
  tick(dt){
    const p=this.params;this.time+=dt;
    const nextHover=p.enabled&&this.inside&&this.lastHit?1:0;
    this.hover+=(nextHover-this.hover)*(1-Math.exp(-7*dt));
    this.pointer.lerp(this.target,1-Math.exp(-18*dt));this.velocity.lerp(this.targetVelocity,1-Math.exp(-9*dt));this.targetVelocity.multiplyScalar(Math.exp(-5*dt));
    this.pulses.forEach(pulse=>{pulse.age+=dt;});
    const continuous=p.enabled&&(p.ambient||[5,7,8].includes(p.mode)||this.hover>.001||this.velocity.lengthSq()>.00001||this.pulses.some(pulse=>pulse.age<4));
    // No work-buffer redraw at rest. Active modifiers run before sorting, so
    // moving splats retain native depth sorting instead of stale transparency.
    this.dirty ||= this.wasContinuous && !continuous;this.wasContinuous=continuous;
    if(!continuous&&!this.dirty) {this.splat.workBufferUpdate=0;return;}
    const set=(name,...values)=>{this.values[name].set(values);this.splat.setParameter(name,this.values[name]);};
    set('fxOrigin',...this.origin.toArray(),this.radius);set('fxSettings',p.strength,p.radius,this.time,p.mode);
    set('fxPointer',...this.pointer.toArray(),this.hover);set('fxVelocity',...this.velocity.toArray(),0);
    const axis=this.preview.legacy.active?this.preview.legacy.up:this.axis;
    set('fxAxis',...axis.toArray(),p.ambient?1:0);set('fxDisplay',p.enabled?1:0,p.pointCloud?1:0,p.size,0);
    this.pulses.forEach((pulse,i)=>set(`fxPulse${i}`,...pulse.point.toArray(),pulse.age));set('fxKinds',...this.pulses.map(pulse=>pulse.kind));
    this.splat.workBufferUpdate=continuous?2:1;this.app.renderNextFrame=true;this.dirty=false;
  }
  dispose(){this.ticket=(this.ticket||0)+1;this.app.off('update',this.update);this.listeners.forEach(fn=>fn());this.panel.remove();this.stack.remove();}
}
