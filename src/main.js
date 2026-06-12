const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const ui = {
  status: $('statusPill'), help: $('overlayHelp'), success: $('successCount'), fail: $('failCount'), burn: $('burnCount'), dash: $('dashState'),
  pattern: $('patternMode'), difficulty: $('difficulty'), tilt: $('cameraTilt'), guide: $('showGuide'), sound: $('soundToggle')
};

const TAU = Math.PI * 2;
const COLORS = ['red', 'green', 'blue'];
const COLOR = {
  red: { ko: '빨강', base: '#ff4053', deep: '#801827', glow: 'rgba(255,64,83,.78)' },
  green: { ko: '초록', base: '#3ee57d', deep: '#08713c', glow: 'rgba(62,229,125,.76)' },
  blue: { ko: '파랑', base: '#4f91ff', deep: '#123a91', glow: 'rgba(79,145,255,.78)' }
};
const SLOT_BLASTS = [3, 5, 7];
const PLAN_BOTH = 2;
const keys = new Set();
let last = performance.now();
let audioCtx;

const state = {
  mode: 'idle', elapsed: 0, wave: 0, successes: 0, fails: 0, burn: 0,
  center: { x: 0, y: 0 }, arenaR: 320, innerR: 78, tilt: .58,
  assignment: null, lanes: [], targets: [], plan: [], blasts: [], feedback: [], laneFlash: new Map(),
  blastNo: 0, nextBlastAt: 0, patternText: '대기', resultChecked: false,
  player: { x: 0, y: 0, vx: 0, vy: 0, r: 15, dash: 0, dashCd: 0, invuln: 0 }
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mod = (n, m) => ((n % m) + m) % m;
const nextColor = (c) => COLORS[(COLORS.indexOf(c) + 1) % 3];
const prevColor = (target, hits) => COLORS[mod(COLORS.indexOf(target) - hits, 3)];
const randOf = (arr) => arr[Math.floor(Math.random() * arr.length)];
const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function hourAngle(hour) { return (hour / 12) * TAU - Math.PI / 2; }
function pointForHour(hour, r) { const a = hourAngle(hour); return { x: Math.cos(a) * r, y: Math.sin(a) * r }; }
function beep(freq = 540, dur = .06, gain = .035) {
  if (!ui.sound.checked) return;
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
  o.frequency.value = freq; o.type = 'sine'; g.gain.value = gain; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
}

function resize() {
  const rect = canvas.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(2, Math.floor(rect.width * dpr)); canvas.height = Math.max(2, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas); resize();

function difficulty() {
  return {
    easy: { blastGap: 3.0, beamLife: .42, beamWidth: .105, speed: 190 },
    normal: { blastGap: 2.45, beamLife: .32, beamWidth: .085, speed: 215 },
    hard: { blastGap: 2.05, beamLife: .25, beamWidth: .07, speed: 235 }
  }[ui.difficulty.value];
}
function chooseAssignment() {
  const requested = ui.pattern.value;
  const mode = requested === 'random' ? (Math.random() < .68 ? 'two' : 'one') : requested;
  if (mode === 'two') {
    const h = randOf([1, 4, 7, 10]);
    const h2 = h + 1 > 12 ? h - 11 : h + 1;
    return { mode, hours: [h, h2], label: `2줄 ${h}시·${h2}시` };
  }
  const h = randOf([3, 6, 9, 12]);
  return { mode, hours: [h], label: `1줄 ${h}시` };
}
function choicesForBlast(i, laneCount) {
  const choices = [-1, 0];
  if (laneCount > 1) choices.push(1);
  if (laneCount > 1 && SLOT_BLASTS.includes(i + 1)) choices.push(PLAN_BOTH);
  return choices;
}
function planHitsLane(plan, laneIndex) {
  return plan.reduce((n, mark) => n + (mark === laneIndex || mark === PLAN_BOTH ? 1 : 0), 0);
}
function randomPlan(laneCount) {
  // 7번 빨간 줄 중 담당 줄을 어떻게 맞출지 정합니다.
  // 원본처럼 3/5/7번째는 2줄 동시 타격 가능성을 열어둡니다.
  for (let tries = 0; tries < 200; tries++) {
    const plan = Array.from({ length: 7 }, (_, i) => randOf(choicesForBlast(i, laneCount)));
    if (laneCount === 1 && planHitsLane(plan, 0) >= 1 && planHitsLane(plan, 0) <= 6) return plan;
    if (laneCount === 2) {
      const a = planHitsLane(plan, 0), b = planHitsLane(plan, 1);
      if (a >= 1 && b >= 1 && a <= 6 && b <= 6 && plan.some(v => v === PLAN_BOTH)) return plan;
    }
  }
  return laneCount === 2 ? [0, 1, PLAN_BOTH, -1, PLAN_BOTH, 0, PLAN_BOTH] : [0, -1, 0, -1, 0, -1, 0];
}
function makeLanes(assignment, plan) {
  const targets = [randOf(COLORS), randOf(COLORS), randOf(COLORS)];
  state.targets = targets;
  return assignment.hours.map((hour, laneIndex) => {
    const hits = planHitsLane(plan, laneIndex) % 3;
    const orbs = targets.map((target, slot) => ({
      slot,
      target,
      color: prevColor(target, hits),
      pulse: Math.random() * TAU,
      hitFlash: 0
    }));
    return { hour, laneIndex, angle: hourAngle(hour), hits: 0, plannedHits: hits, orbs };
  });
}
function resetPlayer() {
  const p = pointForHour(6, state.arenaR - 32);
  Object.assign(state.player, { x: p.x, y: p.y, vx: 0, vy: 0, dash: 0, dashCd: 0, invuln: 0 });
}
function start() {
  state.mode = 'play'; state.elapsed = 0; state.wave++; state.assignment = chooseAssignment(); state.plan = randomPlan(state.assignment.hours.length);
  state.lanes = makeLanes(state.assignment, state.plan); state.blastNo = 0; state.nextBlastAt = 1.1; state.blasts = []; state.feedback = []; state.laneFlash.clear();
  state.patternText = `${state.assignment.label} · 목표 ${state.targets.map(c => COLOR[c].ko).join('→')}`; state.resultChecked = false; state.burn = 0; ui.burn.textContent = '0';
  resetPlayer(); ui.status.textContent = state.patternText; ui.help.style.display = 'none'; beep(620, .08, .045);
}
function pauseToggle() {
  if (state.mode === 'play') { state.mode = 'pause'; ui.status.textContent = '일시정지'; ui.help.innerHTML = '<b>일시정지</b><br>P로 재개'; ui.help.style.display = 'block'; }
  else if (state.mode === 'pause') { state.mode = 'play'; ui.status.textContent = state.patternText; ui.help.style.display = 'none'; }
}
function fail(reason = '실패') {
  state.fails++; ui.fail.textContent = state.fails; state.mode = 'result'; ui.status.textContent = reason;
  ui.help.innerHTML = `<b>${reason}</b><br>R 또는 Space로 다시 시작`; ui.help.style.display = 'block'; beep(180, .14, .05);
}
function success() {
  state.successes++; ui.success.textContent = state.successes; state.mode = 'result'; ui.status.textContent = '성공';
  ui.help.innerHTML = '<b>성공!</b><br>R 또는 Space로 다음 패턴'; ui.help.style.display = 'block'; beep(880, .08, .05); setTimeout(() => beep(1180, .08, .04), 90);
}
function addFeedback(text, x, y, color = 'rgba(255,238,210,.95)') { state.feedback.push({ text, x, y, color, t: 1.05, life: 1.05 }); }

function laneUnderLine(angle) {
  const threshold = difficulty().beamWidth;
  const hits = state.lanes.filter(l => angleDiff(angle, l.angle) < threshold).sort((a, b) => angleDiff(angle, a.angle) - angleDiff(angle, b.angle));
  if (hits.length > 1 && SLOT_BLASTS.includes(state.blastNo)) return hits.slice(0, 2);
  return hits.slice(0, 1);
}
function fireBlast() {
  state.blastNo++;
  const angle = Math.atan2(state.player.y, state.player.x);
  const lanes = laneUnderLine(angle);
  state.blasts.push({ angle, t: 0, life: difficulty().beamLife, lanes: lanes.map(l => l.hour) });
  if (!lanes.length) { addFeedback('줄 미적중', Math.cos(angle) * state.arenaR * .72, Math.sin(angle) * state.arenaR * .72, 'rgba(255,160,170,.95)'); beep(260, .035, .025); return; }

  for (const lane of lanes) {
    lane.hits++;
    state.laneFlash.set(lane.hour, .65);
    // 핵심 수정: 빨간 줄이 닿은 “줄”의 구슬 3개가 동시에 RGB 순서로 전환됩니다.
    for (const orb of lane.orbs) {
      orb.color = nextColor(orb.color);
      orb.hitFlash = .75;
    }
    const p = pointForHour(lane.hour, state.arenaR * .63);
    addFeedback(`${lane.hour}시 3구슬 동시 변경`, p.x, p.y);
  }
  beep(760, .035, .025);
}
function evaluate() {
  state.resultChecked = true;
  const wrong = [];
  for (const lane of state.lanes) {
    for (const orb of lane.orbs) if (orb.color !== orb.target) wrong.push({ lane, orb });
  }
  if (wrong.length) {
    const w = wrong[0];
    fail(`${w.lane.hour}시 ${w.orb.slot + 1}번 구슬 불일치`);
  } else success();
}
function update(dt) {
  if (state.mode !== 'play') return;
  state.elapsed += dt; state.tilt = Number(ui.tilt.value) / 100;
  const diff = difficulty();
  if (state.elapsed >= state.nextBlastAt && state.blastNo < 7) { fireBlast(); state.nextBlastAt += diff.blastGap; }
  if (state.blastNo >= 7 && !state.resultChecked && state.elapsed > state.nextBlastAt - diff.blastGap + .8) evaluate();

  const p = state.player;
  let ax = 0, ay = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) ay -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) ay += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1;
  const len = Math.hypot(ax, ay) || 1;
  const speed = diff.speed * (p.dash > 0 ? 2.75 : 1);
  p.x += (ax / len) * speed * dt; p.y += (ay / len) * speed * dt;
  const d = Math.hypot(p.x, p.y) || 1;
  const minR = state.innerR + 24, maxR = state.arenaR - 19;
  if (d < minR) { p.x = p.x / d * minR; p.y = p.y / d * minR; }
  if (d > maxR) { p.x = p.x / d * maxR; p.y = p.y / d * maxR; }
  p.dash = Math.max(0, p.dash - dt); p.dashCd = Math.max(0, p.dashCd - dt); p.invuln = Math.max(0, p.invuln - dt);
  ui.dash.textContent = p.dashCd <= 0 ? 'READY' : p.dashCd.toFixed(1);

  for (const b of state.blasts) b.t += dt;
  state.blasts = state.blasts.filter(b => b.t < b.life);
  for (const l of state.lanes) for (const o of l.orbs) { o.pulse += dt * 4; o.hitFlash = Math.max(0, o.hitFlash - dt); }
  for (const [h, t] of state.laneFlash) { const n = t - dt; n <= 0 ? state.laneFlash.delete(h) : state.laneFlash.set(h, n); }
  state.feedback = state.feedback.map(f => ({ ...f, t: f.t - dt, y: f.y - 16 * dt })).filter(f => f.t > 0);

  for (const b of state.blasts) {
    if (b.t < b.life * .65 && p.invuln <= 0 && angleDiff(Math.atan2(p.y, p.x), b.angle) < .035) {
      state.burn++; ui.burn.textContent = state.burn; p.invuln = .55; addFeedback(`화상 ${state.burn}`, p.x, p.y, 'rgba(255,190,100,.95)'); beep(220, .04, .035);
      if (state.burn >= 4) fail('화상 누적');
    }
  }
}

function project(x, y, z = 0) { const tilt = lerp(.34, .82, state.tilt); return { x: state.center.x + x, y: state.center.y + y * tilt - z }; }
function sphere(x, y, r, key, alpha = 1) {
  const c = COLOR[key];
  const g = ctx.createRadialGradient(x - r * .35, y - r * .42, r * .08, x, y, r * 1.22);
  g.addColorStop(0, `rgba(255,255,255,${.96 * alpha})`); g.addColorStop(.18, c.base); g.addColorStop(.72, c.deep); g.addColorStop(1, 'rgba(0,0,0,.94)');
  ctx.save(); ctx.globalAlpha = alpha; ctx.shadowColor = c.glow; ctx.shadowBlur = 24; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,255,255,.58)'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.beginPath(); ctx.ellipse(x - r * .35, y - r * .42, r * .22, r * .13, -.55, 0, TAU); ctx.fill(); ctx.restore();
}
function drawCharacter(x, y) {
  const p = project(x, y, 0);
  ctx.save(); ctx.translate(p.x, p.y); ctx.shadowColor = 'rgba(73,170,255,.55)'; ctx.shadowBlur = 24;
  ctx.fillStyle = 'rgba(0,0,0,.34)'; ctx.beginPath(); ctx.ellipse(0, 22, 24, 9, 0, 0, TAU); ctx.fill();
  const body = ctx.createLinearGradient(0, -36, 0, 18); body.addColorStop(0, '#f7fbff'); body.addColorStop(.28, '#67c7ff'); body.addColorStop(1, '#1d4fb7');
  ctx.fillStyle = body; ctx.beginPath(); ctx.roundRect(-13, -22, 26, 42, 12); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 2; ctx.stroke();
  const head = ctx.createRadialGradient(-5, -38, 2, 0, -32, 19); head.addColorStop(0, '#fff'); head.addColorStop(.25, '#ffe0b8'); head.addColorStop(1, '#b36b48'); ctx.fillStyle = head; ctx.beginPath(); ctx.arc(0, -35, 17, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#172033'; ctx.beginPath(); ctx.ellipse(0, -45, 18, 10, 0, Math.PI, TAU); ctx.fill(); ctx.fillStyle = '#ffe05d'; ctx.beginPath(); ctx.moveTo(0, -67); ctx.lineTo(7, -52); ctx.lineTo(-7, -52); ctx.closePath(); ctx.fill(); ctx.restore();
}
function draw() {
  const rect = canvas.getBoundingClientRect(); const w = rect.width, h = rect.height;
  state.center = { x: w * .47, y: h * .54 }; state.arenaR = Math.min(w * .35, h * .42); state.innerR = state.arenaR * .23;
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createRadialGradient(state.center.x, state.center.y, 20, state.center.x, state.center.y, state.arenaR * 1.42);
  bg.addColorStop(0, '#211722'); bg.addColorStop(.62, '#09090d'); bg.addColorStop(1, '#020203'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

  const tilt = lerp(.34, .82, state.tilt);
  ctx.save(); ctx.translate(state.center.x, state.center.y); ctx.scale(1, tilt);
  const floor = ctx.createRadialGradient(0, 0, state.innerR, 0, 0, state.arenaR); floor.addColorStop(0, '#2d2530'); floor.addColorStop(.72, '#171921'); floor.addColorStop(1, '#0c0d12');
  ctx.fillStyle = floor; ctx.beginPath(); ctx.arc(0, 0, state.arenaR, 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(150,160,185,.35)'; ctx.lineWidth = 4; ctx.stroke();
  for (let i = 1; i <= 12; i++) { const a = hourAngle(i); ctx.strokeStyle = i % 3 === 0 ? 'rgba(90,145,255,.26)' : 'rgba(255,255,255,.07)'; ctx.lineWidth = i % 3 === 0 ? 3 : 1; ctx.beginPath(); ctx.moveTo(Math.cos(a) * state.innerR, Math.sin(a) * state.innerR); ctx.lineTo(Math.cos(a) * state.arenaR, Math.sin(a) * state.arenaR); ctx.stroke(); }
  for (const lane of state.lanes) { const a = lane.angle; ctx.strokeStyle = state.laneFlash.has(lane.hour) ? 'rgba(255,224,93,.92)' : 'rgba(255,224,93,.45)'; ctx.lineWidth = state.laneFlash.has(lane.hour) ? 13 : 8; ctx.beginPath(); ctx.moveTo(Math.cos(a) * state.innerR, Math.sin(a) * state.innerR); ctx.lineTo(Math.cos(a) * state.arenaR, Math.sin(a) * state.arenaR); ctx.stroke(); }
  for (const b of state.blasts) { ctx.strokeStyle = `rgba(255,55,70,${1 - b.t / b.life})`; ctx.lineWidth = 18; ctx.beginPath(); ctx.moveTo(Math.cos(b.angle) * state.innerR, Math.sin(b.angle) * state.innerR); ctx.lineTo(Math.cos(b.angle) * state.arenaR, Math.sin(b.angle) * state.arenaR); ctx.stroke(); }
  ctx.restore();

  ['#ff4053', '#00d2eb', '#3ee57d'].forEach((col, i) => { ctx.strokeStyle = col; ctx.lineWidth = 5 - i; ctx.beginPath(); ctx.ellipse(state.center.x, state.center.y, state.innerR * (1.18 + i * .12), state.innerR * (1.18 + i * .12) * tilt, 0, 0, TAU); ctx.stroke(); });
  ctx.fillStyle = '#0e1017'; ctx.beginPath(); ctx.ellipse(state.center.x, state.center.y, state.innerR * .95, state.innerR * .95 * tilt, 0, 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = '700 20px system-ui'; ctx.textAlign = 'center'; ctx.fillText('칼드릭스', state.center.x, state.center.y + 7);

  // 목표 구슬 3개 표시
  if (ui.guide.checked && state.targets.length) {
    ctx.font = '800 13px system-ui'; ctx.textAlign = 'center';
    state.targets.forEach((c, i) => { const x = 34 + i * 54, y = 94; sphere(x, y, 17, c); ctx.fillStyle = '#fff'; ctx.fillText(`${i + 1}`, x, y + 32); });
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText('목표 3구슬', 88, 50);
  }

  const sprites = [];
  for (const lane of state.lanes) {
    lane.orbs.forEach((orb, i) => {
      const radius = state.innerR + state.arenaR * (.28 + i * .145);
      const p = project(Math.cos(lane.angle) * radius, Math.sin(lane.angle) * radius, 20);
      sprites.push({ y: p.y, draw: () => {
        const r = 19 + Math.sin(orb.pulse) * 1.2 + orb.hitFlash * 8;
        sphere(p.x, p.y, r, orb.color);
        ctx.strokeStyle = orb.color === orb.target ? 'rgba(255,255,255,.94)' : COLOR[orb.target].glow;
        ctx.lineWidth = orb.color === orb.target ? 2.2 : 4;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 7, 0, TAU); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '900 13px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`${i + 1}`, p.x, p.y + 4);
      }});
    });
  }
  sprites.sort((a, b) => a.y - b.y).forEach(s => s.draw());
  drawCharacter(state.player.x, state.player.y);

  ctx.font = '700 15px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let hour = 1; hour <= 12; hour++) { const p = project(...Object.values(pointForHour(hour, state.arenaR + 28)), 0); ctx.fillStyle = 'rgba(255,255,255,.72)'; ctx.fillText(`${hour}시`, p.x, p.y); }
  for (const lane of state.lanes) { const p = project(...Object.values(pointForHour(lane.hour, state.arenaR + 66)), 0); ctx.fillStyle = '#ffe05d'; ctx.font = '900 15px system-ui'; ctx.fillText(`${lane.hour}시 · ${lane.hits}회`, p.x, p.y); }

  for (const fb of state.feedback) { const p = project(fb.x, fb.y, 35); ctx.globalAlpha = clamp(fb.t / fb.life, 0, 1); ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.beginPath(); ctx.roundRect(p.x - 92, p.y - 20, 184, 34, 12); ctx.fill(); ctx.fillStyle = fb.color; ctx.font = '900 13px system-ui'; ctx.textAlign = 'center'; ctx.fillText(fb.text, p.x, p.y + 2); ctx.globalAlpha = 1; }

  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '800 18px system-ui'; ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(state.patternText, 24, 22);
  ctx.font = '600 14px system-ui'; ctx.fillStyle = 'rgba(174,182,200,.95)'; ctx.fillText(`빨장 ${Math.min(state.blastNo, 7)}/7 · 룰: 줄에 닿으면 그 줄 3구슬 동시 RGB 전환`, 24, 52);
}
function loop(now) { const dt = Math.min(.05, (now - last) / 1000); last = now; update(dt); draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);

window.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Space' && state.mode !== 'play') start();
  if (e.code === 'KeyR') start();
  if (e.code === 'KeyP') pauseToggle();
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && state.mode === 'play' && state.player.dashCd <= 0) { state.player.dash = .18; state.player.dashCd = .72; state.player.invuln = .2; beep(980, .035, .025); }
});
window.addEventListener('keyup', e => keys.delete(e.code));
canvas.addEventListener('pointerdown', () => { if (state.mode !== 'play') start(); });
ui.pattern.addEventListener('change', () => { if (state.mode !== 'idle') start(); });
ui.difficulty.addEventListener('change', () => { if (state.mode !== 'idle') start(); });

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) { this.beginPath(); this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r); this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath(); return this; };
}
