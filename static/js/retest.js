/* 音准稳定性复测工作区: 键盘热图 × 时间曲线联动, 异常识别定位, 回调清单。
 * 依赖 app.js (toast/采集状态) 与 capture.js (takeMedian/goCapture)。 */
(function () {
  const MIDI_MIN = 21, MIDI_MAX = 108;
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const noteName = m => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const $ = s => document.querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const BLACKS = [1, 3, 6, 8, 10];
  const W = 1100, HH = 120;                 // 热图
  const CW = 1100, CH = 240;                // 时间曲线
  const INTERVALS = [[12, '八度'], [19, '十二度'], [24, '双八度']];

  const rt = {
    list: [], data: null, cur: null,
    viewRound: null,              // 热图当前查看的复测轮 id
    anom: null,                   // 选中的异常
    onlyCore: false,
  };

  function whiteIndex(m) {
    let w = 0;
    for (let x = MIDI_MIN; x < m; x++) if (!BLACKS.includes(x % 12)) w++;
    return w;
  }
  const NWHITE = whiteIndex(MIDI_MAX) + 1;
  const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const fmtC = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}¢`;
  const fmtF = v => v == null ? '—' : v.toFixed(2);
  const fmtT = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN',
    {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}) : '—';
  const fmtEnv = r => r && r.temp != null
    ? `${r.temp}°C / ${r.humidity ?? '—'}%` : '—';

  async function api(method, url, body) {
    const r = await fetch(url, {method,
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined});
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const toast = (m, bad) => window.PianoApp?.toast?.(m, bad);
  const STATUS = {pending: '待复测', collecting: '采集中', confirmed: '已确认'};
  const KIND = {region: '同音区成片漂移', sudden: '单键突变',
                persistent: '持续偏移', restabilize: '回稳'};

  const byM = () => Object.fromEntries(rt.data.keys.map(k => [k.m, k]));
  const viewRoundId = () => rt.viewRound ?? rt.data?.view_round ?? null;
  const roundById = id => rt.data?.rounds.find(r => r.id === id);

  // --------------------------------------------------------------- 档案列表/建立

  async function loadList() {
    rt.list = await api('GET', '/api/retests');
    const sel = $('#rt-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">选择复测档案…</option>' + rt.list.map(r =>
      `<option value="${r.id}" ${r.id == cur ? 'selected' : ''}>${r.id}. ${r.name} · ` +
      `${STATUS[r.status] || r.status} · ${r.n_finished}/${r.n_rounds}轮</option>`).join('');
  }

  async function newDialog() {
    const jobs = await api('GET', '/api/jobs');
    const frozen = jobs.filter(j => j.phase === 'frozen');
    if (!frozen.length)
      return toast('⑨ 中尚无已冻结的调律作业, 请先完成并冻结一份作业', true);
    const lines = frozen.map((j, i) =>
      `${i + 1}. ${j.name} (作业 #${j.id})`).join('\n');
    const pick = prompt(`从哪份已冻结作业建立复测档案? 输入序号:\n${lines}`, '1');
    if (pick == null) return;
    const j = frozen[parseInt(pick) - 1];
    if (!j) return toast('序号无效', true);
    const tol = parseFloat(prompt('漂移容差 (音分)', '3'));
    if (!(tol > 0)) return;
    const r = await api('POST', '/api/retests', {job_id: j.id, tol_cents: tol});
    await loadList();
    $('#rt-select').value = r.id;
    await open(r.id);
    toast('档案已建立 (待复测) — 请先添加静置后的复测时点');
  }

  async function open(id) {
    if (!id) {
      rt.data = null;
      $('#rt-body').classList.add('hidden');
      $('#rt-empty').classList.remove('hidden');
      return;
    }
    rt.data = await api('GET', `/api/retests/${id}`);
    rt.viewRound = rt.data.view_round;
    rt.anom = null;
    rt.cur = rt.data.keys.find(k => k.latest)?.m ?? 69;
    $('#rt-empty').classList.add('hidden');
    $('#rt-body').classList.remove('hidden');
    render();
  }

  // --------------------------------------------------------------- 热图

  // 漂移 → 颜色: 蓝(偏低) ↔ 中性 ↔ 红(偏高); 未测为灰
  function driftColor(d, black) {
    if (d == null) return black ? '#1c2129' : '#3a414c';
    const tol = rt.data.retest.tol_cents;
    const t = Math.max(2 * tol, 4);
    const x = Math.max(-1, Math.min(1, d / t));
    const base = black ? [40, 45, 55] : [232, 230, 223];
    const c = x >= 0 ? [208, 72, 50] : [56, 110, 200];
    const a = Math.abs(x);
    const mix = base.map((b, i) => Math.round(b + (c[i] - b) * a));
    return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
  }

  function driftOf(k, rid) {
    const s = k.series.find(x => x && x.round_id === rid);
    return s ? s.drift : null;
  }

  function renderHeatmap() {
    const svg = $('#rt-heatmap');
    svg.innerHTML = '';
    const d = rt.data, rid = viewRoundId();
    const km = byM();
    const anomKeys = new Set(rt.anom ? rt.anom.keys : []);
    const ww = W / NWHITE;
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      if (BLACKS.includes(m % 12)) continue;
      const k = km[m], wi = whiteIndex(m);
      const r = svgEl('rect', {x: wi * ww, y: 0, width: ww - 0.8, height: HH, rx: 2,
        fill: driftColor(rid ? driftOf(k, rid) : null, false),
        class: 'rkw' + (rt.cur === m ? ' cur' : '') +
               (k.locked ? ' locked' : '') + (anomKeys.has(m) ? ' anom' : '')});
      r.dataset.m = m;
      r.addEventListener('click', () => selectKey(m));
      svg.appendChild(r);
      if (m % 12 === 0 || m === MIDI_MIN) {
        const t = svgEl('text', {x: wi * ww + ww / 2, y: HH - 6});
        t.textContent = noteName(m);
        svg.appendChild(t);
      }
    }
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      if (!BLACKS.includes(m % 12)) continue;
      const k = km[m], wi = whiteIndex(m - 1);
      const r = svgEl('rect', {x: (wi + 1) * ww - ww * 0.32, y: 0,
        width: ww * 0.64, height: HH * 0.6, rx: 1.5,
        fill: driftColor(rid ? driftOf(k, rid) : null, true),
        class: 'rkb' + (rt.cur === m ? ' cur' : '') +
               (k.locked ? ' locked' : '') + (anomKeys.has(m) ? ' anom' : '')});
      r.dataset.m = m;
      r.addEventListener('click', e => { e.stopPropagation(); selectKey(m); });
      svg.appendChild(r);
    }
    const vr = roundById(rid);
    $('#rt-view-cap').textContent = vr
      ? `热图: 第${vr.idx}轮 ${vr.label} · 相对完工值漂移 (完工基线 = ${d.retest.job_name})`
      : '热图: 尚无测值 — 开始复测轮并录入 88 键';
  }

  // --------------------------------------------------------------- 时间曲线

  function renderCurve() {
    const svg = $('#rt-curve');
    svg.innerHTML = '';
    const d = rt.data;
    const rounds = d.rounds;
    const L = 46, R = 14, T = 14, B = 46;
    const n = rounds.length + 1;                       // 列: 完工 + 各轮
    const xOf = i => n === 1 ? (L + CW - R) / 2
                             : L + i / (n - 1) * (CW - L - R);
    const tol = d.retest.tol_cents;
    let mx = Math.max(2.5 * tol, 4);
    for (const k of d.keys)
      for (const s of k.series)
        if (s) mx = Math.max(mx, Math.abs(s.drift) * 1.15);
    const yOf = c => T + (1 - (c + mx) / (2 * mx)) * (CH - T - B);

    // 容差带 + 网格
    svg.appendChild(svgEl('rect', {x: L, y: yOf(tol), width: CW - L - R,
      height: yOf(-tol) - yOf(tol), fill: 'rgba(110,192,122,.07)'}));
    for (let c = Math.ceil(-mx / 5) * 5; c <= mx; c += 5) {
      svg.appendChild(svgEl('line', {x1: L, x2: CW - R, y1: yOf(c), y2: yOf(c),
        stroke: c === 0 ? '#3a4656' : '#222a35', 'stroke-width': 1}));
      const t = svgEl('text', {x: 6, y: yOf(c) + 4, fill: '#7d8898', 'font-size': 10});
      t.textContent = `${c > 0 ? '+' : ''}${c}`;
      svg.appendChild(t);
    }
    for (const c of [tol, -tol]) {
      svg.appendChild(svgEl('line', {x1: L, x2: CW - R, y1: yOf(c), y2: yOf(c),
        stroke: '#6ec07a', 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: .6}));
    }

    // 列标题 (完工 / 各轮): 点击切换热图轮次; 查看中的列加底纹
    const vid = viewRoundId();
    for (let i = 0; i < n; i++) {
      const r = i === 0 ? null : rounds[i - 1];
      const viewing = r && r.id === vid;
      if (viewing)
        svg.appendChild(svgEl('rect', {x: xOf(i) - 26, y: T - 6, width: 52,
          height: CH - T - B + 12, fill: 'rgba(90,176,232,.07)', rx: 4}));
      const t = svgEl('text', {x: xOf(i), y: CH - 30, fill: viewing ? '#5ab0e8' : '#9aa5b5',
        'font-size': 10.5, 'text-anchor': 'middle', class: 'rtick'});
      t.textContent = r ? `#${r.idx} ${r.label}` : '完工';
      if (r) {
        t.style.cursor = 'pointer';
        t.addEventListener('click', () => setViewRound(r.id));
      }
      svg.appendChild(t);
      if (r) {
        const e = svgEl('text', {x: xOf(i), y: CH - 17, fill: '#6b7686',
          'font-size': 9, 'text-anchor': 'middle'});
        e.textContent = r.temp != null ? `${r.temp}°C ${r.humidity ?? '—'}%`
                                       : (r.started ? '环境未记' : '');
        svg.appendChild(e);
        const s = svgEl('text', {x: xOf(i), y: CH - 6, fill: '#556070',
          'font-size': 8.5, 'text-anchor': 'middle'});
        s.textContent = r.finished ? fmtT(r.finished)
          : r.started ? '采集中' : (r.planned_ts ? `计划 ${fmtT(r.planned_ts)}` : '计划中');
        svg.appendChild(s);
      }
    }

    if (!rounds.length) {
      const t = svgEl('text', {x: (L + CW - R) / 2, y: CH / 2, fill: '#556070',
        'font-size': 12, 'text-anchor': 'middle'});
      t.textContent = '尚无复测时点 — 用上方「+ 复测时点」添加';
      svg.appendChild(t);
      return;
    }

    // 数据线: 完工点为 0, 各轮为相对完工漂移
    const km = byM();
    const line = (k, color, width, opacity, dotR) => {
      const pts = [[0, 0]];
      rounds.forEach((r, i) => {
        const s = k.series[i];
        if (s) pts.push([i + 1, s.drift]);
      });
      if (pts.length < 2) return;
      const path = pts.map((p, i) =>
        `${i ? 'L' : 'M'}${xOf(p[0])},${yOf(p[1])}`).join('');
      svg.appendChild(svgEl('path', {d: path, fill: 'none', stroke: color,
        'stroke-width': width, opacity}));
      for (const p of pts)
        svg.appendChild(svgEl('circle', {cx: xOf(p[0]), cy: yOf(p[1]), r: dotR,
          fill: color, opacity}));
    };

    const anomKeys = new Set(rt.anom ? rt.anom.keys : []);
    // 异常键 (非选中) 淡红细线
    if (rt.anom)
      for (const m of rt.anom.keys)
        if (m !== rt.cur && km[m]) line(km[m], '#e0634e', 1, .45, 1.6);
    // 关联键 (八度/十二度/双八度对键) 细线
    const partners = new Set();
    for (const [up] of INTERVALS)
      for (const am of [rt.cur - up, rt.cur + up])
        if (am >= MIDI_MIN && am <= MIDI_MAX && am !== rt.cur) partners.add(am);
    for (const m of partners)
      if (!anomKeys.has(m) || m === rt.cur) line(km[m], '#5ab0e8', 1, .5, 1.6);
    // 选中键主线
    if (km[rt.cur]) line(km[rt.cur], '#e0a84e', 2.4, 1, 3);
  }

  function setViewRound(rid) {
    rt.viewRound = rid;
    renderRounds();
    renderHeatmap();
    renderCurve();
    renderKeyCard();
  }

  // --------------------------------------------------------------- 复测轮次

  function renderRounds() {
    const d = rt.data, box = $('#rt-rounds');
    box.innerHTML = '';
    if (!d.rounds.length) {
      box.innerHTML = '<span class="hint">尚无复测时点 — 用上方「+ 复测时点」添加静置后的复测计划。</span>';
      return;
    }
    const confirmed = d.retest.status === 'confirmed';
    const hasActive = !!d.active_round;
    for (const r of d.rounds) {
      const chip = document.createElement('div');
      const st = r.finished ? 'done' : r.started ? 'active' : 'plan';
      chip.className = `rt-chip ${st}` + (viewRoundId() === r.id ? ' view' : '');
      const stName = {done: '已完成', active: '采集中', plan: '计划中'}[st];
      const head = document.createElement('div');
      head.className = 'rh';
      head.innerHTML = `<span>#${r.idx} ${r.label}</span><span class="st">${stName}</span>`;
      chip.appendChild(head);
      const meta = document.createElement('div');
      meta.className = 'rmeta';
      meta.textContent =
        (r.planned_ts ? `计划 ${fmtT(r.planned_ts)} · ` : '') +
        (r.finished ? `完成 ${fmtT(r.finished)}` :
         r.started ? `开始 ${fmtT(r.started)}` : '未开始') +
        ` · ${r.n_meas}/88`;
      chip.appendChild(meta);

      if (st === 'active') {
        const env = document.createElement('div');
        env.className = 'renv';
        env.innerHTML = `<label>室温<input type="number" step="0.5" data-env="temp"
            value="${r.temp ?? ''}" placeholder="°C"></label>
          <label>湿度<input type="number" step="1" data-env="humidity"
            value="${r.humidity ?? ''}" placeholder="%"></label>`;
        chip.appendChild(env);
        const btn = document.createElement('button');
        btn.textContent = '完成本轮';
        btn.disabled = r.n_meas < 88;
        btn.title = r.n_meas < 88 ? `还有 ${88 - r.n_meas} 键未测` : '结束本轮采集';
        btn.addEventListener('click', e => { e.stopPropagation(); finishRound(r); });
        chip.appendChild(btn);
        env.querySelectorAll('input').forEach(inp =>
          inp.addEventListener('change', () => saveEnv()));
        env.addEventListener('click', e => e.stopPropagation());
      } else if (st === 'plan' && !confirmed) {
        const row = document.createElement('div');
        row.className = 'renv';
        const go = document.createElement('button');
        go.textContent = '开始本轮';
        go.disabled = hasActive;
        go.title = hasActive ? '已有进行中的复测轮' : '进入本轮采集';
        go.addEventListener('click', e => { e.stopPropagation(); activate(r); });
        const del = document.createElement('button');
        del.className = 'ghost';
        del.textContent = '✕';
        del.title = '删除该时点';
        del.addEventListener('click', e => { e.stopPropagation(); delRound(r); });
        row.append(go, del);
        chip.appendChild(row);
      } else if (st === 'done') {
        const env = document.createElement('div');
        env.className = 'rmeta';
        env.textContent = `环境 ${fmtEnv(r)}`;
        chip.appendChild(env);
      }
      chip.addEventListener('click', () => setViewRound(r.id));
      box.appendChild(chip);
    }
  }

  async function addRound() {
    const label = $('#rt-label').value.trim();
    const pv = $('#rt-planned').value;
    const planned_ts = pv ? new Date(pv).getTime() / 1000 : null;
    rt.data = await api('POST', `/api/retests/${rt.data.retest.id}/rounds`,
      {label: label || null, planned_ts});
    $('#rt-label').value = '';
    $('#rt-planned').value = '';
    render();
    toast('复测时点已添加');
  }

  async function delRound(r) {
    rt.data = await api('DELETE',
      `/api/retests/${rt.data.retest.id}/rounds/${r.id}`);
    if (rt.viewRound === r.id) rt.viewRound = rt.data.view_round;
    render();
  }

  async function activate(r) {
    const t = prompt('本轮室温 (°C)', '22');
    if (t === null) return;
    const h = prompt('本轮湿度 (%)', '50');
    if (h === null) return;
    const temp = parseFloat(t), humidity = parseFloat(h);
    rt.data = await api('POST', `/api/retests/${rt.data.retest.id}/activate`,
      {round_id: r.id,
       temp: Number.isFinite(temp) ? temp : null,
       humidity: Number.isFinite(humidity) ? humidity : null});
    rt.viewRound = rt.data.active_round;
    render();
    toast(`第${r.idx}轮 ${r.label} 开始采集 — 逐键录入 88 键频率`);
  }

  async function saveEnv() {
    const box = $('#rt-rounds .rt-chip.active');
    if (!box) return;
    const temp = parseFloat(box.querySelector('[data-env=temp]').value);
    const humidity = parseFloat(box.querySelector('[data-env=humidity]').value);
    rt.data = await api('POST', `/api/retests/${rt.data.retest.id}/env`,
      {temp: Number.isFinite(temp) ? temp : null,
       humidity: Number.isFinite(humidity) ? humidity : null});
    renderRounds();
    renderCurve();
    toast('本轮环境已记录');
  }

  async function finishRound(r) {
    if (r.temp == null || r.humidity == null) {
      if (!confirm('本轮尚未记录室温/湿度, 仍要完成本轮?')) return;
    }
    rt.data = await api('POST', `/api/retests/${rt.data.retest.id}/finish`);
    rt.viewRound = rt.data.view_round;
    render();
    toast(`第${r.idx}轮已完成 — 可查看漂移与异常识别`);
  }

  // --------------------------------------------------------------- 键卡

  function selectKey(m) {
    rt.cur = m;
    renderHeatmap();
    renderCurve();
    renderKeyCard();
  }

  function liveDrift() {
    const d = rt.data, k = byM()[rt.cur];
    const f = parseFloat($('#rkc-f').value);
    const el = $('#rkc-live');
    if (!k || !(f > 0)) { el.textContent = '漂移 —'; el.className = 'rk-live'; return; }
    const c = 1200 * Math.log2(f / k.f_base);
    const over = Math.abs(c) > d.retest.tol_cents;
    el.textContent = `相对完工 ${fmtC(c)} (容差 ±${d.retest.tol_cents}¢)`;
    el.className = 'rk-live ' + (over ? 'bad' : 'ok');
  }

  function renderKeyCard() {
    const d = rt.data, k = byM()[rt.cur];
    const box = $('#rt-keycard');
    if (!k) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const confirmed = d.retest.status === 'confirmed';
    $('#rkc-name').textContent = k.name;
    $('#rkc-sub').textContent =
      `MIDI ${k.m} · 完工基线 ${fmtF(k.f_base)} Hz · 目标 ${fmtF(k.f_target)} Hz ` +
      `(${fmtC(k.target_cents)})`;

    // 各轮测值表
    const rows = [];
    rows.push(`<tr><th>轮次</th><th>f₁ (Hz)</th><th>相对完工</th><th>相邻漂移</th><th>环境</th><th>时间</th></tr>`);
    rows.push(`<tr><td>完工</td><td>${fmtF(k.f_base)}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`);
    d.rounds.forEach((r, i) => {
      const s = k.series[i];
      const cls = r.id === viewRoundId() ? ' class="viewrow"' : '';
      if (!s) {
        rows.push(`<tr${cls}><td>#${r.idx} ${r.label}</td><td colspan="5" class="muted">未测</td></tr>`);
        return;
      }
      const bad = Math.abs(s.drift) > d.retest.tol_cents;
      rows.push(`<tr${cls}><td>#${r.idx} ${r.label}</td><td>${fmtF(s.f)}</td>
        <td class="${bad ? 'bad' : ''}">${fmtC(s.drift)}</td>
        <td>${fmtC(s.delta)}</td><td>${fmtEnv(r)}</td><td>${fmtT(s.ts)}</td></tr>`);
    });
    $('#rkc-series').innerHTML = `<table>${rows.join('')}</table>`;

    // 查看轮的音程拍频 (两端实测)
    const vid = viewRoundId();
    const pairs = (vid && d.beats[vid]) || [];
    const mine = pairs.filter(p => p.lo === rt.cur || p.hi === rt.cur);
    $('#rkc-beats').innerHTML = mine.length
      ? '<table><tr><th>音程</th><th>对键</th><th>实测拍频</th><th>音分</th><th>限(Hz)</th><th></th></tr>' +
        mine.map(p => {
          const other = p.lo === rt.cur ? p.hi : p.lo;
          return `<tr class="${p.over ? 'over' : ''}"><td>${p.name}</td>
            <td>${noteName(other)}</td><td>${p.beat.toFixed(2)} Hz</td>
            <td>${p.beat_cents.toFixed(1)}¢</td><td>${p.limit.toFixed(2)}</td>
            <td>${p.over ? '<b class="bad">越限</b>' : '✓'}</td></tr>`;
        }).join('') + '</table>'
      : '<span class="hint">当前查看轮无该键的八度/十二度/双八度实测拍频。</span>';

    const lockBtn = $('#btn-rkc-lock');
    lockBtn.textContent = k.locked ? '🔓 解锁' : '🔒 锁定免调';
    lockBtn.classList.toggle('on', k.locked);
    lockBtn.disabled = confirmed;

    const canMeas = d.retest.status === 'collecting' && !!d.active_round;
    $('#rkc-input').style.display = canMeas ? '' : 'none';
    const act = d.active_round && d.rounds.find(r => r.id === d.active_round);
    $('#btn-rkc-send').textContent = act ? `记录到第${act.idx}轮` : '记录到本轮';
    const cur = act && k.series.find(s => s && s.round_id === act.id);
    $('#rkc-f').value = cur ? cur.f.toFixed(3) : '';
    liveDrift();
  }

  async function sendMeasure() {
    const d = rt.data, m = rt.cur;
    const f = parseFloat($('#rkc-f').value);
    if (!(f > 0)) return toast('请输入有效频率', true);
    rt.data = await api('POST', `/api/retests/${d.retest.id}/measure`,
      {m, f_meas: f});
    // 跳到本轮下一个未测键 (MIDI 顺序, 循环)
    const act = rt.data.active_round;
    if (act) {
      const un = rt.data.keys.filter(k =>
        !k.series.some(s => s && s.round_id === act));
      const after = un.filter(k => k.m > m);
      rt.cur = (after[0] || un[0] || {m}).m;
    }
    render();
    const k = byM()[m];
    const s = k.series.find(x => x && x.round_id === act);
    toast(`${noteName(m)} 已记录: 相对完工 ${fmtC(s ? s.drift : null)}`);
  }

  async function toggleLock() {
    const k = byM()[rt.cur];
    rt.data = await api('POST', `/api/retests/${rt.data.retest.id}/lock`,
      {m: rt.cur, locked: !k.locked});
    render();
    toast(k.locked ? `${k.name} 已解锁` : `${k.name} 已锁定为无需调整`);
  }

  function bringCapture() {
    const m = rt.cur;
    const f1 = window.PianoCapture?.takeMedian?.(m);
    if (f1 == null)
      return toast(`${noteName(m)} 尚无合格采集结果, 可到 ② 录制或手工录入`, true);
    $('#rkc-f').value = f1.toFixed(3);
    liveDrift();
    toast(`已带入 ${noteName(m)} 采集中位数 ${f1.toFixed(2)} Hz`);
  }

  // --------------------------------------------------------------- 异常定位

  function anomSummary(a) {
    const nm = a.keys.map(noteName);
    const span = a.keys.length > 2 ? `${nm[0]}~${nm[nm.length - 1]}` : nm.join('、');
    const x = a.data;
    switch (a.kind) {
      case 'region':
        return `${span} 共${x.n}键 同向${x.direction === 'sharp' ? '偏高' : '偏低'} ` +
               `均值 ${fmtC(x.mean)}`;
      case 'sudden':
        return `${span} 相邻复测突变 ` +
               Object.values(x.deltas).map(fmtC).join('、');
      case 'persistent':
        return `${span} 连续${x.rounds}轮${x.direction === 'sharp' ? '偏高' : '偏低'} ` +
               `现 ${fmtC(x.mean_latest)}`;
      case 'restabilize':
        return `${span} 曾 ${fmtC(x.worst)} (第${x.worst_idx}轮), 现已回稳`;
    }
    return span;
  }

  function renderAnoms() {
    const d = rt.data;
    const ul = $('#rt-anoms');
    $('#rt-anom-n').textContent = d.anomalies.length ? `${d.anomalies.length} 项` : '';
    ul.innerHTML = d.anomalies.length ? '' : '<li class="muted">当前未发现异常</li>';
    for (const a of d.anomalies) {
      const li = document.createElement('li');
      li.dataset.kind = a.kind;
      if (rt.anom?.id === a.id) li.classList.add('sel');
      li.innerHTML = `<b>[${KIND[a.kind]}]</b> <i>第${a.round_idx}轮</i>` +
        `<span class="asub"></span>`;
      li.querySelector('.asub').textContent = anomSummary(a);
      li.addEventListener('click', () => {
        rt.anom = rt.anom?.id === a.id ? null : a;
        if (rt.anom) {
          rt.viewRound = a.round_id;
          if (!a.keys.includes(rt.cur)) rt.cur = a.keys[0];
        }
        render();
      });
      ul.appendChild(li);
    }
  }

  function renderAnomDetail() {
    const a = rt.anom, box = $('#rt-anom-detail');
    if (!a) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const km = byM();
    const env = a.env;
    const envLine = [
      `本轮 ${env.cur.temp ?? '—'}°C / ${env.cur.humidity ?? '—'}%`,
      env.prev.temp != null
        ? `上轮 ${env.prev.temp}°C / ${env.prev.humidity ?? '—'}%` +
          (env.d_temp != null
            ? ` (Δ${env.d_temp > 0 ? '+' : ''}${env.d_temp.toFixed(1)}°C, ` +
              `Δ${env.d_humidity > 0 ? '+' : ''}${env.d_humidity?.toFixed(0) ?? '—'}%)`
            : '')
        : '无上轮环境 (对照完工基线)',
    ].join(' · ');
    box.innerHTML = `
      <div><b>[${KIND[a.kind]}]</b> 第${a.round_idx}轮 ${a.round_label}</div>
      <div class="hint">相关琴键 (点击定位):</div>
      <div class="kchips">${a.keys.map(m =>
        `<b data-m="${m}">${noteName(m)}${km[m]?.locked ? '🔒' : ''}</b>`).join('')}</div>
      <div class="hint">环境变化: ${envLine}</div>
      ${a.intervals.length
        ? `<div class="hint">受影响音程 (点击查看):</div><table>` +
          a.intervals.map(iv =>
            `<tr data-lo="${iv.lo}"><td>${iv.name}</td>
             <td>${noteName(iv.lo)}–${noteName(iv.hi)}</td>
             <td>${iv.beat.toFixed(2)} Hz / ${iv.beat_cents.toFixed(1)}¢</td>
             <td>限 ${iv.limit.toFixed(2)}</td></tr>`).join('') + '</table>'
        : '<div class="hint">受影响音程: 无越限音程</div>'}`;
    box.querySelectorAll('.kchips b').forEach(b =>
      b.addEventListener('click', () => selectKey(+b.dataset.m)));
    box.querySelectorAll('tr[data-lo]').forEach(tr =>
      tr.addEventListener('click', () => selectKey(+tr.dataset.lo)));
  }

  // --------------------------------------------------------------- 回调清单

  function renderRetune() {
    const d = rt.data;
    const coreN = d.retune.filter(e => e.kind === 'core').length;
    $('#rt-retune-n').textContent = d.retune.length
      ? `${coreN} 待回调 · ${d.retune.length - coreN} 关联` : '';
    const ul = $('#rt-retune');
    const list = d.retune.filter(e => !rt.onlyCore || e.kind === 'core');
    ul.innerHTML = list.length ? '' :
      `<li class="muted">${d.retune.length ? '无待回调键' : '全部键均在容差内'}</li>`;
    for (const e of list) {
      const li = document.createElement('li');
      li.className = (e.kind === 'related' ? 'rel ' : '') +
                     (rt.cur === e.m ? 'cur' : '');
      const adj = e.adjust != null ? `回调 ${fmtC(e.adjust)}` : '';
      li.innerHTML = `<span class="ro">${e.order}</span><b>${e.name}</b>` +
        `<span class="tag">${e.kind === 'core' ? '待回调' : '关联'}</span>` +
        `<i>${e.drift != null ? fmtC(e.drift) : '未测'} ${adj}</i>` +
        `<span class="tag">${e.reasons.join('/')}</span>`;
      li.addEventListener('click', () => selectKey(e.m));
      ul.appendChild(li);
    }
  }

  function retuneText() {
    const d = rt.data;
    const lines = [
      `回调清单 · ${d.retest.name} · 容差 ±${d.retest.tol_cents}¢`,
      `基准: ${d.retest.job_name} 完工值 · 生成于 ${new Date().toLocaleString('zh-CN')}`,
      '',
    ];
    for (const e of d.retune) {
      lines.push(
        `${String(e.order).padStart(2)}. ${e.name}\t` +
        `${e.kind === 'core' ? '待回调' : '关联核对'}\t` +
        (e.drift != null ? `漂移 ${fmtC(e.drift)}` : '未测') +
        (e.adjust != null ? ` → 回调 ${fmtC(e.adjust)}` : '') +
        `\t[${e.reasons.join('/')}]`);
    }
    return lines.join('\n');
  }

  // --------------------------------------------------------------- 总渲染/动作

  function renderBar() {
    const d = rt.data, j = d.retest;
    $('#rt-source').textContent =
      `来源: ${j.job_name} · A4 ${j.a4} Hz · 完工基线 88 键`;
    $('#rt-tol').textContent =
      `容差 ±${j.tol_cents}¢ · 拍频 ±${j.tol_beat_cents}¢/${j.tol_beat_hz} Hz`;
    const st = $('#rt-status');
    st.textContent = STATUS[j.status] || j.status;
    st.className = 'rt-status st-' + j.status;
    const confirmed = j.status === 'confirmed';
    $('#rt-frozen').classList.toggle('hidden', !confirmed);
    $('#btn-rt-confirm').disabled =
      confirmed || !!d.active_round || !d.rounds.some(r => r.finished);
    $('#btn-rt-addround').disabled = confirmed;
    $('#rt-label').disabled = $('#rt-planned').disabled = confirmed;
  }

  async function confirmArchive() {
    if (!confirm('确认复测结论? 确认后全部测值与判断冻结, 新一轮复测须复制档案。'))
      return;
    rt.data = await api('POST', `/api/retests/${rt.data.retest.id}/confirm`);
    render();
    toast('档案已确认冻结');
  }

  async function copyArchive() {
    const r = await api('POST', `/api/retests/${rt.data.retest.id}/copy`);
    await loadList();
    $('#rt-select').value = r.id;
    await open(r.id);
    toast('已复制为新档案 (待复测) — 请设置新一轮复测时点');
  }

  function render() {
    if (!rt.data) return;
    renderBar();
    renderRounds();
    renderHeatmap();
    renderCurve();
    renderKeyCard();
    renderAnoms();
    renderAnomDetail();
    renderRetune();
  }

  function init() {
    $('#rt-select').addEventListener('change', e => open(+e.target.value || null));
    $('#btn-rt-new').addEventListener('click',
      () => newDialog().catch(e => toast(e.message, true)));
    $('#btn-rt-addround').addEventListener('click',
      () => addRound().catch(e => toast(e.message, true)));
    $('#btn-rt-confirm').addEventListener('click',
      () => confirmArchive().catch(e => toast(e.message, true)));
    $('#btn-rt-copy').addEventListener('click',
      () => copyArchive().catch(e => toast(e.message, true)));
    $('#btn-rkc-send').addEventListener('click',
      () => sendMeasure().catch(e => toast(e.message, true)));
    $('#btn-rkc-lock').addEventListener('click',
      () => toggleLock().catch(e => toast(e.message, true)));
    $('#btn-rkc-take').addEventListener('click', bringCapture);
    $('#btn-rkc-capture').addEventListener('click',
      () => window.PianoCapture?.goCapture?.(rt.cur));
    $('#rkc-f').addEventListener('input', liveDrift);
    $('#rt-only-core').addEventListener('change',
      e => { rt.onlyCore = e.target.checked; renderRetune(); });
    $('#btn-rt-text').addEventListener('click', () => {
      const ta = $('#rt-text');
      ta.classList.toggle('hidden');
      if (!ta.classList.contains('hidden')) {
        ta.value = retuneText();
        ta.focus();
        ta.select();
      }
    });
    loadList();
  }

  window.PianoRetest = {init, loadList};
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
