/* 逐键调律作业面板: 键盘色带 / 顺序队列 / 待回查 / 逐键录入 / 各轮比较。
 * 依赖 app.js 提供的 state.schemes (已保存版本) 与基础工具。*/
(function () {
  const MIDI_MIN = 21, MIDI_MAX = 108;
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const noteName = m => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 1100, H = 130;
  const BLACKS = [1, 3, 6, 8, 10];

  const jstate = {
    jobs: [], data: null, current: null, compare: null,
    busy: false,
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
  const fmtC = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}¢`;
  const fmtF = v => v == null ? '—' : v.toFixed(2);
  const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN',
    {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}) : '—';

  async function api(method, url, body) {
    const r = await fetch(url, {method,
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined});
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const toast = (m, bad) => window.PianoApp?.toast?.(m, bad);
  const PHASE_NAME = {pending: '待开始', coarse: '粗调', fine: '精调',
                      review: '复核', frozen: '已冻结'};
  const ROUND_NAME = {coarse: '粗调', fine: '精调', review: '复核'};

  // --------------------------------------------------------------- 作业列表/建立

  async function loadJobs() {
    jstate.jobs = await api('GET', '/api/jobs');
    const sel = $('#job-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">选择作业…</option>' + jstate.jobs.map(j =>
      `<option value="${j.id}" ${j.id == cur ? 'selected' : ''}>${j.id}. ${j.name} · ${PHASE_NAME[j.phase] || j.phase}</option>`).join('');
  }

  // 从已保存版本建立: 列出当前浏览器内已随会话入库的版本
  async function newJobDialog() {
    const schemes = (window.PianoApp.state.schemes || []).filter(s => s.server_id);
    if (!schemes.length)
      return toast('请先在 ⑧ 保留版本并「保存会话」, 再从该版本建立作业', true);
    const lines = schemes.map((s, i) =>
      `${i + 1}. ${s.name}${s.saved ? ' (已入库)' : ''}`).join('\n');
    const pick = prompt(`从哪个已保存版本建立作业? 输入序号:\n${lines}`, '1');
    if (pick == null) return;
    const s = schemes[parseInt(pick) - 1];
    if (!s?.server_id) return toast('版本尚未随会话保存', true);
    const tolC = parseFloat(prompt('单键偏离容差 (音分)', '5'));
    if (!(tolC > 0)) return;
    const tolHz = parseFloat(prompt('拍频绝对容差 (Hz, 低音宽限)', '0.8'));
    if (!(tolHz > 0)) return;
    const j = await api('POST', '/api/jobs',
      {scheme_id: s.server_id, tol_cents: tolC, tol_beat_hz: tolHz});
    await loadJobs();
    $('#job-select').value = j.id;
    openJob(j.id);
  }

  async function openJob(id) {
    if (!id) { jstate.data = null; $('#job-body').classList.add('hidden');
      $('#job-empty').classList.remove('hidden'); return; }
    jstate.data = await api('GET', `/api/jobs/${id}`);
    jstate.current = jstate.data.queue[0]?.m
      ?? jstate.data.keys.find(k => k.status === 'open')?.m
      ?? (jstate.data.keys.length ? jstate.data.keys[0].m : null);
    render();
  }

  // --------------------------------------------------------------- 键盘色带

  function renderKeyboard() {
    const svg = $('#job-keyboard');
    svg.innerHTML = '';
    const d = jstate.data, ww = W / NWHITE;
    const reopenSet = new Set(d.reopens.map(e => e.m));
    const keyByM = Object.fromEntries(d.keys.map(k => [k.m, k]));
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      if (BLACKS.includes(m % 12)) continue;
      const k = keyByM[m], wi = whiteIndex(m);
      const r = svgEl('rect', {x: wi * ww, y: 0, width: ww - 0.8, height: H,
        rx: 2, class: `jwn st-${k.status}${reopenSet.has(m) ? ' reopen' : ''}${jstate.current === m ? ' cur' : ''}`});
      r.dataset.m = m;
      r.addEventListener('click', () => selectKey(m));
      svg.appendChild(r);
      if (m % 12 === 0 || m === MIDI_MIN) {
        const t = svgEl('text', {x: wi * ww + ww / 2, y: H - 6, class: 'jlb'});
        t.textContent = noteName(m);
        svg.appendChild(t);
      }
    }
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      if (!BLACKS.includes(m % 12)) continue;
      const k = keyByM[m], wi = whiteIndex(m - 1);
      const r = svgEl('rect', {x: (wi + 1) * ww - ww * 0.32, y: 0,
        width: ww * 0.64, height: H * 0.6, rx: 1.5,
        class: `jbn st-${k.status}${reopenSet.has(m) ? ' reopen' : ''}${jstate.current === m ? ' cur' : ''}`});
      r.dataset.m = m;
      r.addEventListener('click', e => { e.stopPropagation(); selectKey(m); });
      svg.appendChild(r);
    }
  }

  // --------------------------------------------------------------- 键卡/录入

  function selectKey(m) {
    const d = jstate.data;
    const k = d.keys.find(x => x.m === m);
    if (!k) return;
    const frozen = d.job.phase === 'frozen' || d.job.phase === 'pending';
    if (!frozen && !k.in_scope)
      toast(`${k.name} 不在本轮范围 (${ROUND_NAME[d.current_round.kind]} #${d.current_round.idx})`, true);
    jstate.current = m;
    renderKeyboard();
    renderKeyCard();
  }

  function liveCents() {
    const d = jstate.data;
    const k = d.keys.find(x => x.m === jstate.current);
    const f = parseFloat($('#jk-f').value);
    if (!k || !(f > 0)) { $('#jk-live').textContent = '偏差 —'; $('#jk-live').className = 'jk-live'; return; }
    const c = 1200 * Math.log2(f / k.f_target);
    const over = Math.abs(c) > d.job.tol_cents;
    $('#jk-live').textContent = `偏差 ${fmtC(c)} (容差 ±${d.job.tol_cents}¢)`;
    $('#jk-live').className = 'jk-live ' + (over ? 'bad' : 'ok');
  }

  function renderKeyCard() {
    const d = jstate.data;
    const k = d.keys.find(x => x.m === jstate.current);
    const box = $('#job-keycard');
    if (!k) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const frozen = d.job.phase === 'frozen';
    $('#jk-name').textContent = k.name;
    $('#jk-order').textContent = `调律序 ${k.order} · MIDI ${k.m}`;
    $('#jk-target').textContent =
      `目标 ${fmtF(k.f_target)} Hz (${fmtC(k.target_cents)}) · B ${k.B.toExponential(2)}`;
    $('#jk-f').value = k.cur_round_idx != null ? k.f_meas ?? '' : '';
    $('#jk-reason').value = (k.cur_round_idx != null ? k.reason : '') || '';
    const lastTs = k.cur_round_idx != null
      ? `本轮 #${k.cur_round_idx} · ${fmtTime(k.ts)}${k.reason ? ' · ' + k.reason : ''}`
      : (k.ts ? `上轮 #${k.round_idx} · ${fmtTime(k.ts)} (本轮尚未重测)` : '尚无测量');
    $('#jk-ts').textContent = k.locked ? `已锁定 · ${lastTs}` : lastTs;
    liveCents();

    // 音程拍频 (实测拍频基于两端当前测值; 目标残拍为方案固有残留)
    const measured = new Set(d.keys.filter(x => x.f_meas != null).map(x => x.m));
    $('#jk-beats').innerHTML = k.beat_rows.length
      ? '<table><tr><th>音程</th><th>对键</th><th>目标残拍</th><th>实测拍频</th><th></th></tr>' +
        k.beat_rows.map(b => {
          const have = measured.has(b.hi_m);
          return `<tr class="${b.over ? 'over' : ''}"><td>${b.name}</td><td>${b.note_hi}</td>
            <td>${b.target_beat.toFixed(2)} Hz</td>
            <td>${have ? b.beat.toFixed(2) + ' Hz / ' + b.beat_cents.toFixed(1) + '¢' : '对键未测'}</td>
            <td>${b.over ? '<b class="bad">越限</b>' : '✓'}</td></tr>`;
        }).join('') + '</table>'
      : '<span class="hint">高音端无八度/十二度/双八度对键。</span>';

    const lockBtn = $('#btn-jk-lock');
    lockBtn.textContent = k.locked ? '🔓 解锁' : '🔒 锁定';
    lockBtn.classList.toggle('on', k.locked);
    const disabled = frozen || d.job.phase === 'pending';
    $('#jk-f').disabled = $('#jk-reason').disabled = $('#btn-jk-send').disabled =
      $('#btn-jk-take').disabled = lockBtn.disabled = disabled || k.locked || !k.in_scope;
    lockBtn.disabled = disabled || !k.in_scope;
    $('#btn-jk-capture').disabled = false;
  }

  async function sendMeasure() {
    const d = jstate.data, m = jstate.current;
    const f = parseFloat($('#jk-f').value);
    if (!(f > 0)) return toast('请输入有效频率', true);
    jstate.busy = true;
    try {
      const r = await api('POST', `/api/jobs/${d.job.id}/measure`,
        {m, f_meas: f, reason: $('#jk-reason').value || null});
      jstate.data = r;
      afterMutation(r, m);
      const msgs = [];
      if (r.just.reopened.length)
        msgs.push(`重开 ${r.just.reopened.map(x => noteName(x)).join('、')}`);
      for (const w of r.just.lock_warn)
        msgs.push(`${w.name} 已锁定, ${w.interval}拍频 ${w.beat_cents.toFixed(1)}¢ 仅告警`);
      toast(msgs.length ? `已记录 ${noteName(m)}: ${msgs.join('; ')}` : `${noteName(m)} 已达标 ✓`);
    } catch (e) { toast(e.message, true); }
    jstate.busy = false;
  }

  function afterMutation(r, preferM) {
    // 仍选当前键; 本轮已完成则跳到队列首
    const kk = r.keys.find(x => x.m === preferM);
    if (kk?.round_done) jstate.current = r.queue[0]?.m ?? preferM;
    else jstate.current = preferM;
    render();
  }

  async function toggleLock() {
    const d = jstate.data, m = jstate.current;
    const k = d.keys.find(x => x.m === m);
    try {
      const r = await api('POST', `/api/jobs/${d.job.id}/lock`,
        {m, locked: !k.locked});
      jstate.data = r;
      jstate.current = r.queue[0]?.m ?? m;
      render();
      toast(k.locked ? `${noteName(m)} 已解锁` : `${noteName(m)} 已锁定稳定`);
    } catch (e) { toast(e.message, true); }
  }

  function bringCapture() {
    const d = jstate.data, m = jstate.current;
    const f1 = window.PianoCapture?.takeMedian?.(m);
    if (f1 == null)
      return toast(`${noteName(m)} 尚无合格采集结果, 可到 ② 录制或手工录入`, true);
    $('#jk-f').value = f1.toFixed(3);
    liveCents();
    toast(`已带入 ${noteName(m)} 采集中位数 ${f1.toFixed(2)} Hz`);
  }

  // --------------------------------------------------------------- 队列/回查

  function renderQueue() {
    const d = jstate.data;
    const ul = $('#job-queue');
    $('#job-queue-n').textContent = `${d.queue.length} 项`;
    ul.innerHTML = '';
    if (!d.queue.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      const cr = d.current_round;
      li.textContent = cr
        ? (cr.kind === 'review'
            ? '本轮 88 键均已重测达标, 可复核冻结'
            : d.cur_total === 0
              ? '精调轮范围为空 (粗调已全达标), 确认后进入复核'
              : '本轮应测琴键均已完成, 可推进到下一阶段')
        : '作业尚未开始';
      ul.appendChild(li);
    }
    for (const k of d.queue.slice(0, 60)) {
      const li = document.createElement('li');
      li.className = `q st-${k.status}${jstate.current === k.m ? ' cur' : ''}`;
      const ord = document.createElement('span');
      ord.className = 'qo'; ord.textContent = k.order;
      const nm = document.createElement('b'); nm.textContent = k.name;
      li.append(ord, nm);
      if (k.cur_round_idx == null) {
        const i = document.createElement('i');
        i.textContent = k.cents == null ? '未测' : '本轮待测';
        i.classList.add('todo');
        li.append(i);
      } else {
        const i = document.createElement('i');
        i.textContent = fmtC(k.cents);
        if (Math.abs(k.cents) > d.job.tol_cents) i.classList.add('bad');
        li.append(i);
      }
      if (k.locked) li.append(document.createTextNode('🔒'));
      li.addEventListener('click', () => selectKey(k.m));
      ul.appendChild(li);
    }
    if (d.queue.length > 60) {
      const more = document.createElement('li');
      more.className = 'muted';
      more.textContent = `… 其余 ${d.queue.length - 60} 项`;
      ul.appendChild(more);
    }

    const ru = $('#job-reopens');
    $('#job-reopen-n').textContent = d.reopens.length ? `${d.reopens.length} 项` : '';
    ru.innerHTML = d.reopens.length ? '' : '<li class="muted">无待回查项</li>';
    if (!d.reopens.length) return;
    for (const e of d.reopens) {
      const x = e.data;
      const li = document.createElement('li');
      li.dataset.m = e.m;
      const txt = x.kind === 'deviation'
        ? `本键偏离: ${fmtC(x.prev_cents)} → ${fmtC(x.new_cents)} (容差 ±${x.tol}¢)`
        : `${x.interval} 受 ${x.trigger_name} 影响: 原偏差 ${fmtC(x.prev_cents)}, ` +
          `现拍 ${x.beat_cents.toFixed(1)}¢ (${x.beat_hz.toFixed(2)} Hz, 限 ${x.limit_hz.toFixed(2)})`;
      li.innerHTML = `<b>${e.name}</b> <i>第 ${e.round_idx} 轮</i><div></div>`;
      li.querySelector('div').textContent = txt;
      li.addEventListener('click', () => selectKey(e.m));
      ru.appendChild(li);
    }
  }

  // --------------------------------------------------------------- 进度/阶段

  function renderBar() {
    const d = jstate.data, j = d.job;
    const cp = d.cur_total ? d.cur_done / d.cur_total : 0;
    $('#job-prog-fill').style.width = `${cp * 100}%`;
    $('#job-prog-text').textContent =
      `本轮 ${d.cur_done}/${d.cur_total} · 总达标 ${d.done_count}/${d.total}`;
    const cr = d.current_round;
    $('#job-round-text').textContent = cr
      ? `阶段: ${PHASE_NAME[j.phase]} · ${ROUND_NAME[cr.kind]} #${cr.idx} · ` +
        (cr.kind === 'review' ? '全 88 键复核' :
         d.cur_total === 0 ? '范围为空 (粗调全达标, 确认后进复核)' :
         `本轮 ${d.keys.filter(k => k.in_scope).length} 键`)
      : `阶段: ${PHASE_NAME[j.phase]}`;
    $('#job-lock-text').textContent = `🔒 ${d.locked_count}`;
    $('#job-phase').textContent = PHASE_NAME[j.phase] || j.phase;
    $('#job-phase').className = 'job-phase ph-' + j.phase;

    const adv = $('#btn-job-advance');
    const frozenBox = $('#job-frozen');
    frozenBox.classList.toggle('hidden', j.phase !== 'frozen');
    if (j.phase === 'pending') {
      adv.textContent = '① 开始粗调'; adv.disabled = false;
    } else if (j.phase === 'coarse') {
      adv.textContent = '粗调完成 → 建立精调轮'; adv.disabled = false;
    } else if (j.phase === 'fine') {
      adv.textContent = d.cur_total === 0
        ? '精调轮(空)确认 → 进入复核'
        : '本轮完成 → 继续精调 / 进复核';
      adv.disabled = false;
    } else if (j.phase === 'review') {
      adv.textContent = '③ 复核通过 → 冻结作业'; adv.disabled = false;
    } else {
      adv.disabled = true; adv.textContent = '已冻结';
    }
  }

  async function advance() {
    const d = jstate.data, j = d.job;
    try {
      if (j.phase === 'pending') {
        jstate.data = await api('POST', `/api/jobs/${j.id}/start`);
      } else {
        if (j.phase === 'review' &&
            !confirm('确认复核通过? 冻结后来源方案、全部轮次与最终测值不可再改。')) return;
        jstate.data = await api('POST', `/api/jobs/${j.id}/advance`);
      }
      jstate.current = jstate.data.queue[0]?.m ?? null;
      $('#job-compare').classList.add('hidden');
      render();
      toast(jstate.data.job.phase === 'frozen'
        ? '作业已冻结, 可复制作业后继续调整'
        : `已进入 ${PHASE_NAME[jstate.data.job.phase]}`);
    } catch (e) { toast(e.message, true); }
  }

  // --------------------------------------------------------------- 各轮比较

  async function toggleCompare() {
    const box = $('#job-compare');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    jstate.compare = await api('GET', `/api/jobs/${jstate.data.job.id}/compare`);
    renderCompare();
    box.classList.remove('hidden');
    box.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }

  function renderCompare() {
    const c = jstate.compare;
    const thead = $('#jc-table thead');
    thead.innerHTML = '<tr><th>键</th>' + c.rounds.map((r, i) =>
      `<th>${ROUND_NAME[r.kind]} #${r.idx}</th>`).join('') +
      '<th>漂移</th><th>返工</th><th>最大拍频</th><th>状态</th></tr>';
    const onlyBad = $('#jc-filter').checked;
    const rows = c.rows.filter(r =>
      !onlyBad || (!r.passing || r.rework > 0 || (r.drift || 0) > c.tol_cents));
    $('#jc-table tbody').innerHTML = rows.map(r => {
      const cells = r.series.map(s => s == null
        ? '<td class="muted">—</td>'
        : `<td class="${Math.abs(s.cents) > c.tol_cents ? 'bad' : ''}">${fmtC(s.cents)}</td>`).join('');
      return `<tr data-m="${r.m}" class="${r.passing ? '' : 'badrow'}">
        <td><b>${r.name}</b></td>${cells}
        <td>${r.drift ? r.drift.toFixed(1) + '¢' : '—'}</td>
        <td>${r.rework || ''}</td>
        <td class="${r.max_beat != null && r.max_beat > c.tol_beat_cents ? 'bad' : ''}">${r.max_beat == null ? '—' : r.max_beat.toFixed(1) + '¢'}</td>
        <td>${r.passing ? '✓' : '<b class="bad">未达标</b>'}</td></tr>`;
    }).join('');
    $$('#jc-table tbody tr[data-m]').forEach(tr =>
      tr.addEventListener('click', () => { selectKey(+tr.dataset.m); renderCompare(); }));
  }

  async function copyJob() {
    const id = jstate.data.job.id;
    const j = await api('POST', `/api/jobs/${id}/copy`);
    await loadJobs();
    $('#job-select').value = j.id;
    openJob(j.id);
    toast('已复制为新作业 (待开始)');
  }

  // --------------------------------------------------------------- 总渲染

  function render() {
    if (!jstate.data) return;
    if (jstate.current == null) $('#job-keycard').classList.add('hidden');
    renderBar();
    renderKeyboard();
    renderKeyCard();
    renderQueue();
    if (jstate.compare) {
      jstate.compare = null;
      $('#job-compare').classList.add('hidden');
    }
  }

  function init() {
    $('#job-select').addEventListener('change', e => openJob(+e.target.value || null));
    $('#btn-job-new').addEventListener('click', () => newJobDialog().catch(e => toast(e.message, true)));
    $('#btn-job-advance').addEventListener('click', advance);
    $('#btn-job-compare').addEventListener('click', toggleCompare);
    $('#btn-job-copy').addEventListener('click', () => copyJob().catch(e => toast(e.message, true)));
    $('#btn-jk-send').addEventListener('click', sendMeasure);
    $('#btn-jk-lock').addEventListener('click', toggleLock);
    $('#btn-jk-take').addEventListener('click', bringCapture);
    $('#btn-jk-capture').addEventListener('click', () =>
      window.PianoCapture?.goCapture?.(jstate.current));
    $('#jk-f').addEventListener('input', liveCents);
    $('#jc-filter').addEventListener('change', () => jstate.compare && renderCompare());
    loadJobs();
  }

  window.PianoJobs = {
    init, loadJobs,
    // 保存会话后版本拿到 server_id 时刷新作业入口
    refreshSchemes() {},
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
