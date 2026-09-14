/* 钢琴拉伸律工作台前端 */
const MIDI_MIN = 21, MIDI_MAX = 108, A4 = 69;
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteName = m => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const state = {
  keys: new Map(),              // m -> { measures: {n: f}, captures: [测量] }
  pweights: Object.fromEntries([...Array(7)].map((_, i) => [i + 2, 1])),
  result: null,
  locks: new Map(),             // m -> cents (拖过的)
  playing: null,                // {root, up, raf, token}
  playToken: 0,
  sessionId: null,
  schemes: [],                  // {id,name,cfg,result}
  compareId: null,
};

// 采集模块需要访问的接口
window.PianoApp = {
  state, cfg, buildInput,
  renderInputTable: () => renderInputTable(),
  renderCapSel: () => renderKeyboardCapSel(),
  scheduleAnalyze: (...a) => scheduleAnalyze(...a),
};

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.borderColor = bad ? 'var(--bad)' : 'var(--accent)';
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => t.style.display = 'none', 2600);
}
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const post = async (url, body) => {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)});
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

// --------------------------------------------------------------- 输入

// 会话保存用: 录音缓冲只存在浏览器内存, 不进 JSON
function captureSummary(c) {
  if (!c) return null;
  const {_buf, ...rest} = c;
  return rest;
}
function buildInput() {
  return {
    name: $('#piano-name').value,
    a4: parseFloat($('#a4').value) || 440,
    keys: [...state.keys.entries()].map(([m, k]) => ({
      m, measures: k.measures,
      captures: (k.captures || []).map(captureSummary),
    })),
    pweights: state.pweights,
    locks: [...state.locks].map(([m, cents]) => ({m, cents})),
  };
}
function cfg() {
  return {
    rule: $$('input[name=rule]').find(r => r.checked).value,
    oct_partial: parseInt($('#oct-partial').value),
    extension: $$('input[name=extension]').find(r => r.checked).value,
    strength: parseFloat($('#strength').value),
    smooth: parseFloat($('#smooth').value),
    tol_dev: parseFloat($('#tol-dev').value),
    tol_beat_cents: parseFloat($('#tol-beat').value),
    tol_kink: parseFloat($('#tol-kink').value),
  };
}

function renderWeights() {
  const box = $('#pweights');
  box.innerHTML = '';
  for (let n = 2; n <= 8; n++) {
    const lab = document.createElement('label');
    lab.innerHTML = `${n}<input type="number" step="0.1" min="0" value="${state.pweights[n] ?? 1}">`;
    lab.querySelector('input').addEventListener('input', e => {
      state.pweights[n] = parseFloat(e.target.value) || 0;
      scheduleAnalyze();
    });
    box.appendChild(lab);
  }
}

function renderInputTable() {
  const tb = $('#input-table tbody');
  tb.innerHTML = '';
  for (const m of [...state.keys.keys()].sort((a, b) => a - b)) {
    const k = state.keys.get(m);
    const tr = document.createElement('tr');
    tr.dataset.m = m;
    let cells = `<td>${noteName(m)}</td><td>${m}</td>`;
    for (let n = 1; n <= 8; n++) {
      const v = k.measures[n];
      cells += `<td><input data-n="${n}" type="number" step="any" placeholder="${n === 1 ? 'f₁' : ''}"
        value="${v != null ? v : ''}"></td>`;
    }
    const rk = state.result?.keys.find(x => x.m === m);
    const ncap = (k.captures || []).length;
    cells += `<td class="bfit">${rk?.fitted ? rk.B.toExponential(2) : '—'}</td>
              <td class="acts">
                <button class="capgo" title="浏览器实测采集">🎤${ncap ? `<i>${ncap}</i>` : ''}</button>
                <button class="del" title="删除">×</button></td>`;
    tr.innerHTML = cells;
    tr.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', e => {
        const n = parseInt(e.target.dataset.n);
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) k.measures[n] = v;
        else delete k.measures[n];
        scheduleAnalyze();
      });
    });
    tr.querySelector('.capgo').addEventListener('click', () => {
      window.PianoCapture?.selectKey(m);
      document.querySelector('.cap-panel').scrollIntoView({behavior: 'smooth'});
    });
    tr.querySelector('.del').addEventListener('click', () => {
      state.keys.delete(m);
      state.locks.delete(m);
      renderInputTable();
      if (window.PianoCapture)
        window.PianoCapture.selectKey(+($('#cap-key')?.value || A4));
      scheduleAnalyze();
    });
    tb.appendChild(tr);
  }
  markInputBadRows();
}

function markInputBadRows() {
  if (!state.result) return;
  const bad = new Set(state.result.conflicts.filter(c => c.type === '测量偏离')
    .flatMap(c => c.notes));
  $$('#input-table tbody tr').forEach(tr =>
    tr.classList.toggle('bad', bad.has(parseInt(tr.dataset.m))));
}

$('#btn-add-key').addEventListener('click', () => {
  const m = parseInt(prompt('MIDI 键号 (21–108), A4=69', '69'));
  if (!(m >= MIDI_MIN && m <= MIDI_MAX)) return;
  if (!state.keys.has(m)) {
    state.keys.set(m, {measures: {}, captures: []});
    renderInputTable();
  }
});

// --------------------------------------------------------------- 曲线

const CV = {w: 1100, h: 320, L: 52, R: 18, T: 18, B: 30};
const xOf = m => CV.L + (m - MIDI_MIN) / (MIDI_MAX - MIDI_MIN) * (CV.w - CV.L - CV.R);
const mAtX = x => MIDI_MIN + (x - CV.L) / (CV.w - CV.L - CV.R) * (MIDI_MAX - MIDI_MIN);
// 音分量程随当前方案动态扩展, 零线始终居中
function yRange() {
  let mx = 30;
  if (state.result)
    for (const k of state.result.keys) mx = Math.max(mx, Math.abs(k.cents) + 6);
  for (const c of state.locks.values()) mx = Math.max(mx, Math.abs(c) + 6);
  const comp = state.schemes.find(s => s.id === state.compareId);
  if (comp) for (const k of comp.result.keys) mx = Math.max(mx, Math.abs(k.cents) + 6);
  return Math.min(70, Math.ceil(mx / 10) * 10);
}
const yOf = c => {
  const yr = yRange();
  return CV.T + (1 - (c + yr) / (2 * yr)) * (CV.h - CV.T - CV.B);
};
const centsAtY = y => {
  const yr = yRange();
  return (1 - (y - CV.T) / (CV.h - CV.T - CV.B)) * 2 * yr - yr;
};

function renderCurve() {
  const svg = $('#curve');
  svg.innerHTML = '';
  // 网格 + 等音分线
  const yr = yRange();
  for (let c = -yr; c <= yr; c += 10) {
    svg.appendChild(svgEl('line', {x1: CV.L, x2: CV.w - CV.R, y1: yOf(c), y2: yOf(c),
      stroke: c === 0 ? '#3a4656' : '#222a35', 'stroke-width': 1}));
    const t = svgEl('text', {x: 8, y: yOf(c) + 4, fill: '#7d8898', 'font-size': 11});
    t.textContent = `${c > 0 ? '+' : ''}${c}¢`;
    svg.appendChild(t);
  }
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 12) {
    const t = svgEl('text', {x: xOf(m), y: CV.h - 10, fill: '#7d8898',
      'font-size': 11, 'text-anchor': 'middle'});
    t.textContent = noteName(m).replace(/-?\d/, '');
    svg.appendChild(t);
  }
  const r = state.result;
  if (!r) return;
  const ks = r.keys;

  // 对比方案虚线
  const comp = state.schemes.find(s => s.id === state.compareId);
  if (comp) {
    const d = ks.map((k, i) => `${i ? 'L' : 'M'}${xOf(k.m)},${yOf(comp.result.keys[i].cents)}`).join('');
    svg.appendChild(svgEl('path', {d, fill: 'none', stroke: '#5ab0e8',
      'stroke-width': 1.5, 'stroke-dasharray': '5 4', opacity: .8}));
  }

  // 目标曲线
  const d = ks.map((k, i) => `${i ? 'L' : 'M'}${xOf(k.m)},${yOf(k.cents)}`).join('');
  svg.appendChild(svgEl('path', {d, fill: 'none', stroke: '#e0a84e', 'stroke-width': 2.2}));

  // 实测点
  for (const k of ks) {
    if (k.meas_cents == null) continue;
    svg.appendChild(svgEl('circle', {cx: xOf(k.m), cy: yOf(k.cents + k.meas_cents),
      r: k.fitted ? 2.6 : 3.4, fill: k.fitted ? '#6ec07a' : '#e0634e'}));
  }

  // 锁定锚点
  for (const [m, cents] of state.locks) {
    const c = svgEl('circle', {cx: xOf(m), cy: yOf(cents), r: 6,
      fill: '#c07be0', stroke: '#fff', 'stroke-width': 1.2, class: 'anchor'});
    c.dataset.m = m; c.style.cursor = 'grab';
    svg.appendChild(c);
  }
}

function attachCurveEvents(svg) {
  const tip = $('#curve-tip');
  let dragM = null;
  const pt = e => {
    const rect = svg.getBoundingClientRect();
    return {x: (e.clientX - rect.left) / rect.width * CV.w,
            y: (e.clientY - rect.top) / rect.height * CV.h};
  };
  svg.addEventListener('mousemove', e => {
    const {x, y} = pt(e);
    if (dragM != null) {
      const yr = yRange();
      const c = Math.max(-yr, Math.min(yr, centsAtY(y)));
      state.locks.set(dragM, Math.round(c * 10) / 10);
      // 拖动中即时重绘锚点, 松开后请求后端
      const a = svg.querySelector(`.anchor[data-m="${dragM}"]`);
      if (a) a.setAttribute('cy', yOf(c));
      tip.style.display = 'none';
      return;
    }
    if (x < CV.L || x > CV.w - CV.R) { tip.style.display = 'none'; return; }
    const m = Math.round(mAtX(x));
    const k = state.result?.keys.find(q => q.m === m);
    if (!k) return;
    tip.style.display = 'block';
    tip.style.left = `${e.clientX + 12}px`;
    tip.style.top = `${e.clientY + 10}px`;
    tip.innerHTML = `<b>${k.name}</b> (MIDI ${m})<br>目标 ${k.f_target.toFixed(2)} Hz, ` +
      `${k.cents >= 0 ? '+' : ''}${k.cents.toFixed(1)}¢` +
      (k.meas_cents != null ? `<br>实测偏离 ${k.meas_cents >= 0 ? '+' : ''}${k.meas_cents.toFixed(1)}¢` : '') +
      `<br><span style="color:#c07be0">点击可锁定/解锁</span>`;
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  svg.addEventListener('mousedown', e => {
    const {x, y} = pt(e);
    const m = Math.round(mAtX(x));
    if (state.locks.has(m)) { dragM = m; return; }
    if (x < CV.L || x > CV.w - CV.R || !state.result) return;
    const k = state.result.keys.find(q => q.m === m);
    state.locks.set(m, k.cents);
    dragM = m;
    renderCurve();
    scheduleAnalyze();
  });
  window.addEventListener('mouseup', () => {
    if (dragM != null) { dragM = null; renderKeyboardLocks(); scheduleAnalyze(); }
  });
  svg.addEventListener('dblclick', e => {
    const {x} = pt(e);
    const m = Math.round(mAtX(x));
    if (state.locks.delete(m)) { renderCurve(); renderKeyboardLocks(); scheduleAnalyze(); }
  });
}

// --------------------------------------------------------------- 键盘

// A0=21 是白键; 统计某键之前的白键数
function whiteIndex(m) {
  let w = 0;
  for (let x = MIDI_MIN; x < m; x++)
    if (![1,3,6,8,10].includes(x % 12)) w++;
  return w
}
const NWHITE = whiteIndex(MIDI_MAX) + 1; // C8 白键

function renderKeyboard() {
  const svg = $('#keyboard');
  svg.innerHTML = '';
  const W = 1100, H = 150, ww = W / NWHITE;
  const bad = new Set();
  if (state.result)
    state.result.conflicts.forEach(c => c.notes.forEach(n => bad.add(n)));
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if ([1,3,6,8,10].includes(m % 12)) continue;
    const wi = whiteIndex(m);
    const r = svgEl('rect', {x: wi * ww, y: 0, width: ww - 0.8, height: H,
      rx: 2, class: 'wn'});
    r.dataset.m = m;
    if (state.locks.has(m)) r.classList.add('locked');
    if (bad.has(m)) r.classList.add('bad');
    r.addEventListener('click', () => onKeyClick(m));
    svg.appendChild(r);
    if (m % 12 === 0 || m === MIDI_MIN) {
      const t = svgEl('text', {x: wi * ww + ww / 2, y: H - 6, class: 'lb'});
      t.textContent = noteName(m);
      svg.appendChild(t);
    }
  }
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (![1,3,6,8,10].includes(m % 12)) continue;
    const wi = whiteIndex(m - 1);
    const r = svgEl('rect', {x: (wi + 1) * ww - ww * 0.32, y: 0,
      width: ww * 0.64, height: H * 0.6, rx: 1.5, class: 'bn'});
    r.dataset.m = m;
    r.addEventListener('click', e => { e.stopPropagation(); onKeyClick(m); });
    svg.appendChild(r);
  }
  renderKeyboardCapSel();
}

function renderKeyboardLocks() {
  $$('#keyboard rect[data-m]').forEach(r => {
    r.classList.toggle('locked', state.locks.has(parseInt(r.dataset.m)) && r.classList.contains('wn'));
  });
}

function highlightKeys(ms, on) {
  ms.forEach(m => {
    const r = document.querySelector(`#keyboard rect[data-m="${m}"]`);
    if (r) r.classList.toggle('playing', on);
  });
}

// --------------------------------------------------------------- 播放/拍频

function keyInfo(m) { return state.result?.keys.find(k => k.m === m); }

// 音程 → 参与拍频的分音序号 [低音分音, 高音分音]
// +5=纯四度(4:3) +7=纯五度(3:2) +12=八度(2:1) +19=十二度(3:1) +24=双八度(4:1)
const PARTIAL_PAIR = {5: [4, 3], 7: [3, 2], 12: [2, 1], 19: [3, 1], 24: [4, 1]};

// 用户点击: 采集选键模式下只切换采集面板的琴键; 同一根音再点 → 停止; 否则播放
function onKeyClick(m) {
  if ($('#cap-pick-mode').checked) {
    window.PianoCapture?.selectKey(m);
    const r = $('#keyboard').getBoundingClientRect();
    document.querySelector('.cap-panel')
      .scrollIntoView({behavior: 'smooth', block: 'nearest'});
    renderKeyboardCapSel();
    return;
  }
  if (!state.result) { toast('请先载入数据并计算'); return; }
  if (state.playing && state.playing.root === m) { stopPlay(); return; }
  startPlay(m);
}

function renderKeyboardCapSel() {
  const on = $('#cap-pick-mode')?.checked;
  const sel = +$('#cap-key')?.value;
  $$('#keyboard rect[data-m]').forEach(r =>
    r.classList.toggle('capsel', on && +r.dataset.m === sel));
}

// 程序化启动/刷新播放 (不触发"同根即停")
function startPlay(m) {
  if (!state.result) return;
  const k = keyInfo(m);
  const up = parseInt($('#interval').value);
  const useP = $('#use-partials').checked;
  stopPlay();

  const hi = keyInfo(m + up);
  const token = ++state.playToken;
  if (!hi) {
    PianoAudio.playOne(k.f_target, k.B, useP);
    state.playing = {root: m, up, raf: 0, token};
    return;
  }

  const [b, p] = PARTIAL_PAIR[up];
  const pb = PianoAudio.playPair(k.f_target, k.B, hi.f_target, hi.B, b, p, useP);

  $('#beat-readout').innerHTML =
    `${k.name}→${hi.name} (${b}:${p}): 匹配分音 ${pb.beatPartialHz.toFixed(1)} Hz, ` +
    `<b>${Math.abs(pb.beatHz).toFixed(2)} Hz</b> 拍频 ` +
    (Math.abs(pb.beatHz) < 0.15 ? '(零拍 ✓)' : pb.beatHz > 0 ? '低音偏高 ↓' : '低音偏低 ↑');

  highlightKeys([m, m + up], true);
  const needle = $('#beat-needle');
  const t0 = performance.now();
  const animate = now => {
    if (!state.playing || state.playing.token !== token) return;
    const ph = (((now - t0) / 1000) * pb.beatHz) % 1;
    needle.style.left = `${50 + Math.sin(ph * 2 * Math.PI) * 46}%`;
    state.playing.raf = requestAnimationFrame(animate);
  };
  state.playing = {root: m, up, raf: requestAnimationFrame(animate), token};
  setTimeout(() => {
    if (state.playing && state.playing.token === token) stopPlay();
  }, pb.durationMs + 200);
}

function stopPlay() {
  if (!state.playing) return;
  const old = state.playing;
  state.playing = null;
  cancelAnimationFrame(old.raf);
  highlightKeys([old.root, old.root + (old.up ?? 0)], false);
  PianoAudio.stop();
  $('#beat-needle').style.left = '50%';
}

$('#use-partials').addEventListener('change', () => {
  if (state.playing) startPlay(state.playing.root);   // 用新参数重启并刷新读数
});
$('#interval').addEventListener('change', () => {
  if (state.playing) startPlay(state.playing.root);
});

// --------------------------------------------------------------- 分析

async function analyze() {
  if (!state.keys.size) { state.result = null; renderCurve(); renderKeyboard(); return; }
  try {
    state.result = await post('/api/analyze', {...buildInput(), cfg: cfg()});
  } catch (e) { toast(e.message, true); return; }
  renderAll();
}
const scheduleAnalyze = debounce(analyze, 250);

function renderAll() {
  renderCurve();
  renderKeyboard();
  renderInputTable();
  renderConflicts();
  $('#lock-count').textContent = state.locks.size;
  window.PianoCapture?.refreshCurrentEffects();
  if (state.playing) startPlay(state.playing.root);  // 参数变了: 用新目标频率重启并刷新拍频
}

$('#btn-clear-locks').addEventListener('click', () => {
  if (!state.locks.size) return;
  state.locks.clear();
  renderAll();
  scheduleAnalyze();
});

function renderConflicts() {
  const ul = $('#conflict-list');
  ul.innerHTML = '';
  const cs = state.result?.conflicts ?? [];
  if (!cs.length) {
    ul.innerHTML = '<li class="muted">无冲突 —— 各约束均在容差内。</li>';
    return;
  }
  for (const c of cs) {
    const li = document.createElement('li');
    li.dataset.type = c.type;
    li.innerHTML = `<b>[${c.type}]</b> ${c.msg}`;
    li.addEventListener('click', () => {
      const m = c.notes[Math.floor(c.notes.length / 2)];
      const rect = $('#curve').getBoundingClientRect();
      const cx = xOf(m) / CV.w * rect.width + rect.left;
      window.scrollTo({top: $('#curve').getBoundingClientRect().top + window.scrollY - 80,
        behavior: 'smooth'});
      flashCurve(c.notes);
      stopPlay();
      if (keyInfo(m + parseInt($('#interval').value))) onKeyClick(m);
    });
    ul.appendChild(li);
  }
}

function flashCurve(notes) {
  notes.forEach(m => {
    const a = document.querySelector(`#curve .anchor[data-m="${m}"]`);
    if (!a) return;
    a.setAttribute('r', 10);
    setTimeout(() => a.setAttribute('r', 6), 500);
  });
}

// 配置控件实时重算
['#strength', '#smooth', '#oct-partial', '#tol-dev', '#tol-beat', '#tol-kink'].forEach(sel =>
  $(sel).addEventListener('input', () => {
    $('#strength-v').textContent = parseFloat($('#strength').value).toFixed(2);
    $('#smooth-v').textContent = parseFloat($('#smooth').value).toFixed(3);
    scheduleAnalyze();
  }));
$$('input[name=rule]').forEach(r => r.addEventListener('change', scheduleAnalyze));
$$('input[name=extension]').forEach(r => r.addEventListener('change', scheduleAnalyze));
$('#a4').addEventListener('input', scheduleAnalyze);

$('#btn-analyze').addEventListener('click', analyze);

// --------------------------------------------------------------- 候选方案

$('#btn-candidates').addEventListener('click', async () => {
  if (!state.keys.size) return toast('请先载入实测数据', true);
  const cands = await post('/api/candidates', buildInput());
  renderCandidates(cands);
});

function renderCandidates(cands) {
  const tb = $('#cand-table tbody');
  tb.innerHTML = '';
  const key = $('#cand-sort').value;
  // 三项指标均为"误差量", 越小越好 → 升序; composite 为收益分, 降序
  cands.sort((a, b) => key === 'composite'
    ? composite(b.score) - composite(a.score)
    : a.score[key] - b.score[key]);
  for (const c of cands) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="text-align:left">${c.name}</td>
      <td>${c.score.max_beat.toFixed(3)}</td>
      <td>${c.score.smooth.toFixed(3)}</td>
      <td>${c.score.lock_change.toFixed(1)}</td>
      <td>${c.n_conflicts}</td><td></td>`;
    const btn = document.createElement('button');
    btn.className = 'ghost'; btn.textContent = '应用';
    btn.addEventListener('click', () => {
      applyCfg(c.cfg);
      toast(`已应用: ${c.name}`);
      analyze();
    });
    tr.lastElementChild.appendChild(btn);
    tb.appendChild(tr);
  }
}
// 综合"越好分越高": 归一化打分
function composite(s) {
  return -(s.max_beat * 1.0 + s.smooth * 2.0 + s.lock_change * 0.05);
}
$('#cand-sort').addEventListener('change', () => {
  if ($('#cand-table tbody').rows.length) $('#btn-candidates').click();
});

function applyCfg(c) {
  $$('input[name=rule]').forEach(r => r.checked = r.value === c.rule);
  $$('input[name=extension]').forEach(r => r.checked = r.value === c.extension);
  $('#oct-partial').value = c.oct_partial;
  $('#strength').value = c.strength;
  $('#strength-v').textContent = c.strength.toFixed(2);
}

// --------------------------------------------------------------- 会话/版本

async function loadSessionList() {
  const rs = await (await fetch('/api/sessions')).json();
  const sel = $('#sel-sessions');
  sel.innerHTML = '<option value="">打开会话…</option>' +
    rs.map(r => `<option value="${r.id}">${r.id}. ${r.name || '未命名'}</option>`).join('');
}

$('#btn-save-session').addEventListener('click', async () => {
  const sid = (await post('/api/sessions', {id: state.sessionId,
    name: $('#piano-name').value, input: buildInput()})).id;
  state.sessionId = sid;
  // 服务端在 UPDATE 时保留旧 scheme 行; 以当前内存中的版本为准全量重写
  const old = await (await fetch(`/api/sessions/${sid}`)).json();
  for (const id of (old.schemes || []).map(s => s.id))
    await fetch(`/api/schemes/${id}`, {method: 'DELETE'});
  for (const s of state.schemes) {
    await post('/api/schemes', {session_id: sid, name: s.name, cfg: s.cfg,
      result: s.result, locked_count: state.locks.size});
  }
  toast(`会话已保存 (#${sid})`);
  loadSessionList();
});

$('#sel-sessions').addEventListener('change', async e => {
  const sid = parseInt(e.target.value);
  if (!sid) return;
  const s = await (await fetch(`/api/sessions/${sid}`)).json();
  hydrate(s);
});

function hydrate(s) {
  state.sessionId = s.id;
  $('#piano-name').value = s.name || '';
  const inp = s.input;
  $('#a4').value = inp.a4;
  state.keys = new Map((inp.keys || []).map(k =>
    [k.m, {
      measures: Object.fromEntries(Object.entries(k.measures || {}).map(([n, v]) => [+n, v])),
      captures: (k.captures || []).map(c => ({...c, use: c.use || {}, _buf: null})),
    }]));
  state.locks = new Map((inp.locks || []).map(l => [l.m, l.cents]));
  state.pweights = Object.fromEntries(Object.entries(inp.pweights || {}).map(([n, v]) => [+n, +v]));
  state.schemes = (s.schemes || []).map(x => ({
    id: x.id, name: x.name, cfg: x.cfg, result: x.result}));
  renderWeights();
  renderInputTable();
  renderSchemeList();
  window.PianoCapture?.selectKey(+($('#cap-key')?.value || A4));
  analyze();
}

$('#btn-commit').addEventListener('click', () => {
  if (!state.result) return toast('请先计算', true);
  const name = $('#scheme-name').value || `v${state.schemes.length + 1}`;
  const sc = {id: Date.now(), name, cfg: cfg(), result: state.result};
  state.schemes.push(sc);
  state.compareId = sc.id;
  renderSchemeList();
  renderCurve();
  toast(`版本「${name}」已保留`);
});

function renderSchemeList() {
  const ul = $('#scheme-list');
  if (!state.schemes.length) { ul.innerHTML = '<li class="muted">尚无版本。</li>'; return; }
  ul.innerHTML = '';
  for (const s of state.schemes) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${s.name}</b>`;
    const mkBtn = (txt, fn, cls = '') => {
      const b = document.createElement('button');
      b.className = 'ghost ' + cls; b.textContent = txt; b.addEventListener('click', fn);
      return b;
    };
    li.appendChild(mkBtn('对比叠加', () => {
      state.compareId = state.compareId === s.id ? null : s.id;
      renderCurve();
    }));
    li.appendChild(mkBtn('应用其参数', () => { applyCfg(s.cfg); analyze(); }));
    li.appendChild(mkBtn('删除', () => {
      state.schemes = state.schemes.filter(x => x !== s);
      if (state.compareId === s.id) state.compareId = null;
      renderSchemeList(); renderCurve();
    }));
    ul.appendChild(li);
  }
}

// --------------------------------------------------------------- 检查卡

$('#btn-checkcard').addEventListener('click', async () => {
  if (!state.keys.size) return toast('请先计算', true);
  const r = await post('/api/checkcard', {...buildInput(), cfg: cfg()});
  renderCheckCard(r.cards);
});

function renderCheckCard(cards) {
  const box = $('#checkcard');
  box.classList.remove('hidden');
  const off = cards.filter(c => c.meas_cents != null && Math.abs(c.meas_cents) > 5);
  box.innerHTML = `<p class="hint">按调律顺序排列共 ${cards.length} 张；` +
    `${off.length} 张当前实测偏离 &gt;5¢ (红色标出)。先调平均律区, 再按八度族推进。</p><div class="cc-grid">` +
    cards.map(c => `<div class="cc ${c.locked ? 'locked' : ''}">
      <div class="cc-h"><span>${c.order}. ${c.name}${c.locked ? ' 🔒' : ''}</span>
        <span>${c.cents >= 0 ? '+' : ''}${c.cents.toFixed(1)}¢</span></div>
      <div class="cc-f">目标 ${c.f_target.toFixed(2)} Hz</div>
      ${c.f_meas ? `<div class="${Math.abs(c.meas_cents) > 5 ? 'off' : ''}">实测偏离 ${c.meas_cents >= 0 ? '+' : ''}${c.meas_cents.toFixed(1)}¢</div>` : ''}
      <table>${c.checks.map(k => `<tr><td>${k.name}→${k.note_hi}</td>
        <td>${k.f_hi_target.toFixed(1)} Hz</td>
        <td>${Math.abs(k.beat).toFixed(2)} 拍/秒</td></tr>`).join('')}</table>
    </div>`).join('') + '</div>';
  box.scrollIntoView({behavior: 'smooth'});
}

// --------------------------------------------------------------- 示范数据 / 启动

$('#btn-demo').addEventListener('click', async () => {
  const d = await (await fetch(`/api/demo?a4=${$('#a4').value || 440}`)).json();
  $('#piano-name').value = d.name;
  state.keys = new Map(d.keys.map(k =>
    [k.m, {measures: Object.fromEntries(Object.entries(k.measures).map(([n, v]) => [+n, v])),
           captures: []}]));
  state.locks = new Map();
  state.schemes = []; state.compareId = null; state.sessionId = null;
  renderSchemeList();
  renderInputTable();
  toast(d.note);
  analyze();
});

renderWeights();
renderInputTable();
renderCurve();
renderKeyboard();
attachCurveEvents($('#curve'));
loadSessionList();

$('#cap-pick-mode').addEventListener('change', renderKeyboardCapSel);
