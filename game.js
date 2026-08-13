/* ============================================================
 * 大风起兮 — 吹气小游戏原型（零依赖）
 *
 * 玩法：对手机麦克风吹气 → 风力 → 把东西吹上天
 *  第1关「晨风村」：吹飞树叶 / 草帽 / 雨伞
 *  第2关「守树人」：吹飞抱着树的人（抓力耗尽才会脱手）
 *
 * 吹气识别原理：
 *  - 音量(RMS) 归一化 → 风力
 *  - 高频能量占比过滤：吹气是宽带噪声(高频多)，说话低频占比高 → 抑制误触发
 *  - 首次进入自动校准（安静→用力吹），不同手机灵敏度差异大
 *
 * 调试：
 *  - 页面 URL 加 ?autowind=1 自动循环风力（自动化测试用）
 *  - 按住屏幕 / 空格 = 吹气（演示模式）
 *  - 右上角 🐛 或按 D 键开调试面板
 * ============================================================ */
'use strict';

/* ==================== 调参区（手感都在这） ==================== */
const TUNE = {
  GRAVITY: 300,             // 重力加速度 px/s²
  WIND_ACC: 1200,           // 基础风加速度（乘以 面积/质量）
  GATE_MIN: 0.02,           // 风力下限：低于此值视为无风
  SPEECH_LO: 0.35,          // 差分RMS/原始RMS 低于此值 → 判定为说话，开始抑制
  SPEECH_HI: 0.75,          // 高于此值 → 判定为吹气（宽带噪声），不抑制
  GAMMA: 0.85,              // 低风区增益曲线（<1 小吹也有反馈）
  ATTACK: 12,               // 风力上升平滑速率 1/s（吹气反应快）
  RELEASE: 4,               // 风力回落平滑速率 1/s（停吹后缓慢平息）
  LIFT_RATIO: 0.6,          // 起飞阈值：风力加速度 > 重力×此值 才离地
  HOLD_MIN: 0.50,           // 超过此风力开始消耗抓力
  HOLD_RELAX: 0.35,         // 低于此风力抓力恢复
  HOLD_DRAIN: 0.8,          // 抓力消耗速度 1/s（风力=1 时约 2.5 秒脱手）
  HOLD_RECOVER: 0.3,        // 抓力恢复速度 1/s
  PERSON_IMPULSE: [320, 480], // 脱手初速度 [基础, 随风力加成]
  CAL_QUIET: 1.2,           // 校准：安静采样秒数
  CAL_BLOW: 1.6,            // 校准：用力吹气采样秒数
};

/* ==================== 小工具 ==================== */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const $ = sel => document.querySelector(sel[0] === '#' ? sel : '#' + sel); // 统一按 id 处理，'#' 可带可不带
const now = () => performance.now();
// 帧率无关的指数平滑：向 target 靠近，上升用 attack 速率，下降用 release
function smooth(cur, target, dt, attack, release) {
  const rate = target > cur ? attack : release;
  const k = 1 - Math.exp(-rate * dt);
  return cur + (target - cur) * k;
}

/* ==================== 音效（程序合成，无素材） ==================== */
const audioCtx = {
  ctx: null,
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
};
const sfx = {
  windGain: null,
  init() {
    if (this.windGain) return;
    const ctx = audioCtx.ensure();
    // 风声：循环白噪声 → 低通滤波 → 音量随风力
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 650;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(lp).connect(this.windGain).connect(ctx.destination);
    noise.start();
  },
  wind(w) {
    if (this.windGain) this.windGain.gain.linearRampToValueAtTime(w * 0.16, audioCtx.ctx.currentTime + 0.08);
  },
  pop(freq = 700, vol = 0.25) {
    if (!audioCtx.ctx) return;
    const ctx = audioCtx.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.22, t + 0.15);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.22);
  },
  bigPop() {
    this.pop(520, 0.32);
    this.pop(700, 0.22); // 双重音
  },
  jingle() {
    if (!audioCtx.ctx) return;
    const ctx = audioCtx.ctx, t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.12 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.32);
    });
  },
};

/* ==================== 吹气输入 ==================== */
const input = {
  mode: 'off',        // 'off' | 'mic' | 'demo'
  analyser: null, buf: null, freq: null, hfBin: 0,
  rms: 0,             // 原始音量 RMS
  hf: 0,              // 一阶差分 RMS（高频强调，吹气特征）
  hfRatio: 0,         // 频谱高频占比（调试用）
  level: 0,           // 综合电平（rms 与 hf 取大，校准与风力共用）
  raw: 0,             // 归一化风力（未平滑）
  wind: 0,            // 平滑后的风力（游戏用）
  calFloor: 0.018,    // 校准：环境底噪
  calPeak: 0.40,      // 校准：吹气峰值
  demoHeld: false,
  fake: false,        // 合成麦克风（fakemic 测试模式）
  fakeT: 0,

  async initMic() {
    // 测试模式：不碰真实麦克风，合成白噪声信号
    if (FAKEMIC) {
      this.fake = true;
      this.mode = 'mic';
      toast('🎤 测试用合成麦克风已开启');
      return;
    }
    // 关掉降噪/回声消除/自动增益 —— 吹气检测需要原始电平
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = audioCtx.ensure();
    const src = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.hfBin = Math.floor(1200 / (ctx.sampleRate / this.analyser.fftSize));
    this.mode = 'mic';
    toast('🎤 麦克风已开启，对着手机底部吹气试试');
  },

  setDemo() {
    this.mode = 'demo';
    this.demoHeld = false;
  },

  update(dt) {
    if (this.mode === 'mic') this.sampleMic(dt);
    else if (this.mode === 'demo') {
      const target = this.demoHeld ? 1 : 0;
      this.wind = smooth(this.wind, target, dt, TUNE.ATTACK, TUNE.RELEASE);
      this.raw = this.wind;
      this.level = this.wind * this.calPeak;
      this.rms = this.level;
      this.hf = this.level;
      this.hfRatio = 0.8;
    }
  },

  sampleMic(dt) {
    let rms, hf;
    if (this.fake) {
      // 合成信号：先安静 1.5s（覆盖安静校准期），之后 5 秒循环（吹 3 秒 / 停 2 秒），白噪声特征 dR≈1.41
      this.fakeT += dt;
      let amp;
      if (this.fakeT < 1.5) amp = 0.015;
      else { const ph = (this.fakeT - 1.5) % 5; amp = ph < 3 ? 0.32 : 0.015; }
      rms = amp;
      hf = amp * 1.41;
      this.hfRatio = 0.8;
    } else {
      // 时域分析
      this.analyser.getByteTimeDomainData(this.buf);
      const n = this.buf.length;
      let sum = 0, dsum = 0;
      let prev = (this.buf[0] - 128) / 128;
      for (let i = 0; i < n; i++) {
        const s = (this.buf[i] - 128) / 128;
        sum += s * s;
        const d = s - prev;
        dsum += d * d;
        prev = s;
      }
      rms = Math.sqrt(sum / n);
      hf = Math.sqrt(dsum / n); // 差分 RMS：白噪声≈rms×1.41，低频主导的信号≈rms×0.5
      // 频谱高频占比（只作调试参考）
      this.analyser.getByteFrequencyData(this.freq);
      let tot = 0, hi = 0;
      for (let i = 0; i < this.freq.length; i++) {
        const v = this.freq[i];
        tot += v;
        if (i >= this.hfBin) hi += v;
      }
      this.hfRatio = tot > 0 ? hi / tot : 0;
    }
    this.rms = rms;
    this.hf = hf;
    // 综合电平：原始与差分取大，手机麦克风的低频风声和高频噪声都能抓到
    this.level = Math.max(rms, hf * 0.7);
    // 归一化
    let raw = (this.level - this.calFloor) / Math.max(0.04, this.calPeak - this.calFloor);
    raw = clamp(raw, 0, 1);
    if (raw < TUNE.GATE_MIN) raw = 0;
    // 说话抑制：说话以低频谐波为主（差分RMS远低于原始RMS），吹气两者接近
    const dRatio = hf / Math.max(rms, 1e-6);
    const sp = clamp((dRatio - TUNE.SPEECH_LO) / (TUNE.SPEECH_HI - TUNE.SPEECH_LO), 0.3, 1);
    raw *= sp;
    // 低风区增益：小吹气也有可感知反馈
    raw = Math.pow(raw, TUNE.GAMMA);
    this.raw = raw;
    this.wind = smooth(this.wind, raw, dt, TUNE.ATTACK, TUNE.RELEASE);
  },

  // 校准：安静采样 → 用力吹采样。onUI({text, progress, level}) 驱动校准界面
  async calibrate(onUI) {
    onUI({ text: '保持安静…', progress: 0, level: 0 });
    const quiet = await this._collect(TUNE.CAL_QUIET, onUI);
    this.calFloor = Math.max(0.008, quiet.p90 * 1.15 + 0.004);
    onUI({ text: '现在用力对麦克风吹气！', progress: 0.5, level: 0 });
    const blow = await this._collect(TUNE.CAL_BLOW, onUI);
    // 安静期若误采到吹气声，底噪会被拉高 → 退回用中位数估计
    if (this.calFloor > blow.p90 * 0.5) {
      this.calFloor = Math.max(0.008, quiet.median * 1.15 + 0.004);
    }
    // p95 抗偶发爆音；×1.3 留余量；下限保证弱吹气也有灵敏度
    this.calPeak = Math.max(0.06, Math.min(blow.p95 * 1.3, blow.max));
    const ok = blow.p90 > quiet.p95 + 0.008;
    onUI({
      text: ok ? '校准完成！开始游戏！' : '没检测到吹气，先用默认灵敏度开始吧',
      progress: 1, level: 0,
    });
    return ok;
  },

  // 连续采样 seconds 秒，返回统计
  _collect(seconds, onUI) {
    return new Promise(resolve => {
      const arr = [];
      const t0 = now();
      const tick = () => {
        if (this.mode !== 'mic') { resolve({ min: 0, max: 0.3, p90: 0.01, p95: 0.01, median: 0.005 }); return; }
        this.sampleMic(1 / 60);
        arr.push(this.level);
        if (onUI) onUI({ progress: (now() - t0) / (seconds * 1000), level: this.level });
        if (now() - t0 < seconds * 1000) requestAnimationFrame(tick);
        else {
          arr.sort((a, b) => a - b);
          resolve({
            min: arr[0], max: arr[arr.length - 1],
            p90: arr[Math.floor(arr.length * 0.9)],
            p95: arr[Math.floor(arr.length * 0.95)],
            median: arr[Math.floor(arr.length / 2)],
          });
        }
      };
      tick();
    });
  },
};

/* ==================== 粒子特效 ==================== */
const parts = { streaks: [], leaves: [], bursts: [], dust: [], streakAcc: 0, dustAcc: 0 };

function updateParticles(dt, wind) {
  const { W, H, groundY } = world;
  // 风线（风力越大越多越快）
  parts.streakAcc += wind * 26 * dt;
  while (parts.streakAcc >= 1) {
    parts.streakAcc -= 1;
    parts.streaks.push({
      x: rand(0, W), y: rand(H * 0.2, H + 10),
      len: rand(16, 44), spd: rand(240, 320) + wind * 420,
      a: 0.12 + wind * 0.3,
    });
  }
  for (const s of parts.streaks) { s.y -= s.spd * dt; s.a -= 0.9 * dt; }
  parts.streaks = parts.streaks.filter(s => s.y > -20 && s.a > 0.02);
  // 环境落叶
  if (parts.leaves.length < 9 && Math.random() < dt * 3) {
    parts.leaves.push({
      x: rand(0, W), y: H + 10, vy: rand(20, 45) + wind * 120, vx: rand(-12, 12),
      r: rand(2.5, 5), rot: rand(0, 6.28), vrot: rand(-2, 2),
      hue: ['#8bc34a', '#ffd166', '#ff9f43', '#c9a227', '#7ec850'][Math.floor(Math.random() * 5)],
    });
  }
  for (const l of parts.leaves) {
    l.y -= l.vy * dt;
    l.x += l.vx * dt + Math.sin(now() / 180 + l.rot) * 16 * dt;
    l.rot += l.vrot * dt;
  }
  parts.leaves = parts.leaves.filter(l => l.y > -20 && l.x > -30 && l.x < W + 30);
  // 大风时地面扬尘
  if (wind > 0.45) {
    parts.dustAcc += (wind - 0.45) * 18 * dt;
    while (parts.dustAcc >= 1) {
      parts.dustAcc -= 1;
      parts.dust.push({ x: rand(0, W), y: groundY + rand(0, 6), vy: rand(30, 70), vx: rand(-8, 8), r: rand(2, 5), a: 0.5 });
    }
  }
  for (const d of parts.dust) { d.y -= d.vy * dt; d.x += d.vx * dt; d.a -= 1.2 * dt; }
  parts.dust = parts.dust.filter(d => d.a > 0.02 && d.y > -10);
  // 吹飞爆发
  for (const b of parts.bursts) { b.t += dt; b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 300 * dt; }
  parts.bursts = parts.bursts.filter(b => b.t < 0.7);
}

function burst(x, y, color, n = 10) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), s = rand(60, 220);
    parts.bursts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, color });
  }
}

function drawParticles(ctx) {
  // 风线
  ctx.lineCap = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = '#fff';
  for (const s of parts.streaks) {
    ctx.globalAlpha = s.a;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y + s.len); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // 落叶
  for (const l of parts.leaves) {
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.rot);
    ctx.fillStyle = l.hue;
    ctx.beginPath(); ctx.ellipse(0, 0, l.r, l.r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 扬尘
  ctx.fillStyle = '#d7ccc8';
  for (const d of parts.dust) {
    ctx.globalAlpha = d.a;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 爆发
  for (const b of parts.bursts) {
    ctx.globalAlpha = 1 - b.t / 0.7;
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ==================== 物体 ==================== */
const OBJ_TYPES = {
  leaf:      { mass: 0.8, area: 0.9,  h: 14, color: '#7ec850' },
  hat:       { mass: 2.4, area: 1.5,  h: 20, color: '#e6c56b' },
  umbrella:  { mass: 3.2, area: 2.6,  h: 34, color: '#e74c3c' },
  sunhat:    { mass: 2.0, area: 1.6,  h: 18, color: '#f1c40f' },
  parasol:   { mass: 3.0, area: 3.0,  h: 36, color: '#e74c3c' },
  beachball: { mass: 1.5, area: 1.6,  h: 26, color: '#f1c40f' },
  person:    { mass: 10,  area: 3.0,  h: 58, color: '#e74c3c' },
};

class Obj {
  constructor(type, x, groundY) {
    const t = OBJ_TYPES[type];
    this.type = type; this.mass = t.mass; this.area = t.area; this.color = t.color;
    this.x = x; this.y = groundY - t.h / 2;
    this.vx = 0; this.vy = 0; this.rot = 0; this.rotV = 0;
    this.state = 'ground'; // ground | flying | gone
    this.gone = false;
    this.phase = Math.random() * Math.PI * 2;
  }
  liftAccel(wind) { return TUNE.WIND_ACC * this.area / this.mass * wind; }
  update(dt, wind) {
    const { H, groundY } = world;
    if (this.state === 'gone') return;
    if (this.state === 'ground') {
      this.y = groundY - OBJ_TYPES[this.type].h / 2; // 贴地
      this.rot = Math.sin(now() / 400 + this.phase) * 0.04 * wind;
      // 风力加速度超过起飞阈值 → 起飞
      if (this.liftAccel(wind) > TUNE.GRAVITY * TUNE.LIFT_RATIO) {
        this.state = 'flying';
        this.vy = -this.liftAccel(wind) * 0.6;
        this.rotV = rand(-1.5, 1.5);
      }
      return;
    }
    // flying：净加速度 = 重力 - 风力
    this.vy += (TUNE.GRAVITY - this.liftAccel(wind)) * dt;
    this.rotV += (Math.random() - 0.5) * 3 * dt;
    this.rot += this.rotV * dt;
    this.rotV *= (1 - 1.5 * dt);
    this.vx *= (1 - 1.2 * dt);
    this.x += this.vx * dt + Math.sin(now() / 300 + this.phase) * 20 * dt * (0.4 + wind);
    this.y += this.vy * dt;
    if (this.y < -80 || this.x < -80 || this.x > world.W + 80) {
      this.state = 'gone'; this.gone = true;
      burst(this.x, this.y, this.color);
      sfx.pop();
    }
  }
}

class Person extends Obj {
  constructor(x, groundY, look) {
    super('person', x, groundY);
    this.look = look || 'man';
    this.grip = 1;          // 抓力 0~1
    this.released = 0;      // 脱手次数（掉回来会重新抱住）
    this.shake = 0;
    this.sweat = false;
    this.state = 'grip';    // grip | free | gone
    // 抱姿几何：不同形象/固定物站位略有差异
    this.hugDX = this.look === 'woman' ? -10 : -14; // 相对固定物的横向偏移
    this.hugY = this.look === 'woman' ? 30 : 24;    // 脚底到重心的距离
    this.barY = this.look === 'woman' ? 58 : 66;    // 抓力条离重心的距离
    this.pronoun = this.look === 'woman' ? '她' : '他';
  }
  update(dt, wind, onRegrip) {
    const { groundY, anchor } = world;
    if (this.state === 'gone' || !anchor) return;
    if (this.state === 'grip') {
      // 站在固定物左侧，双手抱住
      this.x = anchor.x + this.hugDX + Math.sin(now() / 70 + this.phase) * this.shake * 5;
      this.y = groundY - this.hugY;
      this.rot = Math.sin(now() / 70 + this.phase) * 0.08 * this.shake;
      if (wind > TUNE.HOLD_MIN) this.grip -= (wind - TUNE.HOLD_MIN) * TUNE.HOLD_DRAIN * dt;
      else if (wind < TUNE.HOLD_RELAX) this.grip = Math.min(1, this.grip + TUNE.HOLD_RECOVER * dt);
      this.shake = clamp((wind - 0.4) * 2.2, 0, 1);
      this.sweat = wind > 0.62;
      if (this.grip <= 0) {
        this.grip = 0;
        this.state = 'free';
        this.released++;
        this.vy = -(TUNE.PERSON_IMPULSE[0] + wind * TUNE.PERSON_IMPULSE[1]);
        this.rotV = (Math.random() < 0.5 ? -1 : 1) * rand(2.5, 4.5);
        this.vx = rand(-30, 30);
        sfx.bigPop();
        toast(`💨 ${this.pronoun}脱手了！`);
      }
    } else if (this.state === 'free') {
      this.vy += (TUNE.GRAVITY - this.liftAccel(wind)) * dt;
      this.rot += this.rotV * dt;
      this.rotV *= (1 - 1.3 * dt);
      this.vx *= (1 - 0.8 * dt);
      this.x += this.vx * dt + Math.sin(now() / 200) * 10 * dt * (0.3 + wind);
      this.y += this.vy * dt;
      // 掉回地面 → 又抱住固定物（原谅型设计）
      if (this.vy > 0 && this.y >= groundY - this.hugY) {
        this.y = groundY - this.hugY; this.vy = 0; this.rotV = 0; this.rot = 0;
        this.state = 'grip'; this.grip = 1;
        if (onRegrip) onRegrip(this);
      }
      if (this.y < -90) {
        this.state = 'gone'; this.gone = true;
        burst(this.x, this.y, this.color, 16);
      }
    }
  }
}

/* ==================== 物体绘制 ==================== */
function drawLeaf(ctx, o) {
  ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
  ctx.fillStyle = '#7ec850';
  ctx.beginPath(); ctx.ellipse(0, 0, 10, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#5a9a38'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.stroke();
  ctx.restore();
}
function drawHat(ctx, o) {
  ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
  ctx.fillStyle = '#e6c56b';
  ctx.beginPath(); ctx.ellipse(0, 5, 16, 5, 0, 0, Math.PI * 2); ctx.fill(); // 帽檐
  ctx.beginPath();
  ctx.moveTo(-10, 4); ctx.quadraticCurveTo(0, -14, 10, 4); ctx.closePath(); ctx.fill(); // 帽顶
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(-10, 2, 20, 3); // 帽带
  ctx.restore();
}
function drawUmbrella(ctx, o) {
  ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
  ctx.strokeStyle = '#7f8c8d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -2); ctx.lineTo(0, 14); ctx.stroke(); // 伞柄
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath(); ctx.arc(0, -2, 16, Math.PI, 0); ctx.closePath(); ctx.fill(); // 伞面
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI + (i + 0.5) * Math.PI / 6;
    ctx.beginPath(); ctx.moveTo(0, -2);
    ctx.lineTo(Math.cos(a) * 16, -2 + Math.sin(a) * 16); ctx.stroke();
  }
  ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.ellipse(-4, -6, 5, 3, -0.5, 0, Math.PI * 2); ctx.fill(); // 高光
  ctx.globalAlpha = 1;
  ctx.restore();
}
function drawMan(ctx, o, t) {
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(o.rot);
  const shakeX = (Math.random() - 0.5) * o.shake * 3;
  ctx.translate(shakeX, 0);
  ctx.lineCap = 'round';
  if (o.state === 'grip') {
    // 腿（站姿，脚踩地）
    ctx.strokeStyle = '#2c3e50'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-10, 26); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(10, 26); ctx.stroke();
    // 身体
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -26); ctx.stroke();
    // 手臂：从肩膀伸向树干（树在右侧）
    const ax = world.anchor.x - o.x;
    ctx.strokeStyle = '#ffd9b3'; ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.moveTo(0, -24);
    ctx.quadraticCurveTo(ax * 0.6, -30, ax, -26); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -24);
    ctx.quadraticCurveTo(ax * 0.6, -22, ax, -18); ctx.stroke();
    // 头
    ctx.fillStyle = '#ffd9b3';
    ctx.beginPath(); ctx.arc(0, -38, 8, 0, Math.PI * 2); ctx.fill();
    // 眼睛（紧闭用力状）
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-3, -39); ctx.lineTo(-1, -37); ctx.moveTo(3, -39); ctx.lineTo(1, -37); ctx.stroke();
    // 汗珠
    if (o.sweat) {
      ctx.fillStyle = '#4fc3f7';
      const w = Math.sin(t / 90);
      if (w > 0.2) { ctx.beginPath(); ctx.arc(-9, -46, 2.5, 0, Math.PI * 2); ctx.fill(); }
      if (w < -0.2) { ctx.beginPath(); ctx.arc(9, -49, 2, 0, Math.PI * 2); ctx.fill(); }
    }
  } else {
    // 自由飞行：四肢乱甩
    const a1 = Math.sin(t / 60) * 1.1, a2 = Math.sin(t / 60 + 2) * 1.1;
    ctx.strokeStyle = '#2c3e50'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a1 + 0.5) * 22, Math.sin(a1 + 0.5) * 22); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a2 + 0.5) * 22, Math.sin(a2 + 0.5) * 22); ctx.stroke();
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -26); ctx.stroke();
    ctx.strokeStyle = '#ffd9b3'; ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.moveTo(0, -24);
    ctx.lineTo(Math.cos(a1) * 18, -24 + Math.sin(a1) * 18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -24);
    ctx.lineTo(Math.cos(a2) * 18, -24 + Math.sin(a2) * 18); ctx.stroke();
    ctx.fillStyle = '#ffd9b3';
    ctx.beginPath(); ctx.arc(0, -36, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.arc(-3, -37, 1.5, 0, Math.PI * 2); ctx.arc(3, -37, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.ellipse(0, -33, 2.5, 2, 0, 0, Math.PI * 2); ctx.fill(); // 张嘴
  }
  ctx.restore();
}
function drawObj(ctx, o) {
  if (o.gone) return;
  // 地面的影子
  if (o.state === 'ground') {
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.beginPath(); ctx.ellipse(o.x, world.groundY + 3, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (o.type === 'leaf') drawLeaf(ctx, o);
  else if (o.type === 'hat') drawHat(ctx, o);
  else if (o.type === 'sunhat') drawSunhat(ctx, o);
  else if (o.type === 'umbrella') drawUmbrella(ctx, o);
  else if (o.type === 'parasol') drawParasol(ctx, o);
  else if (o.type === 'beachball') drawBeachBall(ctx, o);
  else if (o.type === 'person') drawPerson(ctx, o, now());
}
function drawPerson(ctx, o, t) {
  if (o.look === 'woman') drawWoman(ctx, o, t);
  else drawMan(ctx, o, t);
}

/* ---------- 海滨物品 ---------- */
function drawSunhat(ctx, o) {
  ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
  ctx.fillStyle = '#f6d77b'; // 草编帽
  ctx.beginPath(); ctx.ellipse(0, 4, 15, 5, 0, 0, Math.PI * 2); ctx.fill(); // 帽檐
  ctx.beginPath(); ctx.moveTo(-9, 3); ctx.quadraticCurveTo(0, -12, 9, 3); ctx.closePath(); ctx.fill(); // 帽顶
  ctx.fillStyle = '#5aa7de'; // 蓝色缎带
  ctx.fillRect(-9, 1, 18, 2.6);
  ctx.restore();
}
function drawParasol(ctx, o) {
  ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
  ctx.strokeStyle = '#8a7a4f'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 18); ctx.stroke(); // 伞杆
  const R = 18, seg = 8; // 红白相间伞面
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI + i * Math.PI / seg, a1 = Math.PI + (i + 1) * Math.PI / seg;
    ctx.fillStyle = i % 2 ? '#fdfdfd' : '#e74c3c';
    ctx.beginPath(); ctx.moveTo(0, -4);
    ctx.arc(0, -4, R, a0, a1);
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, -4, R, Math.PI, 0); ctx.stroke();
  ctx.fillStyle = '#f1c40f';
  ctx.beginPath(); ctx.arc(0, -4, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawBeachBall(ctx, o) {
  ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
  const R = 13;
  const cols = ['#e74c3c', '#f1c40f', '#3498db'];
  for (let i = 0; i < 3; i++) {
    const a0 = i * Math.PI * 2 / 3 - Math.PI / 2, a1 = a0 + Math.PI * 2 / 3;
    ctx.fillStyle = cols[i];
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, a0, a1); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ---------- 美女角色（连衣裙）：裙摆扬起、长发飘动 ---------- */
function drawWoman(ctx, o, t) {
  const wind = input.wind;
  const blow = clamp(wind * 1.4 + (o.state === 'free' ? 0.6 : 0), 0, 1); // 裙摆扬起程度 0~1
  const flap = Math.sin(t / 70);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(o.rot);
  ctx.translate((Math.random() - 0.5) * o.shake * 3, 0);
  ctx.lineCap = 'round';

  const skin = '#f4d2b0';
  const dress = '#fdfdfd', dressShade = '#e3e3ee';
  const hairCol = '#4a3320';

  if (o.state === 'grip') {
    // ---- 站姿：双手抱住右侧电线杆，裙摆被风吹起 ----
    const skirtY = 6;                          // 腰部（相对重心）
    const hemBase = skirtY + 17;               // 无风时裙摆位置
    const hemY = hemBase - blow * 40 + flap * blow * 5;
    // 腿
    ctx.strokeStyle = skin; ctx.lineWidth = 5.5;
    ctx.beginPath(); ctx.moveTo(-4, skirtY + 4); ctx.lineTo(-6, 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5, skirtY + 4); ctx.lineTo(8, 30); ctx.stroke();
    // 高跟鞋
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.ellipse(-7, 31, 3.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(9, 31, 3.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    // 安全裤（裙摆扬起时可见，卡通化处理）
    if (blow > 0.3) {
      ctx.fillStyle = '#ffe9f2';
      ctx.beginPath();
      ctx.moveTo(-5, skirtY + 3); ctx.lineTo(-6.5, hemY - 3);
      ctx.lineTo(6.5, hemY - 3); ctx.lineTo(5, skirtY + 3);
      ctx.closePath(); ctx.fill();
    }
    // 裙摆（喇叭形，随风向上吹起）
    ctx.fillStyle = dress;
    ctx.strokeStyle = dressShade; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-6, skirtY);
    ctx.quadraticCurveTo(-17 - blow * 12, (skirtY + hemY) / 2 + flap * blow * 3, -15 - blow * 16, hemY + flap * blow * 5);
    ctx.quadraticCurveTo(0, hemY + 5 + flap * blow * 4, 15 + blow * 16, hemY + flap * blow * 5);
    ctx.quadraticCurveTo(12 + blow * 10, (skirtY + hemY) / 2 - flap * blow * 3, 6, skirtY);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // 上身（贴身连衣裙）
    ctx.fillStyle = dress;
    ctx.beginPath();
    ctx.moveTo(-6, skirtY);
    ctx.quadraticCurveTo(-9.5, -9, -5.5, -17);
    ctx.lineTo(5.5, -17);
    ctx.quadraticCurveTo(9.5, -9, 6, skirtY);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 束腰
    ctx.strokeStyle = '#f6c9d8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-6.5, skirtY - 1); ctx.lineTo(6.5, skirtY - 1); ctx.stroke();
    // 手臂：抱住右侧的电线杆
    const px = world.anchor.x - o.x;
    ctx.strokeStyle = skin; ctx.lineWidth = 4.2;
    ctx.beginPath(); ctx.moveTo(-4, -14);
    ctx.quadraticCurveTo(px * 0.5, -19, px, -13); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, -14);
    ctx.quadraticCurveTo(px * 0.55, -8, px, -3); ctx.stroke();
    // 头
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(0, -27, 9.5, 0, Math.PI * 2); ctx.fill();
    // 表情
    if (o.grip < 0.3 || wind > 0.75) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-3.5, -28, 2.4, 0, Math.PI * 2); ctx.arc(3.5, -28, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(-3.5, -28, 1.2, 0, Math.PI * 2); ctx.arc(3.5, -28, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.ellipse(0, -21, 2.4, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = '#5b4632'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-5, -28); ctx.lineTo(-2, -26); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(5, -28); ctx.lineTo(2, -26); ctx.stroke();
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(0, -21, 2.6, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    }
    // 腮红
    ctx.fillStyle = 'rgba(255,120,130,.45)';
    ctx.beginPath(); ctx.arc(-7.5, -23, 2.6, 0, Math.PI * 2); ctx.arc(7.5, -23, 2.6, 0, Math.PI * 2); ctx.fill();
    // 汗珠
    if (o.sweat) {
      ctx.fillStyle = '#5ec8f0';
      const sw = Math.sin(t / 90);
      if (sw > 0.2) { ctx.beginPath(); ctx.arc(-11, -33, 2.4, 0, Math.PI * 2); ctx.fill(); }
      if (sw < -0.2) { ctx.beginPath(); ctx.arc(11, -36, 1.8, 0, Math.PI * 2); ctx.fill(); }
    }
    // 长发（被风吹起）
    drawHair(ctx, t, blow, flap, hairCol);
  } else {
    // ---- 被吹飞：四肢乱甩，裙发狂飘 ----
    const a1 = Math.sin(t / 60) * 1.2, a2 = Math.sin(t / 60 + 2) * 1.2;
    ctx.strokeStyle = skin; ctx.lineWidth = 5.5;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a1 + 0.6) * 26, Math.sin(a1 + 0.6) * 26); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a2 + 0.6) * 26, Math.sin(a2 + 0.6) * 26); ctx.stroke();
    // 安全裤
    ctx.fillStyle = '#ffe9f2';
    ctx.beginPath(); ctx.ellipse(0, 2, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
    // 裙摆（炸开）
    ctx.fillStyle = dress; ctx.strokeStyle = dressShade; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-6, 4);
    ctx.quadraticCurveTo(-24, -2 + flap * 6, -16, -22 + flap * 8);
    ctx.quadraticCurveTo(0, -26 + flap * 6, 16, -22 + flap * 8);
    ctx.quadraticCurveTo(24, -2 + flap * 6, 6, 4);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 上身
    ctx.fillStyle = dress;
    ctx.beginPath();
    ctx.moveTo(-6, 4);
    ctx.quadraticCurveTo(-9, -12, -5, -20);
    ctx.lineTo(5, -20);
    ctx.quadraticCurveTo(9, -12, 6, 4);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 手臂乱甩
    ctx.strokeStyle = skin; ctx.lineWidth = 4.2;
    ctx.beginPath(); ctx.moveTo(-4, -17);
    ctx.lineTo(Math.cos(a1) * 20, -17 + Math.sin(a1) * 20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, -17);
    ctx.lineTo(Math.cos(a2) * 20, -17 + Math.sin(a2) * 20); ctx.stroke();
    // 头 + 惊慌脸
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(0, -30, 9.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-3.5, -31, 2.4, 0, Math.PI * 2); ctx.arc(3.5, -31, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(-3.5, -31, 1.2, 0, Math.PI * 2); ctx.arc(3.5, -31, 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.ellipse(0, -24, 2.4, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    drawHair(ctx, t, 1, flap, hairCol);
  }
  ctx.restore();
}
function drawHair(ctx, t, blow, flap, color) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * (0.15 + i * 0.11); // 向后上方散开
    const len = 15 + blow * 26 + Math.sin(t / 80 + i) * 3;
    ctx.lineWidth = 4.5 - i * 0.6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 7, -27 + Math.sin(a) * 7);
    const mx = Math.cos(a) * len * 0.6, my = -27 + Math.sin(a) * len * 0.6 - blow * 6 + flap * 2;
    const ex = Math.cos(a) * len, ey = -27 + Math.sin(a) * len - blow * 14 + flap * 4;
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }
}

/* ==================== 场景绘制 ==================== */
let clouds = [], grass = [], flowers = [];
function buildScenery() {
  const { W, H } = world;
  clouds = [];
  for (let i = 0; i < 4; i++) {
    clouds.push({ x: rand(0, W), y: rand(30, H * 0.4), s: rand(0.7, 1.4), spd: rand(6, 14) });
  }
  grass = [];
  for (let i = 0; i < 70; i++) {
    grass.push({ x: rand(0, W), h: rand(6, 16), tilt: rand(-3, 3) });
  }
  flowers = [];
  const flowerCols = ['#fff3e0', '#ffcdd2', '#e1f5fe', '#ffe082'];
  for (let i = 0; i < 18; i++) {
    flowers.push({ x: rand(0, W), y: rand(2, 30), c: flowerCols[i % flowerCols.length] });
  }
}
/* ==================== 场景绘制 ==================== */
const PAINTERS = {
  village: paintVillage,
  seaside: paintSeaside,
};
function drawScene(ctx, t, wind) {
  const painter = PAINTERS[level && level.scene] || PAINTERS.village;
  painter(ctx, t, wind);
  // 大风时画面泛白（所有场景通用）
  if (wind > 0.35) {
    ctx.fillStyle = `rgba(255,255,255,${(wind - 0.35) * 0.25})`;
    ctx.fillRect(0, 0, world.W, world.H);
  }
}
function paintVillage(ctx, t, wind) {
  const { W, H, groundY } = world;
  // 天空：深蓝 → 天蓝 → 暖白（多段渐变更有层次）
  const g = ctx.createLinearGradient(0, 0, 0, groundY + 4);
  g.addColorStop(0, '#3f8fd9');
  g.addColorStop(0.45, '#6fb9ec');
  g.addColorStop(0.78, '#b7e2f7');
  g.addColorStop(1, '#eaf8ff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, groundY + 4);
  // 太阳 + 光晕
  const sx = W * 0.78, sy = H * 0.11;
  const halo = ctx.createRadialGradient(sx, sy, 4, sx, sy, 92);
  halo.addColorStop(0, 'rgba(255,247,200,.95)');
  halo.addColorStop(0.25, 'rgba(255,240,170,.42)');
  halo.addColorStop(1, 'rgba(255,240,170,0)');
  ctx.fillStyle = halo; ctx.fillRect(sx - 92, sy - 92, 184, 184);
  ctx.fillStyle = '#fff7cf';
  ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI * 2); ctx.fill();
  // 云（随风飘）
  drawClouds(ctx, t, wind);
  // 远山：两层 + 近地雾气
  ctx.fillStyle = '#b9d6a4';
  ctx.beginPath();
  ctx.moveTo(0, groundY + 10);
  ctx.quadraticCurveTo(W * 0.18, groundY - 64, W * 0.42, groundY - 22);
  ctx.quadraticCurveTo(W * 0.68, groundY - 72, W, groundY - 26);
  ctx.lineTo(W, groundY + 10); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#93c47d';
  ctx.beginPath();
  ctx.moveTo(0, groundY + 12);
  ctx.quadraticCurveTo(W * 0.3, groundY - 44, W * 0.6, groundY - 8);
  ctx.quadraticCurveTo(W * 0.85, groundY - 48, W, groundY - 14);
  ctx.lineTo(W, groundY + 12); ctx.closePath(); ctx.fill();
  const mist = ctx.createLinearGradient(0, groundY - 30, 0, groundY + 4);
  mist.addColorStop(0, 'rgba(255,255,255,0)');
  mist.addColorStop(1, 'rgba(255,255,255,.5)');
  ctx.fillStyle = mist; ctx.fillRect(0, groundY - 30, W, 34);
  // 草地（渐变）
  const lg = ctx.createLinearGradient(0, groundY, 0, H);
  lg.addColorStop(0, '#8bc34a');
  lg.addColorStop(0.25, '#7cb342');
  lg.addColorStop(1, '#558b2f');
  ctx.fillStyle = lg; ctx.fillRect(0, groundY, W, H - groundY);
  // 草尖（随风吹拂）
  ctx.strokeStyle = 'rgba(63,120,35,.85)'; ctx.lineWidth = 1.2;
  const sway = wind * 7;
  for (const b of grass) {
    ctx.beginPath();
    ctx.moveTo(b.x, groundY + 4);
    ctx.quadraticCurveTo(b.x + b.tilt * 0.5, groundY + 4 - b.h * 0.6, b.x + b.tilt + sway, groundY + 4 - b.h);
    ctx.stroke();
  }
  // 小花点缀
  for (let i = 0; i < flowers.length; i++) {
    const f = flowers[i];
    ctx.fillStyle = f.c;
    ctx.beginPath(); ctx.arc(f.x, groundY + f.y, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(f.x, groundY + f.y, .9, 0, Math.PI * 2); ctx.fill();
  }
  // 树（守树人关）
  if (world.anchor && world.anchor.type === 'tree') drawTree(ctx, t, wind);
}
function drawClouds(ctx, t, wind) {
  for (const c of clouds) {
    const cx = c.x, cy = c.y, s = c.s;
    ctx.save();
    // 云下阴影（增加体积感）
    ctx.fillStyle = 'rgba(110,150,190,.16)';
    ctx.beginPath(); ctx.ellipse(cx + 5, cy + 7, 26 * s, 9 * s, 0, 0, Math.PI * 2); ctx.fill();
    // 云朵主体（多弧拼合，更蓬松）
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.beginPath();
    ctx.arc(cx, cy, 15 * s, 0, Math.PI * 2);
    ctx.arc(cx + 17 * s, cy - 6 * s, 12 * s, 0, Math.PI * 2);
    ctx.arc(cx + 33 * s, cy, 14 * s, 0, Math.PI * 2);
    ctx.arc(cx + 16 * s, cy + 5 * s, 13 * s, 0, Math.PI * 2);
    ctx.fill();
    // 顶部高光
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.ellipse(cx + 5 * s, cy - 2 * s, 20 * s, 6 * s, -.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
/* ---------- 海滨城市：海 / 沙滩 / 建筑 / 海鸥 / 电线杆 ---------- */
function paintSeaside(ctx, t, wind) {
  const { W, H, groundY } = world;
  // 天空：天蓝 → 地平线暖色（黄昏感）
  const g = ctx.createLinearGradient(0, 0, 0, groundY);
  g.addColorStop(0, '#2f8fd6');
  g.addColorStop(0.55, '#7cc8f2');
  g.addColorStop(0.82, '#c9ecfa');
  g.addColorStop(1, '#fff3d6');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 太阳 + 更大的光晕
  const sunX = W * 0.82, sunY = H * 0.15;
  const rg = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, 95);
  rg.addColorStop(0, 'rgba(255,246,180,1)');
  rg.addColorStop(0.3, 'rgba(255,240,150,.55)');
  rg.addColorStop(1, 'rgba(255,240,150,0)');
  ctx.fillStyle = rg; ctx.fillRect(sunX - 95, sunY - 95, 190, 190);
  ctx.fillStyle = '#fff3b8';
  ctx.beginPath(); ctx.arc(sunX, sunY, 21, 0, Math.PI * 2); ctx.fill();
  // 云
  drawClouds(ctx, t, wind);
  // 海
  const horizon = H * 0.33, shore = H * 0.54;
  const sg = ctx.createLinearGradient(0, horizon, 0, shore);
  sg.addColorStop(0, '#1f7fc4'); sg.addColorStop(1, '#57c2e6');
  ctx.fillStyle = sg; ctx.fillRect(0, horizon, W, shore - horizon);
  // 海面阳光倒影（一条亮带，风越大越晃）
  const refl = ctx.createLinearGradient(sunX - 34, horizon, sunX + 34, horizon);
  refl.addColorStop(0, 'rgba(255,240,170,0)');
  refl.addColorStop(0.5, `rgba(255,240,170,${0.22 + wind * 0.2})`);
  refl.addColorStop(1, 'rgba(255,240,170,0)');
  ctx.fillStyle = refl; ctx.fillRect(sunX - 34, horizon, 68, shore - horizon);
  // 远帆船（缓慢移动）
  drawBoat(ctx, t, wind);
  // 海浪（风越大越乱）
  ctx.strokeStyle = 'rgba(255,255,255,.65)';
  for (let i = 0; i < 3; i++) {
    const yy = horizon + (shore - horizon) * (0.22 + i * 0.32);
    ctx.lineWidth = 1.2 + i * 0.6;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const yw = yy + Math.sin(x / 24 + t / 480 + i * 2.1) * (1.5 + wind * 5 + i * 0.8);
      if (x === 0) ctx.moveTo(x, yw); else ctx.lineTo(x, yw);
    }
    ctx.stroke();
  }
  // 浪花点
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  for (let i = 0; i < 8; i++) {
    const fx = (i * 61 + t * (0.01 + wind * 0.06)) % W;
    const fy = shore - 4 + Math.sin(i * 3.7) * 5;
    ctx.beginPath(); ctx.arc(fx, fy, 2, 0, Math.PI * 2); ctx.fill();
  }
  // 沙滩
  ctx.fillStyle = '#f2dfae';
  ctx.beginPath();
  ctx.moveTo(0, shore);
  ctx.quadraticCurveTo(W * 0.5, shore - 7, W, shore);
  ctx.lineTo(W, groundY - 34);
  ctx.lineTo(0, groundY - 34);
  ctx.closePath(); ctx.fill();
  // 沙地波纹
  ctx.strokeStyle = 'rgba(200,170,110,.5)'; ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const yy = shore + 14 + i * 22;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 6) {
      const yw = yy + Math.sin(x / 20 + i) * 3;
      if (x === 0) ctx.moveTo(x, yw); else ctx.lineTo(x, yw);
    }
    ctx.stroke();
  }
  // 建筑群（两侧，中间留出海景）
  drawBuilding(ctx, -W * 0.05, H * 0.24, W * 0.27, '#f4a261', t, wind);
  drawBuilding(ctx, W * 0.70, H * 0.22, W * 0.33, '#8fc98f', t, wind);
  drawBuilding(ctx, W * 0.26, H * 0.34, W * 0.17, '#f7c873', t, wind);
  // 海鸥（风大时被吹高）
  drawGulls(ctx, t, wind);
  // 街道
  ctx.fillStyle = '#aeb6bd';
  ctx.fillRect(0, groundY - 46, W, 46);
  ctx.fillStyle = '#c6cdd2';
  ctx.fillRect(0, groundY - 50, W, 6);
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 4;
  ctx.setLineDash([16, 14]);
  ctx.beginPath(); ctx.moveTo(0, groundY - 24); ctx.lineTo(W, groundY - 24); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#96a1a9';
  ctx.fillRect(0, groundY - 52, W, 2);
  // 电线杆（人物抱住的固定物）
  if (world.anchor && world.anchor.type === 'pole') drawPole(ctx, t, wind);
  // 楼顶小旗（随风狂飘）
  drawFlag(ctx, t, wind);
}
function drawBuilding(ctx, x, topY, w, color, t, wind) {
  const { groundY } = world;
  const bottomY = groundY - 48;
  const h = bottomY - topY;
  if (h < 40) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, topY, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.08)';
  ctx.fillRect(x + w - 6, topY, 6, h);
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(x - 3, topY - 4, w + 6, 8);
  // 窗户
  const cols = Math.max(1, Math.floor(w / 26));
  const rows = Math.max(1, Math.floor(h / 42));
  const cw = (w - 16) / cols, ch = Math.min(20, (h - 24) / rows);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = x + 8 + c * cw + (cw - 13) / 2, wy = topY + 12 + r * ch;
      if (wy + 14 < bottomY - 6) {
        ctx.fillRect(wx, wy, 13, 14);
        ctx.strokeRect(wx, wy, 13, 14);
      }
    }
  }
  // 遮阳篷（风大上扬）
  const aw = w * 0.5, ax = x + w * 0.25, ay = topY + 8 + h * 0.3;
  ctx.save();
  ctx.translate(ax + aw / 2, ay);
  ctx.transform(1, -wind * 0.6 - Math.sin(t / 700) * 0.08, 0, 1, 0, 0);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#f6f6f6' : '#e74c3c';
    ctx.fillRect(-aw / 2 + (i * aw) / 4, 0, aw / 4 + 1, 13);
  }
  ctx.restore();
}
function drawGulls(ctx, t, wind) {
  const { W, H } = world;
  const gulls = [
    { x0: 0.2, y0: 0.22, s: 1.0, ph: 0 },
    { x0: 0.5, y0: 0.26, s: 0.7, ph: 2 },
    { x0: 0.75, y0: 0.19, s: 0.85, ph: 4 },
  ];
  ctx.strokeStyle = '#5b6a72'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (const gu of gulls) {
    const x = ((gu.x0 * W + t * (8 + wind * 60)) % (W + 80)) - 40;
    const y = gu.y0 * H - wind * 46 + Math.sin(t / 700 + gu.ph) * 6;
    const s = gu.s;
    ctx.beginPath();
    ctx.moveTo(x - 9 * s, y + 3 * s);
    ctx.quadraticCurveTo(x - 4 * s, y - 4 * s, x, y);
    ctx.quadraticCurveTo(x + 4 * s, y - 4 * s, x + 9 * s, y + 3 * s);
    ctx.stroke();
  }
}
function drawPole(ctx, t, wind) {
  const { groundY, anchor } = world;
  const x = anchor.x;
  const top = groundY - 270;
  ctx.save();
  // 杆身（水泥质感）
  const g = ctx.createLinearGradient(x - 5, 0, x + 5, 0);
  g.addColorStop(0, '#aab4bb'); g.addColorStop(0.5, '#e4e9ec'); g.addColorStop(1, '#939ea6');
  ctx.fillStyle = g;
  ctx.fillRect(x - 5, top, 10, groundY - top);
  // 底座
  ctx.fillStyle = '#79838b';
  ctx.fillRect(x - 8, groundY - 6, 16, 6);
  // 横担 ×2
  ctx.strokeStyle = '#6d767d'; ctx.lineWidth = 4.5;
  ctx.beginPath(); ctx.moveTo(x - 4, top + 42); ctx.lineTo(x - 72, top + 32); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 4, top + 42); ctx.lineTo(x + 72, top + 32); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, top + 84); ctx.lineTo(x - 56, top + 76); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 4, top + 84); ctx.lineTo(x + 56, top + 76); ctx.stroke();
  // 绝缘子
  ctx.fillStyle = '#c3ccd2';
  for (const [ix, iy] of [[x - 72, top + 34], [x + 72, top + 34], [x - 56, top + 78], [x + 56, top + 78]]) {
    ctx.fillRect(ix - 3, iy, 6, 10);
  }
  // 电线（向两侧垂去）
  ctx.strokeStyle = '#7c868d'; ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - 72, top + 32);
  ctx.quadraticCurveTo(x - 130, top + 58, x - 200, top + 42);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 72, top + 32);
  ctx.quadraticCurveTo(x + 130, top + 58, x + 200, top + 42);
  ctx.stroke();
  // 灯臂 + 路灯
  ctx.strokeStyle = '#79838b'; ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.moveTo(x + 4, top + 96); ctx.lineTo(x + 34, top + 104); ctx.stroke();
  ctx.fillStyle = '#ffd76e';
  ctx.beginPath(); ctx.ellipse(x + 40, top + 108, 7, 4.5, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawFlag(ctx, t, wind) {
  const { W, H } = world;
  const fx = W * 0.83, fy = H * 0.265;
  ctx.strokeStyle = '#8a7a4f'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 26); ctx.stroke();
  const wave = Math.sin(t / 110) * (1 + wind * 3);
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.moveTo(fx, fy - 26);
  ctx.quadraticCurveTo(fx + 14, fy - 22 + wave, fx + 26, fy - 26 + wave * 1.4);
  ctx.lineTo(fx + 26, fy - 14);
  ctx.quadraticCurveTo(fx + 14, fy - 16, fx, fy - 14);
  ctx.closePath(); ctx.fill();
}

function drawTree(ctx, t, wind) {
  const { groundY, anchor } = world;
  const sway = Math.sin(t / 600) * 0.03 + wind * 0.06;
  ctx.save();
  ctx.translate(anchor.x, groundY);
  ctx.rotate(sway * 0.4);
  // 树干（带渐变和树根）
  const tg = ctx.createLinearGradient(-9, 0, 9, 0);
  tg.addColorStop(0, '#6d4c41'); tg.addColorStop(0.5, '#8d6e63'); tg.addColorStop(1, '#5d4037');
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.moveTo(-9, 0); ctx.lineTo(-6, -150); ctx.lineTo(6, -150); ctx.lineTo(9, 0);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#4e342e';
  ctx.beginPath(); ctx.ellipse(0, 2, 21, 7, 0, 0, Math.PI * 2); ctx.fill();
  // 树冠（多层圆，更立体）
  const blobs = [
    [-34, -172, 30, '#3f8f3f'],
    [30, -178, 32, '#357a35'],
    [0, -208, 40, '#4caf50'],
    [-16, -192, 20, '#66bb6a'],
    [16, -196, 22, '#57a857'],
    [0, -226, 24, '#6fc76f'],
  ];
  for (const [bx, by, br, col] of blobs) {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
  }
  // 树冠高光
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.arc(-14, -206, 13, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawBoat(ctx, t, wind) {
  const { W, H } = world;
  const bx = (t * (6 + wind * 20)) % (W + 140) - 70;
  const by = H * 0.42 + Math.sin(t / 900) * 2.5;
  ctx.save();
  ctx.translate(bx, by);
  // 船身
  ctx.fillStyle = '#7a4a2b';
  ctx.beginPath();
  ctx.moveTo(-15, 0); ctx.quadraticCurveTo(0, 9, 15, 0);
  ctx.lineTo(11, 3); ctx.quadraticCurveTo(0, 11, -11, 3);
  ctx.closePath(); ctx.fill();
  // 帆
  ctx.fillStyle = '#fff8f0';
  ctx.beginPath();
  ctx.moveTo(0, -26); ctx.lineTo(0, -2); ctx.quadraticCurveTo(9, -6, 8, -24);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,180,120,.6)';
  ctx.beginPath();
  ctx.moveTo(-1, -26); ctx.lineTo(-1, -2); ctx.quadraticCurveTo(-9, -5, -8, -23);
  ctx.closePath(); ctx.fill();
  // 桅杆
  ctx.strokeStyle = '#5d4037'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(0, -27); ctx.stroke();
  ctx.restore();
}
function drawGripBar(ctx, o, wind) {
  if (o.state !== 'grip' || !(o.grip < 1 || wind > 0.35)) return;
  const bx = o.x - 16, by = o.y - o.barY;
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  ctx.beginPath(); ctx.roundRect(bx, by, 32, 6, 3); ctx.fill();
  ctx.fillStyle = o.grip > 0.4 ? '#ffd54f' : '#ff5252';
  ctx.beginPath(); ctx.roundRect(bx, by, 32 * Math.max(0.04, o.grip), 6, 3); ctx.fill();
}

/* ==================== 关卡与流程 ==================== */
// 场景规划：热身两关 + 3 个主场景（场景2/3 占位，敬请期待）
const LEVELS = [
  {
    name: '热身 · 晨风村', scene: 'village', anchor: null,
    desc: '把树叶、草帽和雨伞都吹上天！',
    items: [
      { type: 'leaf', x: 0.22, n: 5 },
      { type: 'hat', x: 0.55 },
      { type: 'umbrella', x: 0.78 },
    ],
  },
  {
    name: '热身 · 守树人', scene: 'village',
    anchor: { type: 'tree', x: 0.5, name: '树' },
    desc: '用力吹！把抱着树的人吹飞！',
    items: [
      { type: 'person', x: 0.5, look: 'man' },
      { type: 'leaf', x: 0.18, n: 4 },
      { type: 'hat', x: 0.38 },
    ],
  },
  {
    name: '场景1 · 海滨城市', scene: 'seaside',
    anchor: { type: 'pole', x: 0.5, name: '电线杆' },
    desc: '海风起！把抱着电线杆的美女吹上天！',
    items: [
      { type: 'person', x: 0.5, look: 'woman' },
      { type: 'parasol', x: 0.74 },
      { type: 'beachball', x: 0.24 },
      { type: 'sunhat', x: 0.38 },
    ],
  },
  { name: '场景2', placeholder: true },
  { name: '场景3', placeholder: true },
];

const world = { W: 390, H: 844, groundY: 700, anchor: null }; // anchor: {type:'tree'|'pole', x, name} 人物抱住的固定物
let state = 'start';        // start | calibrating | playing | win
let levelIdx = 0;
let level = null;           // 当前关卡对象
let levelPaused = false;
let timeElapsed = 0;
let totalTime = 0;
let totalGone = 0;
let maxWindAll = 0;
let autoT = 0;
let pendingLevel = 0;       // 选关页点选的关卡
let inputPref = 'mic';      // 首页输入模式选择：mic | demo
let micReady = false;       // 麦克风已初始化并校准过（会话内复用）
const LEVEL_ICONS = ['🌿', '🌳', '🌊', '❓', '❓'];
const DONE_KEY = 'blowGame.done'; // 已通关关卡（本地存档）
function getDone() {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) || '[]'); } catch (e) { return []; }
}
function setDone(i) {
  const d = getDone();
  if (!d.includes(i)) {
    d.push(i);
    try { localStorage.setItem(DONE_KEY, JSON.stringify(d)); } catch (e) {}
  }
}
const AUTOWIND = new URLSearchParams(location.search).has('autowind');
// 合成麦克风：模拟白噪声吹气信号，端到端验证"拾音→风力→物理"整条链路（测试用）
const FAKEMIC = new URLSearchParams(location.search).has('fakemic');

function startLevel(i) {
  if (i < 0 || i >= LEVELS.length || LEVELS[i].placeholder) return;
  levelIdx = i;
  const L = LEVELS[i];
  level = { name: L.name, scene: L.scene, desc: L.desc, items: [] };
  world.anchor = L.anchor
    ? { type: L.anchor.type, x: L.anchor.x * world.W, name: L.anchor.name }
    : null;
  const { groundY } = world;
  for (const it of L.items) {
    const n = it.n || 1;
    for (let k = 0; k < n; k++) {
      const x = clamp((it.x + (k - (n - 1) / 2) * 0.05) * world.W, 40, world.W - 40);
      const o = it.type === 'person'
        ? new Person(x, groundY, it.look)
        : new Obj(it.type, x, groundY);
      level.items.push(o);
    }
  }
  timeElapsed = 0;
  state = 'playing';
  levelPaused = false;
  showScreen('hud');
  toast(`🌬️ ${L.name} — ${L.desc}`);
}

function checkWin() {
  if (state !== 'playing' || levelPaused) return;
  if (!level.items.every(o => o.gone)) return;
  levelPaused = true;
  totalTime += timeElapsed;
  totalGone += level.items.length;
  sfx.jingle();
  setDone(levelIdx);
  if (AUTOWIND) {
    // 自动化测试：自动推进到下一关
    const next = levelIdx + 1;
    if (next < LEVELS.length && !LEVELS[next].placeholder) {
      toast('🎉 过关！进入下一关');
      setTimeout(() => startLevel(next), 1500);
    } else {
      setTimeout(showWin, 900);
    }
  } else {
    setTimeout(showWin, 900);
  }
}

function showWin() {
  state = 'win';
  confettiBurst(30);
  const mm = Math.floor(totalTime / 60), ss = Math.floor(totalTime % 60);
  const pending = LEVELS.filter(l => l.placeholder).length;
  $('#winStats').innerHTML =
    `⏱️ 总用时 ${mm}:${String(ss).padStart(2, '0')}<br>` +
    `💨 最大风力 ${Math.round(maxWindAll * 100)}%<br>` +
    `🎈 吹飞物品 ${totalGone} 件` +
    (pending > 0 ? `<br><span style="opacity:.75">🎬 还有 ${pending} 个场景制作中，敬请期待！</span>` : '');
  // 下一关按钮：有后续可玩场景才显示
  const next = levelIdx + 1;
  const hasNext = next < LEVELS.length && !LEVELS[next].placeholder;
  $('#btnNext').classList.toggle('hidden', !hasNext);
  if (hasNext) $('#btnNext').textContent = `下一关 · ${LEVELS[next].name}`;
  showScreen('win');
}
function showStart() {
  state = 'start';
  level = null;
  $('#demoHint').classList.add('hidden');
  buildLevelGrid();
  showScreen('start');
}

/* ==================== 界面切换 ==================== */
// 通关彩带：在 winConfetti 容器里撒 DOM 粒子
function confettiBurst(n = 26) {
  const wrap = $('#winConfetti');
  if (!wrap) return;
  wrap.innerHTML = '';
  const emojis = ['🎉', '🎊', '✨', '⭐', '🌸', '🍃', '💨', '🎈'];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left = `${Math.random() * 100}%`;
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    el.style.animationDuration = `${2.2 + Math.random() * 2.4}s`;
    el.style.animationDelay = `${Math.random() * 0.8}s`;
    wrap.appendChild(el);
  }
  // 彩带掉落后清理
  setTimeout(() => { wrap.innerHTML = ''; }, 5200);
}
function showScreen(name) { // 'start' | 'cal' | 'win' | 'hud'
  for (const id of ['screen-start', 'screen-cal', 'screen-win']) $(id).classList.add('hidden');
  if (name === 'hud') $('#hud').classList.remove('hidden');
  else { $(`screen-${name}`).classList.remove('hidden'); $('#hud').classList.add('hidden'); }
}
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ==================== 启动流程 ==================== */
function setModePref(m) {
  inputPref = m;
  $('#modeMic').classList.toggle('active', m === 'mic');
  $('#modeDemo').classList.toggle('active', m === 'demo');
}
function buildLevelGrid() {
  const grid = $('#levelGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const done = getDone();
  LEVELS.forEach((L, i) => {
    const card = document.createElement('button');
    card.className = 'level-card' + (L.placeholder ? ' locked' : '');
    const emoji = L.placeholder ? '🔒' : LEVEL_ICONS[i];
    const desc = L.placeholder ? '敬请期待' : L.desc;
    const status = L.placeholder ? '' : (done.includes(i) ? '✅' : '');
    card.innerHTML =
      `<span class="l-emoji">${emoji}</span>` +
      `<span class="l-info"><span class="l-name">${L.name}</span><span class="l-desc">${desc}</span></span>` +
      `<span class="l-status">${status}</span>`;
    card.addEventListener('click', () => selectLevel(i));
    grid.appendChild(card);
  });
}
function selectLevel(i) {
  if (i < 0 || i >= LEVELS.length) return;
  if (LEVELS[i].placeholder) { toast('🔒 敬请期待'); return; }
  pendingLevel = i;
  if (inputPref === 'demo') startDemo();
  else startWithMic();
}
async function startWithMic() {
  sfx.init();
  if (!micReady) {
    showScreen('cal');
    const setUI = ({ text, progress, level }) => {
      $('#calTitle').textContent = text;
      $('#calHint').textContent = `当前音量 ${Math.round(clamp(level / 0.3, 0, 1) * 100)}%`;
      $('#calFill').style.width = `${clamp(progress, 0, 1) * 100}%`;
    };
    try {
      await input.initMic();
    } catch (e) {
      toast('无法使用麦克风，已切换到演示模式');
      input.setDemo();
      $('#demoHint').classList.remove('hidden');
      startLevel(pendingLevel);
      return;
    }
    await input.calibrate(setUI);
    await new Promise(r => setTimeout(r, 700)); // 让"校准完成"停留一下
    micReady = true;
  }
  startLevel(pendingLevel);
}
function startDemo() {
  sfx.init();
  input.setDemo();
  $('#demoHint').classList.remove('hidden');
  startLevel(pendingLevel);
}
async function recalibrate() {
  if (input.mode !== 'mic') { toast('演示模式无需校准'); return; }
  showScreen('cal');
  await input.calibrate(({ text, progress, level }) => {
    $('#calTitle').textContent = text;
    $('#calHint').textContent = `当前音量 ${Math.round(clamp(level / 0.3, 0, 1) * 100)}%`;
    $('#calFill').style.width = `${clamp(progress, 0, 1) * 100}%`;
  });
  showScreen('hud');
  toast('校准完成');
}

/* ==================== HUD ==================== */
function updateHUD() {
  const w = input.wind;
  const fill = $('#windFill');
  fill.style.width = `${w * 100}%`;
  $('#windVal').textContent = `${Math.round(w * 100)}%`;
  $('#wind-meter').classList.toggle('hot', w > 0.7);
  // 麦克风电平表：仅麦克风模式下显示，直接反映拾音（排障利器）
  const micRow = $('#micRow');
  const isMic = input.mode === 'mic';
  micRow.classList.toggle('hidden', !isMic);
  if (isMic) {
    const lv = clamp(input.level / Math.max(0.05, input.calPeak), 0, 1);
    $('#micFill').style.width = `${lv * 100}%`;
    micRow.classList.toggle('active', input.raw > 0.1);
  }
  if (state === 'playing' && level) {
    const gone = level.items.filter(o => o.gone).length;
    $('#goalText').textContent = `已吹飞 ${gone} / ${level.items.length}`;
    $('#levelName').textContent = level.name;
  }
  // 调试面板
  const dbg = $('#debug');
  if (!dbg.classList.contains('hidden') && !dbg.dataset.err) {
    const dRatio = input.hf / Math.max(input.rms, 1e-6);
    dbg.textContent =
      `模式: ${input.mode}\n` +
      `rms: ${input.rms.toFixed(3)}  hf: ${input.hf.toFixed(3)}  dR: ${dRatio.toFixed(2)}\n` +
      `level: ${input.level.toFixed(3)}  hf占比: ${input.hfRatio.toFixed(2)}\n` +
      `风力: ${input.wind.toFixed(2)}  raw: ${input.raw.toFixed(2)}\n` +
      `底噪: ${input.calFloor.toFixed(3)}  峰值: ${input.calPeak.toFixed(2)}\n` +
      `状态: ${state}${levelPaused ? '(暂停)' : ''}`;
  }
}

/* ==================== 主循环 ==================== */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resize() {
  const dpr = window.devicePixelRatio || 1;
  world.W = window.innerWidth;
  world.H = window.innerHeight;
  canvas.width = world.W * dpr;
  canvas.height = world.H * dpr;
  canvas.style.width = world.W + 'px';
  canvas.style.height = world.H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  world.groundY = world.H - Math.max(110, world.H * 0.16);
  buildScenery();
}

let lastT = now();
function loop(t) {
  const dt = clamp((t - lastT) / 1000, 0, 1 / 30);
  lastT = t;

  // 自动化测试：固定循环风力
  if (AUTOWIND) {
    autoT += dt;
    const p = (autoT % 5) / 5; // 5 秒一个周期：满风 3.5s / 降 0.6s / 停 0.4s / 缓升 0.5s
    const w = clamp(p < 0.7 ? 1 : p < 0.82 ? 1 - (p - 0.7) / 0.12 : p < 0.9 ? 0.1 : 0.1 + (p - 0.9) / 0.1, 0, 1);
    input.wind = input.raw = w;
  } else {
    input.update(dt);
  }

  const wind = input.wind;
  maxWindAll = Math.max(maxWindAll, wind);

  if (state === 'playing' && !levelPaused && level) {
    const onRegrip = p => p.released > 0 && toast(`😅 ${p.pronoun}又抱住了${world.anchor ? world.anchor.name : '树'}！`);
    for (const o of level.items) {
      if (o instanceof Person) o.update(dt, wind, onRegrip);
      else o.update(dt, wind);
    }
    timeElapsed += dt;
    checkWin();
  }
  sfx.wind(state === 'playing' && !levelPaused ? wind : 0);
  updateParticles(dt, state === 'playing' ? wind : 0.05);

  // 云飘动
  for (const c of clouds) {
    c.x += c.spd * dt * (0.5 + wind * 2);
    if (c.x > world.W + 80) c.x = -80;
  }

  // 绘制
  ctx.clearRect(0, 0, world.W, world.H);
  ctx.save();
  if (wind > 0.85) { // 大风时轻微震屏
    const sh = (wind - 0.85) * 8;
    ctx.translate(rand(-sh, sh), rand(-sh, sh));
  }
  drawScene(ctx, t, wind);
  if (level && state !== 'start') {
    for (const o of level.items) drawObj(ctx, o);
    for (const o of level.items) if (o instanceof Person) drawGripBar(ctx, o, wind);
  }
  drawParticles(ctx);
  if (wind > 0.7) { // 边缘暗角
    const a = (wind - 0.7) * 0.45;
    const g = ctx.createRadialGradient(world.W / 2, world.H * 0.45, Math.min(world.W, world.H) * 0.35, world.W / 2, world.H * 0.45, Math.max(world.W, world.H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, world.W, world.H);
  }
  ctx.restore();

  updateHUD();
  requestAnimationFrame(loop);
}

/* ==================== 事件绑定 ==================== */
function bindUI() {
  $('#modeMic').addEventListener('click', () => setModePref('mic'));
  $('#modeDemo').addEventListener('click', () => setModePref('demo'));
  $('#btnRestart').addEventListener('click', () => state === 'playing' && startLevel(levelIdx));
  $('#btnRecal').addEventListener('click', recalibrate);
  $('#btnMenu').addEventListener('click', showStart);
  $('#btnMenu2').addEventListener('click', showStart);
  $('#btnNext').addEventListener('click', () => startLevel(levelIdx + 1));
  $('#btnAgain').addEventListener('click', () => startLevel(levelIdx));
  $('#btnDebug').addEventListener('click', () => $('#debug').classList.toggle('hidden'));

  // 演示模式输入：按住屏幕 / 空格 = 吹气
  window.addEventListener('pointerdown', e => {
    audioCtx.ensure();
    if (input.mode === 'demo' && state === 'playing') { input.demoHeld = true; e.preventDefault(); }
  });
  window.addEventListener('pointerup', () => { input.demoHeld = false; });
  window.addEventListener('pointercancel', () => { input.demoHeld = false; });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); if (input.mode === 'demo') input.demoHeld = true; }
    if (e.code === 'KeyD') $('#debug').classList.toggle('hidden');
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') input.demoHeld = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
}

window.addEventListener('resize', resize);
// 全局错误捕获：任何运行时报错都显示在调试面板（手机调试必备）
window.addEventListener('error', e => {
  const dbg = $('#debug');
  if (dbg) {
    dbg.classList.remove('hidden');
    dbg.dataset.err = '1'; // 锁定错误信息，不被 HUD 刷新覆盖
    dbg.textContent = 'ERROR: ' + e.message + ' @' + (e.lineno || '?') + ':' + (e.colno || '?');
  }
});
// 注意：不依赖 window.load（部分环境下 load 时机不可靠），脚本在 body 末尾，
// DOM 此时必然已解析完毕，直接初始化
(function init() {
  try {
    resize();
    bindUI();
    buildLevelGrid();
    if (AUTOWIND) { // 自动化测试：直接进入演示模式
      input.setDemo();
      startLevel(0);
    }
    requestAnimationFrame(loop);
  } catch (e) {
    // 初始化失败也要让用户/开发者看得见
    const dbg = $('#debug');
    dbg.classList.remove('hidden');
    dbg.textContent = 'INIT-ERROR: ' + e.message;
    throw e;
  }
})();
