const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const ui = {
  status: $('statusPill'), help: $('overlayHelp'), success: $('successCount'), fail: $('failCount'), burn: $('burnCount'), dash: $('dashState'),
  pattern: $('patternMode'), difficulty: $('difficulty'), tilt: $('cameraTilt'), guide: $('showGuide'), sound: $('soundToggle')
};

const TAU = Math.PI * 2;
const COLOR = {
  red: { name:'빨강', base:'#ff4053', deep:'#801827', glow:'rgba(255,64,83,.78)' },
  green: { name:'초록', base:'#3ee57d', deep:'#08713c', glow:'rgba(62,229,125,.76)' },
  blue: { name:'파랑', base:'#4f91ff', deep:'#123a91', glow:'rgba(79,145,255,.78)' }
};
const ORDER = ['red','green','blue'];
const nextColor = (c) => ORDER[(ORDER.indexOf(c)+1)%ORDER.length];
const rand = (a,b) => a + Math.random() * (b-a);
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const lerp = (a,b,t) => a + (b-a) * t;

const keys = new Set();
let last = performance.now();
let audioCtx;

const state = {
  mode: 'idle', elapsed: 0, wave: 0, successes: 0, fails: 0, burn: 0,
  arenaR: 310, innerR: 72, center: {x:0,y:0}, tilt: .58,
  player: { x: 0, y: 0, vx: 0, vy: 0, r: 14, dash: 0, dashCd: 0, invuln: 0, lane: 6 },
  assignment: null, orbs: [], beams: [], blasts: [], ripples: [], particles: [], targetColors: new Map(), nextBlastAt: 0, blastNo: 0, patternText: '대기'
};

function beep(freq=540, dur=.06, gain=.035) {
  if (!ui.sound.checked) return;
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
  o.frequency.value = freq; o.type = 'sine'; g.gain.value = gain;
  o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(2, Math.floor(rect.width * dpr));
  canvas.height = Math.max(2, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
new ResizeObserver(resize).observe(canvas);
resize();

function hourAngle(hour) { return (hour / 12) * TAU - Math.PI / 2; }
function pointForHour(hour, r=state.arenaR) { const a = hourAngle(hour); return {x: Math.cos(a)*r, y: Math.sin(a)*r}; }
function chooseAssignment() {
  const requested = ui.pattern.value;
  const mode = requested === 'random' ? (Math.random() < .68 ? 'two' : 'one') : requested;
  if (mode === 'two') {
    const starts = [1,4,7,10];
    const h = starts[Math.floor(Math.random()*starts.length)];
    return { mode, hours: [h, h+1 > 12 ? h-11 : h+1], label: `2줄 ${h}시·${h+1 > 12 ? h-11 : h+1}시` };
  }
  const ones = [3,6,9,12];
  const h = ones[Math.floor(Math.random()*ones.length)];
  return { mode, hours: [h], label: `1줄 ${h}시` };
}
function difficulty() {
  return {
    easy: { orbSpeed: 44, blastGap: 2.9, beamLife: .42, count: 18 },
    normal: { orbSpeed: 58, blastGap: 2.45, beamLife: .32, count: 24 },
    hard: { orbSpeed: 72, blastGap: 2.05, beamLife: .26, count: 30 }
  }[ui.difficulty.value];
}
function resetPlayer() {
  const h = 6;
  const p = pointForHour(h, state.arenaR - 30);
  state.player.x = p.x; state.player.y = p.y; state.player.vx = state.player.vy = 0; state.player.dash = 0; state.player.dashCd = 0; state.player.invuln = 0;
}
function start() {
  state.mode = 'play'; state.elapsed = 0; state.wave += 1; state.assignment = chooseAssignment(); state.orbs = []; state.beams = []; state.blasts = []; state.ripples = []; state.particles = [];
  state.targetColors.clear(); state.nextBlastAt = 1.15; state.blastNo = 0; state.patternText = state.assignment.label;
  resetPlayer(); spawnOrbs(); ui.help.style.display = 'none'; ui.status.textContent = state.patternText; beep(620,.08,.045);
}
function fail(reason='실패') { state.fails++; ui.fail.textContent = state.fails; state.mode = 'result'; ui.status.textContent = reason; ui.help.innerHTML = `<b>${reason}</b><br>R 또는 Space로 다시 시작`; ui.help.style.display = 'block'; beep(180,.14,.05); }
function success() { state.successes++; ui.success.textContent = state.successes; state.mode = 'result'; ui.status.textContent = '성공'; ui.help.innerHTML = '<b>성공!</b><br>R 또는 Space로 다음 패턴'; ui.help.style.display = 'block'; beep(880,.08,.05); setTimeout(()=>beep(1180,.08,.04),95); }
function pauseToggle() { if (state.mode === 'play') { state.mode='pause'; ui.status.textContent='일시정지'; ui.help.innerHTML='<b>일시정지</b><br>P로 재개'; ui.help.style.display='block'; } else if (state.mode === 'pause') { state.mode='play'; ui.status.textContent=state.patternText; ui.help.style.display='none'; } }

function spawnOrbs() {
  const diff = difficulty();
  const lanes = [1,3,4,5,6,7,9,10,11,12];
  const targets = state.assignment.hours;
  targets.forEach((h, i) => state.targetColors.set(h, ORDER[(state.wave+i)%3]));
  let id = 0;
  for (let i=0;i<diff.count;i++) {
    const h = lanes[Math.floor(Math.random()*lanes.length)];
    const a = hourAngle(h) + rand(-.035,.035);
    const far = state.arenaR + 230 + i * rand(13,25);
    const color = ORDER[Math.floor(Math.random()*3)];
    state.orbs.push({ id:id++, hour:h, angle:a, dist:far, color, speed: diff.orbSpeed*rand(.86,1.16), pulse: rand(0,TAU), hit:false, required: targets.includes(h) });
  }
  // ensure assigned lanes have enough meaningful orbs
  targets.forEach((h, laneIndex) => {
    for (let i=0;i<7;i++) {
      state.orbs.push({ id:id++, hour:h, angle:hourAngle(h)+rand(-.012,.012), dist:state.arenaR+185+i*58, color:ORDER[(i+laneIndex)%3], speed:diff.orbSpeed*.95, pulse:rand(0,TAU), hit:false, required:true });
    }
  });
}

function fireBlast() {
  const diff = difficulty();
  state.blastNo++;
  const hours = state.assignment.hours;
  let selected = [];
  if ([3,5,7].includes(state.blastNo) && hours.length > 1) selected = hours;
  else selected = [hours[(state.blastNo + hours.length) % hours.length]];
  selected.forEach(h => {
    state.beams.push({ hour:h, t:0, life:diff.beamLife, charge:.18 });
    const p = pointForHour(h, state.arenaR*.62);
    state.ripples.push({x:p.x,y:p.y,t:0,col:'red'});
  });
  beep(360 + state.blastNo*22, .035, .025);
}

function update(dt) {
  if (state.mode !== 'play') return;
  state.elapsed += dt; state.tilt = Number(ui.tilt.value)/100;
  const diff = difficulty();
  if (state.elapsed > state.nextBlastAt && state.blastNo < 7) { fireBlast(); state.nextBlastAt += diff.blastGap; }
  if (state.blastNo >= 7 && state.orbs.every(o => !o.required || o.dist < state.innerR + 12 || o.hit)) evaluate();

  const p = state.player;
  let ax = 0, ay = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) ay -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) ay += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1;
  const len = Math.hypot(ax, ay) || 1;
  const speed = 205 * (p.dash > 0 ? 2.65 : 1);
  p.vx = (ax/len) * speed; p.vy = (ay/len) * speed;
  p.x += p.vx * dt; p.y += p.vy * dt;
  const d = Math.hypot(p.x,p.y) || 1;
  const minR = state.innerR + 20, maxR = state.arenaR - 18;
  if (d < minR) { p.x = p.x/d*minR; p.y = p.y/d*minR; }
  if (d > maxR) { p.x = p.x/d*maxR; p.y = p.y/d*maxR; }
  p.dash = Math.max(0, p.dash-dt); p.dashCd = Math.max(0, p.dashCd-dt); p.invuln = Math.max(0, p.invuln-dt);
  ui.dash.textContent = p.dashCd <= 0 ? 'READY' : p.dashCd.toFixed(1);

  state.beams.forEach(b => b.t += dt); state.beams = state.beams.filter(b => b.t < b.life);
  state.ripples.forEach(r => r.t += dt); state.ripples = state.ripples.filter(r => r.t < .75);
  state.particles.forEach(pt => { pt.t += dt; pt.x += pt.vx*dt; pt.y += pt.vy*dt; }); state.particles = state.particles.filter(pt => pt.t < pt.life);

  for (const o of state.orbs) {
    o.dist -= o.speed * dt; o.pulse += dt * 4;
    for (const b of state.beams) {
      if (b.t > b.charge && Math.abs(angleDiff(o.angle, hourAngle(b.hour))) < .08 && o.dist < state.arenaR + 20 && o.dist > state.innerR - 10 && !o.hit) {
        o.color = nextColor(o.color); o.hit = true; burst(o); beep(760,.025,.018);
      }
    }
    if (o.dist <= state.innerR + 4) {
      if (o.required && o.color !== state.targetColors.get(o.hour)) fail(`${o.hour}시 ${COLOR[o.color].name} 불일치`);
      o.required = false;
    }
  }

  for (const b of state.beams) {
    if (b.t > b.charge && Math.abs(angleDiff(Math.atan2(p.y,p.x), hourAngle(b.hour))) < .045 && Math.hypot(p.x,p.y) > state.innerR && p.invuln <= 0) {
      state.burn++; ui.burn.textContent = state.burn; p.invuln = .55; state.ripples.push({x:p.x,y:p.y,t:0,col:'red'}); beep(220,.04,.035);
      if (state.burn % 4 === 0) fail('화상 누적');
    }
  }
}
function angleDiff(a,b){ return Math.abs(Math.atan2(Math.sin(a-b), Math.cos(a-b))); }
function evaluate() {
  const bad = state.assignment.hours.find(h => state.orbs.some(o => o.required && o.hour === h && o.dist <= state.innerR + 24 && o.color !== state.targetColors.get(h)));
  bad ? fail(`${bad}시 색 실패`) : success();
}
function burst(o) {
  const pos = {x: Math.cos(o.angle)*o.dist, y: Math.sin(o.angle)*o.dist};
  for (let i=0;i<9;i++) state.particles.push({x:pos.x,y:pos.y,vx:rand(-45,45),vy:rand(-45,45),t:0,life:rand(.25,.55),color:o.color});
}

function project(x,y,z=0) {
  const tilt = lerp(.28,.78,state.tilt);
  return { x: state.center.x + x, y: state.center.y + y * tilt - z };
}
function sphere(d, x, y, r, key, alpha=1) {
  const c = COLOR[key];
  const g = ctx.createRadialGradient(x-r*.35,y-r*.42,r*.1,x,y,r*1.2);
  g.addColorStop(0, `rgba(255,255,255,${.95*alpha})`);
  g.addColorStop(.18, c.base);
  g.addColorStop(.7, c.deep);
  g.addColorStop(1, 'rgba(0,0,0,.92)');
  ctx.save(); ctx.globalAlpha = alpha; ctx.shadowColor = c.glow; ctx.shadowBlur = 24; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r,0,TAU); ctx.fill();
  ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.78)'; ctx.beginPath(); ctx.ellipse(x-r*.35,y-r*.42,r*.22,r*.13,-.55,0,TAU); ctx.fill(); ctx.restore();
}
function drawCharacter(x,y) {
  const p = project(x,y,0); const r = 15;
  ctx.save(); ctx.translate(p.x,p.y); ctx.shadowColor = 'rgba(73,170,255,.55)'; ctx.shadowBlur = 24;
  const body = ctx.createLinearGradient(0,-36,0,18); body.addColorStop(0,'#f7fbff'); body.addColorStop(.28,'#67c7ff'); body.addColorStop(1,'#1d4fb7');
  ctx.fillStyle = 'rgba(0,0,0,.34)'; ctx.beginPath(); ctx.ellipse(0,22,24,9,0,0,TAU); ctx.fill();
  ctx.fillStyle = body; ctx.beginPath(); ctx.roundRect(-13,-22,26,42,12); ctx.fill(); ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.lineWidth=2; ctx.stroke();
  const head = ctx.createRadialGradient(-5,-38,2,0,-32,19); head.addColorStop(0,'#fff'); head.addColorStop(.25,'#ffe0b8'); head.addColorStop(1,'#b36b48'); ctx.fillStyle=head; ctx.beginPath(); ctx.arc(0,-35,17,0,TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#172033'; ctx.beginPath(); ctx.ellipse(0,-45,18,10,0,Math.PI,TAU); ctx.fill();
  ctx.fillStyle = '#ffe05d'; ctx.beginPath(); ctx.moveTo(0,-67); ctx.lineTo(7,-52); ctx.lineTo(-7,-52); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function draw() {
  const rect = canvas.getBoundingClientRect(); const w=rect.width, h=rect.height; state.center = {x:w*.48, y:h*.53}; state.arenaR = Math.min(w*.35, h*.42); state.innerR = state.arenaR*.23;
  ctx.clearRect(0,0,w,h);
  // background
  const bg = ctx.createRadialGradient(state.center.x,state.center.y,20,state.center.x,state.center.y,state.arenaR*1.35);
  bg.addColorStop(0,'#211722'); bg.addColorStop(.62,'#09090d'); bg.addColorStop(1,'#020203'); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
  ctx.save(); ctx.translate(state.center.x,state.center.y); ctx.scale(1, lerp(.28,.78,state.tilt));
  // arena floor
  const floor = ctx.createRadialGradient(0,0,state.innerR,0,0,state.arenaR); floor.addColorStop(0,'#2d2530'); floor.addColorStop(.72,'#171921'); floor.addColorStop(1,'#0c0d12');
  ctx.fillStyle=floor; ctx.beginPath(); ctx.arc(0,0,state.arenaR,0,TAU); ctx.fill(); ctx.strokeStyle='rgba(150,160,185,.35)'; ctx.lineWidth=4; ctx.stroke();
  for (let i=0;i<12;i++){ const a=hourAngle(i+1); ctx.strokeStyle = i%3===0?'rgba(90,145,255,.26)':'rgba(255,255,255,.07)'; ctx.lineWidth=i%3===0?3:1; ctx.beginPath(); ctx.moveTo(Math.cos(a)*state.innerR,Math.sin(a)*state.innerR); ctx.lineTo(Math.cos(a)*state.arenaR,Math.sin(a)*state.arenaR); ctx.stroke(); }
  // target lanes
  if (state.assignment) for (const hour of state.assignment.hours) { const a=hourAngle(hour); ctx.strokeStyle='rgba(255,224,93,.7)'; ctx.lineWidth=10; ctx.beginPath(); ctx.moveTo(Math.cos(a)*state.innerR,Math.sin(a)*state.innerR); ctx.lineTo(Math.cos(a)*state.arenaR,Math.sin(a)*state.arenaR); ctx.stroke(); }
  // beams
  for (const b of state.beams) { const a=hourAngle(b.hour); const live=b.t>b.charge; ctx.strokeStyle = live?'rgba(255,55,70,.85)':'rgba(255,224,93,.35)'; ctx.lineWidth = live?18:7; ctx.beginPath(); ctx.moveTo(Math.cos(a)*state.innerR,Math.sin(a)*state.innerR); ctx.lineTo(Math.cos(a)*state.arenaR,Math.sin(a)*state.arenaR); ctx.stroke(); }
  ctx.restore();
  // boss rings projected as circles-ish
  const c = state.center; ['#ff4053','#00d2eb','#3ee57d'].forEach((col,i)=>{ ctx.strokeStyle=col; ctx.lineWidth=5-i; ctx.beginPath(); ctx.ellipse(c.x,c.y,state.innerR*(1.18+i*.12),state.innerR*(1.18+i*.12)*lerp(.28,.78,state.tilt),0,0,TAU); ctx.stroke(); });
  ctx.fillStyle='#0e1017'; ctx.beginPath(); ctx.ellipse(c.x,c.y,state.innerR*.95,state.innerR*.95*lerp(.28,.78,state.tilt),0,0,TAU); ctx.fill(); ctx.strokeStyle='rgba(255,255,255,.7)'; ctx.stroke(); ctx.fillStyle='#fff'; ctx.font='700 20px system-ui'; ctx.textAlign='center'; ctx.fillText('칼드릭스',c.x,c.y+7);
  // orbs sorted by y
  const drawable = state.orbs.filter(o=>o.dist>state.innerR-6 && o.dist<state.arenaR+250).map(o=>({o, p:project(Math.cos(o.angle)*o.dist, Math.sin(o.angle)*o.dist, 18)})).sort((a,b)=>a.p.y-b.p.y);
  for (const {o,p} of drawable) { const r = clamp(12 + (state.arenaR+120-o.dist)*.018, 10, 24) + Math.sin(o.pulse)*1.4; sphere(ctx,p.x,p.y,r,o.color,o.required?1:.72); if (o.required && ui.guide.checked) { ctx.strokeStyle=COLOR[state.targetColors.get(o.hour)]?.glow || '#fff'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(p.x,p.y,r+6,0,TAU); ctx.stroke(); } }
  // particles/ripples
  for (const r of state.ripples) { const p=project(r.x,r.y,4); ctx.strokeStyle = r.col==='red'?'rgba(255,64,83,.7)':'rgba(255,255,255,.5)'; ctx.lineWidth=3; ctx.globalAlpha=1-r.t/.75; ctx.beginPath(); ctx.arc(p.x,p.y,20+r.t*75,0,TAU); ctx.stroke(); ctx.globalAlpha=1; }
  for (const pt of state.particles) { const p=project(pt.x,pt.y,12); ctx.fillStyle=COLOR[pt.color].base; ctx.globalAlpha=1-pt.t/pt.life; ctx.beginPath(); ctx.arc(p.x,p.y,3,0,TAU); ctx.fill(); ctx.globalAlpha=1; }
  drawCharacter(state.player.x,state.player.y);
  // hour labels and targets
  ctx.font='700 15px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
  for (let h=1; h<=12; h++) { const p=project(...Object.values(pointForHour(h,state.arenaR+28)),0); ctx.fillStyle='rgba(255,255,255,.72)'; ctx.fillText(`${h}시`,p.x,p.y); }
  if (ui.guide.checked && state.assignment) {
    for (const hour of state.assignment.hours) { const p=project(...Object.values(pointForHour(hour,state.arenaR+68)),0); const col=state.targetColors.get(hour); sphere(ctx,p.x,p.y,13,col); ctx.fillStyle='#fff'; ctx.font='800 14px system-ui'; ctx.fillText(`${hour}시 목표`,p.x,p.y+31); }
  }
  // HUD
  ctx.textAlign='left'; ctx.textBaseline='top'; ctx.font='800 18px system-ui'; ctx.fillStyle='rgba(255,255,255,.9)'; ctx.fillText(state.patternText, 24, 22);
  ctx.font='600 14px system-ui'; ctx.fillStyle='rgba(174,182,200,.95)'; ctx.fillText(`빨장 ${Math.min(state.blastNo,7)}/7 · 구슬 ${state.orbs.filter(o=>o.required).length}개 추적`, 24, 50);
}

function loop(now) { const dt = Math.min(.05,(now-last)/1000); last=now; update(dt); draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);

window.addEventListener('keydown', e => {
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Space' && state.mode !== 'play') start();
  if (e.code === 'KeyR') start();
  if (e.code === 'KeyP') pauseToggle();
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && state.mode === 'play' && state.player.dashCd <= 0) { state.player.dash=.18; state.player.dashCd=.72; state.player.invuln=.2; beep(980,.035,.025); }
});
window.addEventListener('keyup', e => keys.delete(e.code));
canvas.addEventListener('pointerdown', () => { if (state.mode !== 'play') start(); });
ui.pattern.addEventListener('change', () => { if (state.mode !== 'idle') start(); });
ui.difficulty.addEventListener('change', () => { if (state.mode !== 'idle') start(); });

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){ this.beginPath(); this.moveTo(x+r,y); this.arcTo(x+w,y,x+w,y+h,r); this.arcTo(x+w,y+h,x,y+h,r); this.arcTo(x,y+h,x,y,r); this.arcTo(x,y,x+w,y,r); this.closePath(); return this; };
}
