/* 浏览器实测采集: 麦克风 → 稳定片段 → 频谱/音高轨迹 → 基频与 2~8 次分音识别。
 * 依赖: PianoAudio (共享 AudioContext), PianoApp (输入表状态/分析)。
 * 设计约定见模块末尾闸门清单; 任何一项不合格都不会生成候选测量。 */
(function () {
  const MIDI_MIN = 21, MIDI_MAX = 108, A4 = 69;
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const noteName = m => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const $ = s => document.querySelector(s);

  const FFT_N = 32768;                    // 最终频谱: 48kHz 下约 1.46 Hz/线
  const LIVE_N = 8192;
  const AMP_PRIOR = [1, .72, .55, .42, .32, .24, .18, .13];
  const GATE = { snr: 12, level: 15, stableMs: 900, drift: 8,
                 resid: 25, conf: 0.5, expCents: 80 };

  const cap = {
    m: A4,
    stream: null, ctx: null, source: null, proc: null, mute: null,
    sr: 48000,
    mode: 'idle',                // idle | noise | armed | rec
    raf: 0, lastDraw: 0, lastMeter: 0,
    ring: [],                    // 最近的 Float32 块 (约 0.6s)
    ringS: 0,
    recChunks: [], recT0: 0, recPre: null,
    trigT: 0, quietMs: 0,
    blocks: [],                  // 录音中音高轨迹 {t, f, db}
    trackF: 0,
    noiseRms: 0, noisePow: null, // 环境噪声: RMS 与每 bin 平均功率
    pending: null,               // 本次录音分析结果 (未保留)
    calibTimer: 0, armT: 0,      // armT: 允许再次自动触发的时刻 (冷却)
  };

  // ------------------------------------------------------------ 工具

  const median = a => {
    const x = [...a].sort((p, q) => p - q), n = x.length;
    return n % 2 ? x[(n - 1) / 2] : 0.5 * (x[n / 2 - 1] + x[n / 2]);
  };
  const pct = (a, p) => {
    const x = [...a].sort((u, v) => u - v);
    return x[Math.min(x.length - 1, Math.max(0, Math.round(p * (x.length - 1))))];
  };
  const db = x => 20 * Math.log10(Math.max(x, 1e-9));
  const cents = (fa, fb) => 1200 * Math.log2(fb / fa);

  function keyState(m, create) {
    const st = window.PianoApp.state;
    let k = st.keys.get(m);
    if (!k && create) { k = {measures: {}, captures: []}; st.keys.set(m, k); }
    return k;
  }
  function takes(m) { return keyState(m)?.captures || []; }
  function fExpected(m) {
    const a4 = parseFloat($('#a4').value) || 440;
    return a4 * 2 ** ((m - A4) / 12);
  }

  // ------------------------------------------------------------ FFT

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // 对若干段快照做 Hann 加窗 FFT, 返回平均幅度谱与每快照基频峰位置
  function spectrum(samplesList, n, sr) {
    const mag = new Float32Array(n / 2);
    for (const samples of samplesList) {
      const re = new Float32Array(n), im = new Float32Array(n);
      const off = Math.max(0, Math.floor((samples.length - n) / 2));
      for (let i = 0; i < n; i++) {
        const x = samples[Math.min(samples.length - 1, off + i)] || 0;
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
        re[i] = x * w;
      }
      fft(re, im);
      for (let k = 0; k < n / 2; k++)
        mag[k] += Math.hypot(re[k], im[k]) / samplesList.length;
    }
    return {mag, sr, bin: sr / n};
  }

  function noiseDbAt(noisePow, f, bin) {
    if (!noisePow) return -85;
    const x = f / bin, k0 = Math.floor(x);
    if (k0 < 1 || k0 >= noisePow.length - 1) return -85;
    const t = x - k0;
    const p = noisePow[k0] * (1 - t) + noisePow[k0 + 1] * t;
    return 10 * Math.log10(Math.max(p, 1e-12));
  }

  // 局部极大值 + 抛物线插值
  function findPeaks(mag, sr, noisePow, minDb) {
    const n = mag.length * 2, dF = sr / n;
    const out = [];
    for (let k = 2; k < mag.length - 2; k++) {
      if (mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
      const den = mag[k - 1] - 2 * mag[k] + mag[k + 1];
      let d = 0;
      if (den < 0) d = 0.5 * (mag[k - 1] - mag[k + 1]) / den;
      const f = (k + d) * dF;
      const mdb = db(mag[k]);
      if (mdb < minDb) continue;
      if (mdb < noiseDbAt(noisePow, f, dF) + 8) continue;
      out.push({k, f, db: mdb, lin: mag[k]});
    }
    return out;
  }

  const predF = (f1, B, n) => n * f1 * Math.sqrt(1 + B * n * n);

  function nearestPeak(peaks, f, tolCents) {
    let best = null, bd = tolCents;
    for (const p of peaks) {
      const d = Math.abs(cents(f, p.f));
      if (d < bd) { bd = d; best = p; }
    }
    return best ? {pk: best, d: bd} : null;
  }

  // 加权 (f_n/n)^2 = a + b n^2 直线拟合 (与后端 fit_inharmonic 同式)
  // matches: Map(n -> {pk, d}) 或 Map(n -> peak)
  function fitAB(matches, weights) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [n0, hit] of matches) {
      const n = +n0, pk = hit.pk || hit;
      const w = (weights?.[n] ?? 1) * (AMP_PRIOR[n - 1] ?? 0.05) * (pk.lin || 1);
      const x = n * n, y = (pk.f / n) ** 2;
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
    const det = sw * sxx - sx * sx;
    if (Math.abs(det) < 1e-30) return null;
    const a = (sy * sxx - sx * sxy) / det;
    const b = (sw * sxy - sx * sy) / det;
    if (a <= 0) return null;
    return {f1: Math.sqrt(a), B: Math.max(b / a, 1e-8)};
  }

  // ------------------------------------------------------------ 分音识别

  function identify(mag, sr, noisePow, fExp) {
    const dF = sr / (mag.length * 2);
    const peaks = findPeaks(mag, sr, noisePow, -92);
    const cands = peaks.filter(p => Math.abs(cents(fExp, p.f)) < 650);
    if (!cands.some(p => Math.abs(cents(fExp, p.f)) < 120))
      cands.push({f: fExp, db: -120, lin: 0, virtual: true});

    let best = null;
    for (const c0 of cands) {
      // B 粗搜
      let bs = null;
      for (let li = 0; li <= 24; li++) {
        const B = 10 ** (-7.5 + li * (5 / 24));
        const ms = matchPartials(peaks, c0.f, B, sr, 45);
        const sc = scoreMatches(ms, noisePow, dF);
        if (!bs || sc > bs.score) bs = {B, ms, score: sc};
      }
      // 用匹配点回归 (f1, B) 后收紧容差再匹配, 迭代两次
      let cur = bs;
      for (let it = 0; it < 2; it++) {
        const ab = fitAB(cur.ms);
        if (!ab) break;
        const ms = matchPartials(peaks, ab.f1, ab.B, sr,
                                 it === 0 ? 25 : 15);
        const score = scoreMatches(ms, noisePow, dF);
        cur = {f1: ab.f1, B: ab.B, ms, score};
      }
      if (!best || cur.score > best.score) best = cur;
    }

    // 整理结果 + 次序/残差校验
    const partials = {};
    let residSq = 0, snrVals = [];
    const usedPeaks = new Set();
    for (let n = 1; n <= 8; n++) {
      const hit = best.ms.get(n);
      if (!hit) continue;
      if (usedPeaks.has(hit.pk.k)) { best.orderError = true; continue; }
      usedPeaks.add(hit.pk.k);
      const pred = predF(best.f1, best.B, n);
      const dc = cents(pred, hit.pk.f);
      residSq += dc * dc;
      const snr = hit.pk.db - noiseDbAt(noisePow, hit.pk.f, dF);
      snrVals.push(snr);
      partials[n] = {f: hit.pk.f, cents: dc, prom: hit.d,
                     db: hit.pk.db, snr, k: hit.pk.k};
    }
    // 次序错误: 已用峰旁出现更强的未用峰, 或同一峰被多个分音占用
    for (let n = 1; n <= 8; n++) {
      if (!partials[n]) continue;
      const pred = predF(best.f1, best.B, n);
      const tol = Math.max(partials[n].prom, 12);
      const rivals = peaks.filter(p => !usedPeaks.has(p.k) &&
        Math.abs(cents(pred, p.f)) < tol);
      if (rivals.some(p => p.lin > partials[n].f && p.db > partials[n].db))
        best.orderError = true;
    }
    const ns = Object.keys(partials).length;
    best.partials = partials;
    best.residRms = ns ? Math.sqrt(residSq / ns) : 999;
    best.snrVals = snrVals;
    best.snr = snrVals.length ? median(snrVals) : 0;
    best.f1Cents = cents(fExp, best.f1);
    best.nPartials = ns;
    best.peaks = peaks;
    best.fExp = fExp;
    best.dF = dF;
    best.ok = ns >= 3 && partials[1] && partials[2] &&
              best.residRms <= GATE.resid && !best.orderError &&
              Math.abs(best.f1Cents) <= GATE.expCents;
    return best;
  }

  function matchPartials(peaks, f1, B, sr, tolCents) {
    const ms = new Map();
    for (let n = 1; n <= 8; n++) {
      const pf = predF(f1, B, n);
      if (pf > sr * 0.45) continue;
      const hit = nearestPeak(peaks, pf, tolCents);
      if (hit) ms.set(n, hit);
    }
    return ms;
  }

  function scoreMatches(ms, noisePow, dF) {
    let s = 0, w = 0;
    for (const [n, hit] of ms) {
      const wn = AMP_PRIOR[n - 1];
      const excess = hit.pk.db - noiseDbAt(noisePow, hit.pk.f, dF);
      // 偏离预测峰位会显著扣分, 避免"有峰即算"
      const q = Math.max(0, 1 - hit.d / 30);
      s += wn * Math.max(0, Math.min(excess, 40)) * q;
      w += wn;
    }
    return w ? s / w / 25 : 0;   // 超过噪声 25dB 记满分
  }

  // ------------------------------------------------------------ 录音流程

  async function enableMic() {
    if (cap.stream) { stopMic(); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#mic-status').textContent = '浏览器不支持麦克风 —— 继续手工录入';
      $('#btn-mic').disabled = true;
      return;
    }
    try {
      cap.stream = await navigator.mediaDevices.getUserMedia(
        {audio: {echoCancellation: false, noiseSuppression: false,
                 autoGainControl: false}});
    } catch (e) {
      cap.stream = null;
      const denied = e.name === 'NotAllowedError' || e.name === 'SecurityError';
      $('#mic-status').textContent = denied
        ? '麦克风权限被拒绝 —— 手工录入不受影响'
        : `麦克风不可用 (${e.name}) —— 继续手工录入`;
      toast(denied ? '麦克风权限被拒绝, 可继续手工录入' : '麦克风不可用: ' + e.name, true);
      return;
    }
    const c = window.PianoAudio.ac();
    cap.ctx = c; cap.sr = c.sampleRate;
    cap.source = c.createMediaStreamSource(cap.stream);
    cap.mute = c.createGain(); cap.mute.gain.value = 0;   // 防回授
    cap.mute.connect(c.destination);
    cap.proc = c.createScriptProcessor(4096, 1, 1);
    cap.source.connect(cap.proc); cap.proc.connect(cap.mute);
    cap.proc.onaudioprocess = onChunk;
    cap.ring = []; cap.ringS = 0;
    startNoiseCalib();
    $('#btn-mic').textContent = '关闭麦克风';
    loop();
  }

  function stopMic() {
    if (cap.mode === 'rec') finishRec(true);
    cap.proc?.disconnect(); cap.source?.disconnect(); cap.mute?.disconnect();
    cap.stream?.getTracks().forEach(t => t.stop());
    Object.assign(cap, {stream: null, proc: null, source: null, mute: null,
                        mode: 'idle', ring: [], recChunks: []});
    cancelAnimationFrame(cap.raf);
    $('#btn-mic').textContent = '启用麦克风';
    $('#mic-status').textContent = '未启用 —— 可继续手工录入';
    $('#btn-rec').disabled = true;
    $('#btn-rec').textContent = '① 点选琴键后录单次击弦';
    $('#btn-accept').classList.add('hidden');
    $('#btn-discard').classList.add('hidden');
    $('#cap-phase').textContent = '';
    cap.pending = null;
    setMeters(null); renderGates([]);
  }

  function startNoiseCalib() {
    cap.mode = 'noise';
    cap.noisePow = new Float32Array(LIVE_N / 2);
    let rmsAcc = 0, rmsN = 0, shots = 0, accPow = null;
    $('#mic-status').textContent = '环境采样中 (请保持安静)…';
    const sample = () => {
      if (cap.mode !== 'noise') return;
      const buf = concatRecent(LIVE_N);
      if (buf) {
        const {mag} = spectrum([buf], LIVE_N, cap.sr);
        if (!accPow) accPow = new Float32Array(mag.length);
        for (let k = 0; k < mag.length; k++) accPow[k] += mag[k] * mag[k];
        shots++;
        for (let i = Math.max(0, buf.length - cap.sr * 0.2); i < buf.length; i++)
          rmsAcc += buf[i] * buf[i], rmsN++;
      }
      if (shots < 5) { cap.calibTimer = setTimeout(sample, 240); return; }
      for (let k = 0; k < accPow.length; k++) cap.noisePow[k] = accPow[k] / shots;
      cap.noiseRms = Math.sqrt(rmsAcc / Math.max(1, rmsN));
      cap.mode = 'armed';
      $('#mic-status').textContent =
        `就绪 — 环境噪声 ${db(cap.noiseRms).toFixed(0)} dBFS, 点录音后击弦`;
      $('#btn-rec').disabled = false;
    };
    sample();
  }

  function onChunk(ev) {
    const ch = ev.inputBuffer.getChannelData(0);
    const copy = new Float32Array(ch.length);
    copy.set(ch);
    pushRing(copy);
    const rms = rmsOf(copy), peak = peakOf(copy);
    cap._live = {rms, peak, clip: countClip(ch)};

    if (cap.mode === 'noise') return;
    if (cap.mode === 'armed') {
      // 等待击弦: 电平显著高出噪声即触发 (冷却 1s 防止尾音重复触发)
      if (performance.now() > cap.armT &&
          rms > cap.noiseRms * 10 ** (GATE.level / 20) * 1.4 && peak > 0.01)
        startRec();
      else { updateMeters({rms, peak, clip: 0, stable: 0}); return; }
    }
    if (cap.mode === 'rec') {
      cap.recChunks.push(copy);   // 触发块本身也计入 (预卷已包住击弦瞬间)
      const t = (performance.now() - cap.trigT) / 1000;
      trackBlock(copy, t, rms, peak);
      updateMeters({rms, peak,
        clip: (cap._clip = (cap._clip || 0) + countClip(copy)),
        stable: stableRunMs()});
      if (rms < cap.noiseRms * 10 ** (12 / 20) || peak < 0.008)
        cap.quietMs += copy.length / cap.sr * 1000;
      else cap.quietMs = 0;
      const dur = (performance.now() - cap.trigT) / 1000;
      if (cap.quietMs > 350 || dur > 6) finishRec(false);
    }
  }

  function startRec() {
    cap.mode = 'rec';
    cap.recChunks = [];
    cap.recPre = concatRecent(cap.sr * 0.12);   // 预留 120ms 包住击弦瞬间
    cap.trigT = performance.now();
    cap.blocks = []; cap.trackF = fExpected(cap.m); cap.quietMs = 0;
    cap._clip = 0;
    $('#btn-rec').textContent = '■ 停止录音';
    $('#cap-phase').textContent = '录音中… 单次击弦, 保持 1.5 秒以上';
    PianoAudio.stop();
  }

  // 短块音高跟踪 (沿上次估计找最近峰; 含预卷, 首块 ~120ms)
  function trackBlock(chunk, t, rms) {
    const bN = cap.trackF < 60 ? 16384 : 8192;
    const buf = concatRecent(bN);
    if (!buf || buf.length < bN * 0.5) return;
    const {mag} = spectrum([buf], bN, cap.sr);
    const dF = cap.sr / bN;
    let best = null;
    for (let k = 2; k < mag.length - 2; k++) {
      const f = k * dF;
      const d = Math.abs(cents(cap.trackF, f));
      if (d > 4) continue;
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] &&
          (!best || d < best.d)) best = {k, v: mag[k], d};
    }
    if (!best) return;
    const den = mag[best.k - 1] - 2 * mag[best.k] + mag[best.k + 1];
    let d = 0;
    if (den < 0) d = 0.5 * (mag[best.k - 1] - mag[best.k + 1]) / den;
    const f = (best.k + d) * dF;
    if (Math.abs(cents(fExpected(cap.m), f)) < GATE.expCents) cap.trackF = f;
    cap.blocks.push({t, f: cap.trackF, db: db(rms)});
  }

  function finishRec(manual) {
    if (cap.mode !== 'rec') return;
    cap.mode = 'armed';
    cap.armT = performance.now() + 1000;
    $('#btn-rec').textContent = '重录 (覆盖本次)';
    const chunks = cap.recPre ? [cap.recPre, ...cap.recChunks] : cap.recChunks;
    const full = concat(chunks);
    analyzeTake(full, manual);
  }

  // ------------------------------------------------------------ 稳定片段与闸门

  function stableRunMs() {
    const b = cap.blocks;
    if (b.length < 3) return 0;
    const med = median(b.map(x => x.f));
    let best = 0, run = 0;
    for (let i = 1; i < b.length; i++) {
      const ok = Math.abs(cents(med, b[i].f)) <= 5;
      run = ok ? run + (b[i].t - b[i - 1].t) : 0;
      best = Math.max(best, run);
    }
    return best * 1000;
  }

  function analyzeTake(full, manual) {
    const fExp = fExpected(cap.m), sr = cap.sr;
    const blk = cap.blocks.filter(b => b.t > 0.10);
    const medF = blk.length ? median(blk.map(b => b.f)) : fExp;
    const loud = b => b.db > db(cap.noiseRms) + GATE.level - 3;
    // 最长连续稳定段 (音分偏差 ≤5, 电平足够)
    let bestS = -1, bestLen = 0, runS = -1;
    for (let i = 0; i < blk.length; i++) {
      const ok = Math.abs(cents(medF, blk[i].f)) <= 5 && loud(blk[i]);
      if (ok) { if (runS < 0) runS = i; }
      else {
        if (i - runS > bestLen) { bestLen = i - runS; bestS = runS; }
        runS = -1;
      }
    }
    if (runS >= 0 && blk.length - runS > bestLen) { bestLen = blk.length - runS; bestS = runS; }
    const t0 = bestS >= 0 ? blk[bestS].t : 0.1;
    const t1 = bestS >= 0 ? blk[bestS + bestLen - 1].t : full.length / sr;
    const stableMs = Math.max(0, (t1 - t0) * 1000);

    // full = 120ms 预卷 + 录音; t 相对击弦触发点, 需加回预卷时长
    const preS = cap.recPre ? cap.recPre.length / sr : 0;
    const i0 = Math.floor((preS + t0) * sr), i1 = Math.floor((preS + t1) * sr);
    const seg = full.subarray(i0, Math.min(full.length, i1));

    // 段内多快照平均频谱
    const snaps = [];
    if (seg.length >= FFT_N) {
      const K = Math.min(4, Math.floor(seg.length / (FFT_N / 2)));
      for (let k = 0; k < K; k++) {
        const start = Math.floor(k * (seg.length - FFT_N) / Math.max(1, K - 1));
        snaps.push(seg.subarray(start, start + FFT_N));
      }
    } else snaps.push(seg);
    const {mag} = spectrum(snaps, FFT_N, sr);
    const r = identify(mag, sr, cap.noisePow, fExp);

    // 快照间基频漂移
    const snapF = snaps.map(s => {
      const {mag: m2} = spectrum([s], FFT_N, sr);
      const pk = findPeaks(m2, sr, cap.noisePow, -80);
      const hit = nearestPeak(pk, r.f1, 10);
      return hit ? hit.pk.f : r.f1;
    });
    const drift = snapF.length > 1 ? pct(snapF.map(f => cents(median(snapF), f)), 0.9) * 2 : 0;
    const blockSpread = blk.length > 3
      ? pct(blk.map(b => cents(medF, b.f)), 0.9) - pct(blk.map(b => cents(medF, b.f)), 0.1) : 0;
    r.driftCents = Math.max(drift, Math.abs(blockSpread));

    // 整段电平/削波
    const segRms = rmsOf(seg);
    let clip = 0;
    for (let i = 0; i < full.length; i += 3) if (Math.abs(full[i]) >= 0.999) clip++;
    r.levelDb = db(segRms);
    r.noiseDb = db(cap.noiseRms);
    r.snrDb = r.levelDb - r.noiseDb;
    r.clip = clip;
    r.stableMs = stableMs;
    r.nBlocks = blk.length;
    r.track = blk;
    r.mag = mag; r.sr = sr;
    r.buffer = toBuffer(full, sr);
    r.ts = Date.now();
    r.id = r.ts.toString(36) + Math.floor(Math.random() * 1e4).toString(36);

    // 置信度: 平均高出噪声程度 + 残差/覆盖度
    const cover = r.nPartials / Math.min(8, Math.floor(sr * 0.45 / fExp));
    r.conf = Math.max(0, Math.min(1,
      r.score * (0.6 + 0.4 * cover) * (r.residRms < 12 ? 1 : 0.7)));

    r.gates = buildGates(r);
    r.pass = r.gates.every(g => g.ok);
    cap.pending = r;
    drawResult(r);
    renderGates(r.gates);
    setMeters({rms: segRms, peak: peakOf(seg), clip, stable: stableMs,
               snr: r.snr, rec: true});
    $('#btn-accept').classList.remove('hidden');
    $('#btn-discard').classList.remove('hidden');
    $('#btn-accept').disabled = !r.pass;
    $('#btn-rec').textContent = '重录 (覆盖本次)';
    $('#cap-phase').innerHTML = r.pass
      ? `✓ 识别 ${r.nPartials} 个分音, f₁=${r.f1.toFixed(2)} Hz ` +
        `(${r.f1Cents >= 0 ? '+' : ''}${r.f1Cents.toFixed(1)}¢), B=${r.B.toExponential(2)} — 可保留为候选`
      : `✗ 未通过质量闸门 (${r.gates.filter(g => !g.ok).map(g => g.label).join('、')}), 录音未写入, 请重录`;
  }

  function buildGates(r) {
    return [
      {label: '环境噪声', ok: r.snrDb >= 12 && (r.snr >= GATE.snr),
       val: `段信噪比 ${r.snrDb.toFixed(0)} dB, 分音中位 ${r.snr.toFixed(0)} dB`,
       need: `段 ≥12 dB 且分音 ≥${GATE.snr} dB`},
      {label: '输入电平', ok: r.levelDb > -55 && r.levelDb < -0.5,
       val: `${r.levelDb.toFixed(0)} dBFS`, need: '-55 ~ -1 dBFS'},
      {label: '削波', ok: r.clip === 0,
       val: r.clip ? `${r.clip} 个采样贴顶` : '无削波', need: '0'},
      {label: '稳定时长', ok: r.stableMs >= GATE.stableMs,
       val: `${(r.stableMs / 1000).toFixed(2)} s`, need: `≥ ${(GATE.stableMs / 1000).toFixed(1)} s`},
      {label: '峰值漂移', ok: r.driftCents <= GATE.drift,
       val: `±${r.driftCents.toFixed(1)} ¢`, need: `≤ ±${GATE.drift}¢`},
      {label: '分音次序', ok: !r.orderError && r.residRms <= GATE.resid &&
             r.nPartials >= 3 && r.partials[1] && r.partials[2],
       val: `${r.nPartials} 峰, 拟合残差 ${r.residRms.toFixed(1)}¢`,
       need: `≥3 峰含 1/2 次, 残差 ≤${GATE.resid}¢`},
      {label: '置信度', ok: r.conf >= GATE.conf,
       val: r.conf.toFixed(2), need: `≥ ${GATE.conf}`},
      {label: '音高合理性', ok: Math.abs(r.f1Cents) <= GATE.expCents,
       val: `对 ${noteName(cap.m)} 平均律 ${r.f1Cents >= 0 ? '+' : ''}${r.f1Cents.toFixed(1)}¢`,
       need: `±${GATE.expCents}¢ 内`},
    ];
  }

  // ------------------------------------------------------------ 测量管理/聚合

  function acceptPending() {
    const r = cap.pending;
    if (!r?.pass) return;
    const k = keyState(cap.m, true);
    k.captures.push(takeSummary(r, true));
    cap.pending = null;
    $('#btn-accept').classList.add('hidden');
    $('#btn-discard').classList.add('hidden');
    $('#btn-rec').textContent = '录单次击弦';
    $('#cap-phase').textContent = '已保留为候选测量, 可继续录下一次';
    renderTakes();
    drawLive();
    window.PianoApp.renderInputTable();
    toast('测量已保留 (尚未写回输入表, 确认后写回)');
  }

  function discardPending() {
    cap.pending = null;
    $('#btn-accept').classList.add('hidden');
    $('#btn-discard').classList.add('hidden');
    $('#btn-rec').textContent = '录单次击弦';
    $('#cap-phase').textContent = '已丢弃, 可重录';
    drawLive();
  }

  // 仅保留摘要 (AudioBuffer 单独挂在 _buf, 不入会话)
  function takeSummary(r, withBuf) {
    const use = {};
    for (const n of Object.keys(r.partials)) use[n] = true;
    const t = {
      id: r.id, ts: r.ts, excluded: false, use,
      f1: r.f1, B: r.B, conf: r.conf, snr: r.snr, snrDb: r.snrDb,
      levelDb: r.levelDb, stableMs: r.stableMs, clip: r.clip,
      driftCents: r.driftCents, nPartials: r.nPartials,
      f1Cents: r.f1Cents, residRms: r.residRms,
      partials: Object.fromEntries(Object.entries(r.partials)
        .map(([n, p]) => [n, {f: p.f, cents: p.cents, snr: p.snr, db: p.db}])),
      track: r.track, fExp: r.fExp,
    };
    if (withBuf) t._buf = r.buffer;
    return t;
  }

  function aggregate(m) {
    const ts = takes(m).filter(t => !t.excluded);
    const byN = {};
    for (const t of ts)
      for (const [n, p] of Object.entries(t.partials))
        if (t.use[n] !== false) (byN[n] ??= []).push(p.f);
    const meds = {}, spread = {};
    for (const [n, arr] of Object.entries(byN)) {
      const med = median(arr);
      meds[n] = med;
      spread[n] = Math.max(...arr.map(f => Math.abs(cents(med, f))));
    }
    // 与后端 fit_inharmonic 相同的 pweights 加权式
    const pw = window.PianoApp.state.pweights;
    let B = null;
    if (Object.keys(meds).length) {
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const [ns, f] of Object.entries(meds)) {
        const n = +ns, w = pw[n] ?? 1, x = n * n, y = (f / n) ** 2;
        sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
      }
      const det = sw * sxx - sx * sx;
      if (Math.abs(det) >= 1e-30) {
        const a = (sy * sxx - sx * sxy) / det;
        const b = (sw * sxy - sx * sy) / det;
        if (a > 0) B = b / a;
      }
    }
    return {meds, spread, B, n: ts.length};
  }

  // 各次测量 / 合成值对 B 与目标音分的影响 (走后端分析管线)
  const refreshEffects = debounce(async (m) => {
    const ts = takes(m);
    if (!ts.length) return;
    const inp = window.PianoApp.buildInput();
    const agg = aggregate(m);
    const variants = [];
    const cur = window.PianoApp.state.keys.get(m)?.measures;
    if (cur && Object.keys(cur).length)
      variants.push({id: 'BASE', label: '当前输入表', measures: cur, replace: true});
    for (const t of ts) {
      if (t.excluded) continue;
      // 单次影响: 本次分音替换中位数, 未覆盖的分音沿用其他测量中位数
      const measures = {};
      for (const [n, p] of Object.entries(t.partials))
        if (t.use[n] !== false) measures[n] = p.f;
      variants.push({id: t.id, measures, replace: false});
    }
    if (Object.keys(agg.meds).length)
      variants.push({id: 'ALL', label: '选中分音中位数', measures: agg.meds, replace: true});
    let rs;
    try {
      const r = await fetch('/api/measure-effects', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({m, input: inp, cfg: window.PianoApp.cfg(), variants})});
      rs = await r.json();
    } catch (e) { return; }
    if (cap.m !== m) return;            // 用户已切到别的键, 丢弃过期结果
    renderEffects(rs);
  }, 450);

  function renderEffects(rs) {
    if (!Array.isArray(rs)) return;
    // 有输入表值时以其为基线; 否则以全部测量合成值为基线
    const base = rs.find(r => r.id === 'BASE') || rs.find(r => r.id === 'ALL');
    const byId = Object.fromEntries(rs.map(r => [r.id, r]));
    const fmt = (r) => r?.ok
      ? `B ${r.B.toExponential(2)} · 目标 ${r.cents >= 0 ? '+' : ''}${r.cents.toFixed(1)}¢`
      : '—';
    const delta = r => (base?.ok && r?.ok && r !== base)
      ? ` <span class="d">Δ ${r.cents - base.cents >= 0 ? '+' : ''}${(r.cents - base.cents).toFixed(1)}¢</span>` : '';
    for (const t of takes(cap.m)) {
      const box = document.querySelector(`[data-take="${t.id}"] .take-effect`);
      const r = byId[t.id];
      if (box && r) box.innerHTML = fmt(r) + delta(r);
    }
    const aggBox = $('#cap-agg-effect');
    const ar = byId['ALL'];
    if (aggBox) {
      if (!ar?.ok) aggBox.textContent = '';
      else if (base && ar !== base)
        aggBox.innerHTML = `写入后: ${fmt(ar)}${delta(ar)}`;
      else aggBox.innerHTML = `合成: ${fmt(ar)}`;
    }
  }

  function renderTakes() {
    const m = cap.m;
    $('#cap-note-name').textContent = `${noteName(m)} · MIDI ${m}`;
    const list = $('#cap-takes');
    const ts = takes(m);
    if (!ts.length) {
      list.innerHTML = '<li class="muted">启用麦克风后点「录单次击弦」。不合格的录音不会写入, 可重录。</li>';
      $('#cap-aggregate').innerHTML = '尚无合格测量';
      $('#cap-agg-effect').textContent = '';
      return;
    }
    list.innerHTML = '';
    for (const [i, t] of ts.entries()) {
      const li = document.createElement('li');
      li.dataset.take = t.id;
      li.className = 'take' + (t.excluded ? ' excluded' : '');
      const checks = [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
        t.partials[n] ? `<label title="${n} 次分音 ${t.partials[n].f.toFixed(2)} Hz">
          <input type="checkbox" data-use="${n}" ${t.use[n] !== false ? 'checked' : ''}>${n}</label>` : '').join('');
      li.innerHTML = `
        <div class="take-h">
          <b>#${i + 1}</b>
          <span>${new Date(t.ts).toLocaleTimeString()}</span>
          <button class="ghost t-play" ${t._buf ? '' : 'disabled title="历史会话不含录音缓冲"'}>▶</button>
          <button class="ghost t-x">${t.excluded ? '恢复' : '排除'}</button>
          <button class="ghost t-del">删</button>
        </div>
        <div class="take-f">f₁ ${t.f1.toFixed(2)} Hz
          (${t.f1Cents >= 0 ? '+' : ''}${t.f1Cents.toFixed(1)}¢) ·
          B ${t.B.toExponential(2)} · 置信 ${t.conf.toFixed(2)} ·
          SNR ${t.snr.toFixed(0)}dB · 稳定 ${(t.stableMs / 1000).toFixed(2)}s
          ${t.clip ? '· <b class=bad>削波</b>' : ''}</div>
        <div class="take-p">选用分音: ${checks}</div>
        <div class="take-effect"></div>`;
      let playing = false;
      li.querySelector('.t-play').addEventListener('click', () => {
        if (!t._buf) return;
        if (playing) { PianoAudio.stop(); playing = false; }
        else { PianoAudio.playBuffer(t._buf); playing = true; }
      });
      li.querySelector('.t-x').addEventListener('click', () => {
        t.excluded = !t.excluded; renderTakes(); renderAggregate();
      });
      li.querySelector('.t-del').addEventListener('click', () => {
        const k = keyState(m);
        k.captures = k.captures.filter(x => x !== t);
        renderTakes(); renderAggregate(); window.PianoApp.renderInputTable();
      });
      li.querySelectorAll('[data-use]').forEach(cb => cb.addEventListener('change', () => {
        t.use[cb.dataset.use] = cb.checked; renderAggregate();
      }));
      list.appendChild(li);
    }
    renderAggregate();
  }

  function renderAggregate() {
    const m = cap.m, agg = aggregate(m);
    if (!Object.keys(agg.meds).length) {
      $('#cap-aggregate').innerHTML = '尚无合格测量';
      $('#cap-agg-effect').textContent = '';
      return;
    }
    const rows = Object.entries(agg.meds).sort((a, b) => +a[0] - +b[0])
      .map(([n, f]) => `<span class="ag-p"><b>${n === '1' ? 'f₁' : n}</b> ${f.toFixed(2)} Hz
        <i>±${agg.spread[n].toFixed(1)}¢</i></span>`).join('');
    const f1c = cents(fExpected(m), agg.meds[1]);
    $('#cap-aggregate').innerHTML =
      `<div class="ag-title">${agg.n} 次测量中位数 · 离散度 (最大偏差) · ` +
      `B 拟合 <b>${agg.B.toExponential(2)}</b> · f₁ ${f1c >= 0 ? '+' : ''}${f1c.toFixed(1)}¢</div>
       <div class="ag-rows">${rows}</div><div id="cap-agg-effect" class="ag-effect"></div>`;
    refreshEffects(m);
  }

  function confirmWrite() {
    const m = cap.m, agg = aggregate(m);
    if (!Object.keys(agg.meds).length) return toast('没有可写回的分音', true);
    const k = keyState(m, true);
    k.measures = {};
    for (const [n, f] of Object.entries(agg.meds)) k.measures[n] = round(f, 3);
    window.PianoApp.renderInputTable();
    if ($('#cap-write').checked) window.PianoApp.scheduleAnalyze();
    toast(`${noteName(m)} 选中分音中位数已写回输入表${$('#cap-write').checked ? ', 已重算曲线' : ''}`);
  }
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  // ------------------------------------------------------------ 绘图

  function setupCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {ctx, w, h};
  }

  function drawSpectrum(r) {
    const cv = $('#cap-spectrum');
    const {ctx, w, h} = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const mag = r.mag, sr = r.sr, dF = r.dF ?? (sr / (mag.length * 2));
    const fLo = r.fExp * 0.45, fHi = Math.min(sr * 0.46, r.fExp * 9.2);
    const xOf = f => w * Math.log2(f / fLo) / Math.log2(fHi / fLo);
    let dbMax = -20;
    for (let k = 2; k < mag.length - 1; k++) dbMax = Math.max(dbMax, db(mag[k]));
    const dbLo = -80, dbHi = Math.max(-30, dbMax + 6);
    const yOf = v => h - 4 - (v - dbLo) / (dbHi - dbLo) * (h - 18);

    ctx.strokeStyle = '#2a333f'; ctx.fillStyle = '#7d8898'; ctx.font = '10px sans-serif';
    for (let n = 1; n <= 8; n++) {
      const f = n * r.fExp;
      if (f > fHi) break;
      const x = xOf(f);
      ctx.strokeStyle = n === 1 ? '#3a4656' : '#222a35';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke();
      ctx.fillText(`${n}f`, x + 2, h - 3);
    }
    // 噪声底
    ctx.strokeStyle = '#5a6575'; ctx.setLineDash([3, 3]); ctx.beginPath();
    for (let k = Math.floor(fLo / dF); k < mag.length && k * dF < fHi; k += 4) {
      const v = noiseDbAt(cap.noisePow, k * dF, dF), x = xOf(k * dF), y = yOf(v);
      k === Math.floor(fLo / dF) ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    // 频谱
    ctx.strokeStyle = '#8fd6ff'; ctx.beginPath();
    for (let k = Math.floor(fLo / dF); k < mag.length && k * dF < fHi; k++) {
      const x = xOf(k * dF), y = yOf(db(mag[k]));
      k === Math.floor(fLo / dF) ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 候选峰 → 分音标记
    const colors = {1: '#e0a84e', 2: '#6ec07a', 3: '#5ab0e8'};
    for (const [ns, p] of Object.entries(r.partials || {})) {
      const n = +ns, x = xOf(p.f), y = yOf(p.db);
      ctx.fillStyle = colors[n] || '#c07be0';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(String(n), x - 3, y - 7);
    }
    ctx.fillStyle = '#7d8898'; ctx.font = '10px sans-serif';
    ctx.fillText('频率 (对数轴, 虚线=环境噪声底)', 6, 12);
  }

  function drawPitch(r) {
    const cv = $('#cap-pitch');
    const {ctx, w, h} = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const track = r.track || [];
    if (!track.length) {
      ctx.fillStyle = '#7d8898'; ctx.font = '11px sans-serif';
      ctx.fillText('音高轨迹 (录音中实时绘制)', 8, 16);
      return;
    }
    const tLo = 0, tHi = Math.max(1, track[track.length - 1].t);
    const xOf = t => 8 + t / tHi * (w - 16);
    const cLo = -40, cHi = 40;
    const yOf = c => 8 + (1 - (c - cLo) / (cHi - cLo)) * (h - 20);
    ctx.fillStyle = 'rgba(110,192,122,.12)';
    ctx.fillRect(8, yOf(5), w - 16, yOf(-5) - yOf(5));
    ctx.strokeStyle = '#3a4656';
    for (const c of [-30, -10, 0, 10, 30]) {
      ctx.beginPath(); ctx.moveTo(8, yOf(c)); ctx.lineTo(w - 8, yOf(c)); ctx.stroke();
    }
    ctx.strokeStyle = '#e0a84e'; ctx.lineWidth = 1.6; ctx.beginPath();
    track.forEach((b, i) => {
      const c = cents(r.fExp, b.f), x = xOf(b.t), y = yOf(Math.max(cLo, Math.min(cHi, c)));
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#7d8898'; ctx.font = '10px sans-serif';
    ctx.fillText('相对平均律音分 (绿带 ±5¢ 稳定区)', 6, 12);
  }

  function drawResult(r) { drawSpectrum(r); drawPitch(r); }

  function drawLive() {
    if (cap.mode === 'idle' || cap.mode === 'noise') return;
    if (cap.pending) return;                 // 已出分析结果, 保留稳定段频谱
    const buf = concatRecent(LIVE_N);
    if (!buf) return;
    const {mag} = spectrum([buf], LIVE_N, cap.sr);
    const fExp = fExpected(cap.m);
    drawSpectrum({mag, sr: cap.sr, fExp, partials: cap.pending?.partials || {},
      dF: cap.sr / LIVE_N});
    if (cap.mode === 'rec' && cap.blocks.length)
      drawPitch({track: cap.blocks, fExp});
  }

  function loop(ts) {
    if (!cap.stream) return;
    cap.raf = requestAnimationFrame(loop);
    if (ts - cap.lastDraw > 200) {
      cap.lastDraw = ts;
      drawLive();
      // 待机时也刷新输入电平与信噪比
      if ((cap.mode === 'armed' || cap.mode === 'noise') && cap._live && !cap.pending) {
        const {rms, peak} = cap._live;
        const snr = cap.noiseRms > 0 ? db(rms) - db(cap.noiseRms) : 0;
        setMeters({rms, peak, clip: 0, stable: 0, snr: cap.mode === 'armed' ? snr : null});
      }
    }
  }

  // ------------------------------------------------------------ 表头/缓冲

  function pushRing(chunk) {
    cap.ring.push(chunk);
    cap.ringS += chunk.length;
    const maxS = cap.sr * 0.6;
    while (cap.ringS > maxS && cap.ring.length > 1)
      cap.ringS -= cap.ring.shift().length;
  }
  function concatRecent(nSamples) {
    let need = nSamples, out = [];
    for (let i = cap.ring.length - 1; i >= 0 && need > 0; i--) {
      const c = cap.ring[i], take = c.subarray(Math.max(0, c.length - need));
      out.unshift(take); need -= take.length;
    }
    if (!out.length) return null;
    return concat(out);
  }
  function concat(arrs) {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Float32Array(n);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }
  function rmsOf(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  }
  function peakOf(a) {
    let p = 0;
    for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
    return p;
  }
  function countClip(a) {
    let n = 0;
    for (let i = 0; i < a.length; i += 8) if (Math.abs(a[i]) >= 0.999) n++;
    return n;
  }
  function toBuffer(full, sr) {
    const b = window.PianoAudio.ac().createBuffer(1, full.length, sr);
    b.copyToChannel(full, 0);
    return b;
  }

  // ------------------------------------------------------------ 仪表/闸门 UI

  function setMeters(v) {
    const set = (sel, val, max) => $(sel).style.width =
      `${Math.max(0, Math.min(1, val / max)) * 100}%`;
    if (!v) {
      ['#m-level', '#m-snr', '#m-stable', '#m-clip'].forEach(s => $(s).style.width = 0);
      ['#v-level', '#v-snr', '#v-stable', '#v-clip'].forEach(s => $(s).textContent = '—');
      return;
    }
    set('#m-level', v.rms ? Math.max(0, db(v.rms) + 60) : 0, 60);
    $('#v-level').textContent = v.rms ? `${db(v.rms).toFixed(0)} dBFS` : '—';
    if (v.snr != null) {
      set('#m-snr', v.snr, 40);
      $('#v-snr').textContent = `${v.snr.toFixed(0)} dB`;
      $('#m-snr').classList.toggle('badbar', v.snr < GATE.snr);
    }
    if (v.stable != null) {
      set('#m-stable', v.stable / 1000, 2);
      $('#v-stable').textContent = `${(v.stable / 1000).toFixed(2)} s`;
    }
    if (v.clip != null) {
      $('#m-clip').style.width = v.clip ? 100 : 0;
      $('#v-clip').innerHTML = v.clip ? '<span class="bad">削波!</span>' : '正常';
    }
  }
  function updateMeters(v) {
    if (cap.mode !== 'rec') return setMeters(v);
    setMeters(v);
  }

  function renderGates(gates) {
    const ul = $('#cap-gates');
    ul.innerHTML = '';
    for (const g of gates) {
      const li = document.createElement('li');
      li.className = g.ok ? 'ok' : 'bad';
      li.innerHTML = `<b>${g.ok ? '✓' : '✗'} ${g.label}</b> ${g.val}` +
        (g.ok ? '' : ` <i>(需 ${g.need})</i>`);
      ul.appendChild(li);
    }
  }

  function debounce(fn, ms) {
    let h;
    return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
  }

  // ------------------------------------------------------------ 琴键选择/接线

  function populateKeys() {
    const sel = $('#cap-key');
    sel.innerHTML = '';
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = `${noteName(m)}  (MIDI ${m})`;
      sel.appendChild(o);
    }
    sel.value = cap.m;
  }

  function selectKey(m) {
    if (cap.mode === 'rec') {
      toast('录音中, 请先停止本次录音', true);
      $('#cap-key').value = cap.m;
      return;
    }
    cap.m = m;
    $('#cap-key').value = m;
    cap.pending = null;
    $('#btn-accept').classList.add('hidden');
    $('#btn-discard').classList.add('hidden');
    $('#btn-rec').textContent = cap.mode === 'armed'
      ? '录单次击弦' : '① 点选琴键后录单次击弦';
    $('#cap-phase').textContent = '';
    renderTakes();
    window.PianoApp?.renderCapSel?.();
  }

  function init() {
    populateKeys();
    $('#cap-key').addEventListener('change', e => selectKey(+e.target.value));
    $('#btn-mic').addEventListener('click', enableMic);
    $('#btn-rec').addEventListener('click', () => {
      if (cap.mode === 'rec') { finishRec(true); return; }
      if (cap.mode !== 'armed') return;
      // 丢弃上一次未处理的分析, 立即解除冷却, 等待电平触发
      cap.pending = null;
      cap.armT = 0;
      $('#btn-accept').classList.add('hidden');
      $('#btn-discard').classList.add('hidden');
      $('#cap-phase').textContent = '等待击弦 (电平自动触发)…';
    });
    $('#btn-accept').addEventListener('click', acceptPending);
    $('#btn-discard').addEventListener('click', discardPending);
    $('#btn-confirm').addEventListener('click', confirmWrite);
    // 初始空频谱/音高画布
    drawSpectrum({mag: new Float32Array(FFT_N / 2), sr: 48000,
      fExp: fExpected(cap.m), partials: {}});
    drawPitch({track: [], fExp: fExpected(cap.m)});
    renderTakes();
  }

  window.PianoCapture = {
    selectKey,
    reset() {                       // 会话切换/载入示范时清空
      for (const k of window.PianoApp.state.keys.values())
        for (const t of k.captures || []) delete t._buf;
      cap.pending = null;
      if (cap.stream) stopMic();
      renderTakes();
    },
    // 历史会话测量由 app.js hydrate 直接放入 state.keys[m].captures
    refreshCurrentEffects() { refreshEffects(cap.m); },
    // 纯计算函数 (测试/自检用)
    _test: {fft, spectrum, identify, fitAB, median, predF},
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initWhenReady);
  else initWhenReady();

  // app.js 在本模块之后加载; 等 window.PianoApp 就绪
  function initWhenReady() {
    if (window.PianoApp) init();
    else setTimeout(initWhenReady, 30);
  }
})();
