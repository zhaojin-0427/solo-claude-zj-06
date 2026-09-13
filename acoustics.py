"""钢琴非谐性与拉伸律核心计算。

约定:
- MIDI 键号 m: 21(A0) .. 108(C8), A4 = 69
- 第 n 次分音频率: f_n = n * f1 * sqrt(1 + B * n^2)
- 音分偏移 s_m: 目标频率 f = f_et * 2**(s/1200), f_et 为平均律频率
"""
import math

MIDI_MIN, MIDI_MAX, A4 = 21, 108, 69
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def note_name(m):
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def f_et(m, a4=440.0):
    return a4 * 2.0 ** ((m - A4) / 12.0)


def partial_freq(f1, B, n):
    return n * f1 * math.sqrt(1.0 + B * n * n)


def cents_between(f1, f2):
    return 1200.0 * math.log2(f2 / f1)


# ---------------------------------------------------------------- 非谐性拟合

def fit_inharmonic(measures, pweights):
    """由实测基频与分音联合拟合 (f1, B)。

    (f_n / n)^2 = a + b * n^2,  a = f1^2, b = f1^2 * B  —— 加权最小二乘。
    measures: {分音序号 n: 频率}; pweights: {n: 权重}。
    返回 (f1_fit, B) 或 None。
    """
    pts = [(n * n, (f / n) ** 2, pweights.get(n, 1.0))
           for n, f in measures.items() if f and f > 0]
    if not pts:
        return None
    sw = swx = swy = swxx = swxy = 0.0
    for x, y, w in pts:
        sw += w
        swx += w * x
        swy += w * y
        swxx += w * x * x
        swxy += w * x * y
    det = sw * swxx - swx * swx
    if abs(det) < 1e-30:
        return None
    a = (swy * swxx - swx * swxy) / det
    b = (sw * swxy - swx * swy) / det
    if a <= 0:
        return None
    return math.sqrt(a), max(b / a, 1e-8)


def interpolate_B(fitted, extension='moderate'):
    """对全部 88 键给出 log10(B) 的平滑插值。

    fitted: {m: B}。边缘按 extension 方案: flat(持平) / moderate(半斜率) / full(全斜率)。
    """
    ms = sorted(fitted)
    logb = {m: math.log10(fitted[m]) for m in ms}
    out = {}
    slope_lo = slope_hi = 0.0
    if len(ms) >= 2:
        slope_lo = (logb[ms[1]] - logb[ms[0]]) / (ms[1] - ms[0])
        slope_hi = (logb[ms[-1]] - logb[ms[-2]]) / (ms[-1] - ms[-2])
    k = {'flat': 0.0, 'moderate': 0.5, 'full': 1.0}.get(extension, 0.5)
    floor, cap = -7.5, -1.5
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        if m in logb:
            v = logb[m]
        elif m < ms[0]:
            v = logb[ms[0]] + k * slope_lo * (m - ms[0])
        elif m > ms[-1]:
            v = logb[ms[-1]] + k * slope_hi * (m - ms[-1])
        else:
            for i in range(len(ms) - 1):
                if ms[i] <= m <= ms[i + 1]:
                    t = (m - ms[i]) / (ms[i + 1] - ms[i])
                    v = logb[ms[i]] + t * (logb[ms[i + 1]] - logb[ms[i]])
                    break
        out[m] = 10.0 ** min(max(v, floor), cap)
    return out


# ---------------------------------------------------------------- 约束与求解

def _constraint_specs(cfg):
    """生成 (低音键 i, 高音键 j, 低分音 b, 高分音 p, 权重)。"""
    rule = cfg.get('rule', 'octave')
    p = int(cfg.get('oct_partial', 1))          # 八度匹配 2p:p
    w = {'octave': (1.0, 0.0, 0.0),
         'twelfth': (0.5, 1.0, 0.25),
         'double': (0.5, 0.25, 1.0),
         'balanced': (1.0, 0.6, 0.4)}[rule]
    specs = []
    for i in range(MIDI_MIN, MIDI_MAX + 1):
        if i + 12 <= MIDI_MAX:
            specs.append((i, i + 12, 2 * p, p, w[0], '八度 %d:%d' % (2 * p, p)))
        if i + 19 <= MIDI_MAX:
            specs.append((i, i + 19, 3, 1, w[1], '十二度 3:1'))
        if i + 24 <= MIDI_MAX:
            specs.append((i, i + 24, 4, 1, w[2], '双八度 4:1'))
    return [s for s in specs if s[4] > 0]


def _constraint_cents(spec, a4, Bmap, strength):
    """零拍匹配所需的 s_j - s_i (音分)。"""
    i, j, b, p, _, _ = spec
    dm = j - i
    d = 1200.0 * (math.log2(b / p)
                  + 0.5 * math.log2(1 + Bmap[i] * b * b)
                  - 0.5 * math.log2(1 + Bmap[j] * p * p)
                  - dm / 12.0)
    return strength * d


def solve_stretch(a4, Bmap, cfg, locks=None):
    """加权最小二乘求解 88 键音分偏移 s。locks: [{m, cents?}]。

    目标: 匹配约束 (s_j-s_i=d)^2 + 二阶平滑正则 + 锁定键大权重 + A4 锚定。
    返回 (s dict, specs)。
    """
    import numpy as np
    n = MIDI_MAX - MIDI_MIN + 1
    A = np.zeros((n, n))
    rhs = np.zeros(n)
    specs = _constraint_specs(cfg)
    strength = float(cfg.get('strength', 1.0))
    # 用户 0~1 的平滑滑杆映射为正则权重 (约束量级约为 1)
    sm_w = 0.25 * float(cfg.get('smooth', 0.5)) ** 2

    def add_pin(m, w, c=0.0):
        k = m - MIDI_MIN
        A[k, k] += w
        rhs[k] += w * c

    for sp in specs:
        i, j = sp[0], sp[1]
        d = _constraint_cents(sp, a4, Bmap, strength)
        w = sp[4]
        vi, vj = i - MIDI_MIN, j - MIDI_MIN
        A[vi, vi] += w
        A[vj, vj] += w
        A[vi, vj] -= w
        A[vj, vi] -= w
        rhs[vi] -= w * d
        rhs[vj] += w * d

    for k in range(1, n - 1):                       # (s_{k-1}-2s_k+s_{k+1})^2
        A[k - 1, k - 1] += sm_w
        A[k, k] += 4 * sm_w
        A[k + 1, k + 1] += sm_w
        A[k - 1, k] -= 2 * sm_w
        A[k, k - 1] -= 2 * sm_w
        A[k, k + 1] -= 2 * sm_w
        A[k + 1, k] -= 2 * sm_w
        A[k - 1, k + 1] += sm_w
        A[k + 1, k - 1] += sm_w

    add_pin(A4, 1e7, 0.0)                           # A4 基准固定
    for lk in (locks or []):
        if lk.get('cents') is not None:
            add_pin(lk['m'], 5e4, float(lk['cents']))

    svec = np.linalg.solve(A + np.eye(n) * 1e-9, rhs)
    s = {MIDI_MIN + k: float(svec[k]) for k in range(n)}

    # 未指定音分的锁: 用首轮解回填后再解一次
    free_locks = [lk for lk in (locks or []) if lk.get('cents') is None]
    if free_locks:
        return solve_stretch(a4, Bmap, cfg,
                             [{'m': lk['m'], 'cents': s[lk['m']]} for lk in locks])
    return s, specs


def constraint_beats(s, a4, Bmap, specs):
    """用求得的目标频率回算每条匹配约束的实际拍频 (Hz)。"""
    rows = []
    for sp in specs:
        i, j, b, p, w, label = sp
        fi = f_et(i, a4) * 2 ** (s[i] / 1200)
        fj = f_et(j, a4) * 2 ** (s[j] / 1200)
        lo = partial_freq(fi, Bmap[i], b)
        hi = partial_freq(fj, Bmap[j], p)
        rows.append({'i': i, 'j': j, 'b': b, 'p': p, 'w': w, 'label': label,
                     'f_partial': 0.5 * (lo + hi), 'beat': lo - hi})
    return rows


# ---------------------------------------------------------------- 方案预设

CANDIDATE_PRESETS = [
    {'id': 'oct21_flat',   'name': '八度 2:1 · 平直延伸',
     'rule': 'octave', 'oct_partial': 1, 'extension': 'flat', 'strength': 1.0},
    {'id': 'oct42_mod',    'name': '八度 4:2 · 适度延伸',
     'rule': 'octave', 'oct_partial': 2, 'extension': 'moderate', 'strength': 1.0},
    {'id': 'twelfth_mod',  'name': '十二度 3:1 · 适度延伸',
     'rule': 'twelfth', 'oct_partial': 1, 'extension': 'moderate', 'strength': 1.0},
    {'id': 'dbl_full',     'name': '双八度 4:1 · 完全延伸',
     'rule': 'double', 'oct_partial': 1, 'extension': 'full', 'strength': 1.05},
    {'id': 'bal_mod',      'name': '三规则平衡 · 适度延伸',
     'rule': 'balanced', 'oct_partial': 1, 'extension': 'moderate', 'strength': 1.0},
    {'id': 'oct63_full',   'name': '八度 6:3 · 完全延伸',
     'rule': 'octave', 'oct_partial': 3, 'extension': 'full', 'strength': 1.08},
]


def score_solution(s, beat_rows, locks, a4):
    """方案评分: 最大拍频误差 / 曲线平滑度 / 锁定键改动量, 归一为越小越好。"""
    max_beat = max((abs(r['beat']) for r in beat_rows), default=0.0)
    sm = sum((s[m + 1] - 2 * s[m] + s[m - 1]) ** 2
             for m in range(MIDI_MIN + 1, MIDI_MAX))
    lockdev = 0.0
    for lk in (locks or []):
        if lk.get('cents') is not None:
            lockdev += abs(s[lk['m']] - float(lk['cents']))
    return {'max_beat': max_beat, 'smooth': sm / 1000.0, 'lock_change': lockdev}


# ---------------------------------------------------------------- 冲突检测

def detect_conflicts(keys, s, Bmap, beat_rows, cfg, fitted_B):
    confs = []
    tol_dev = float(cfg.get('tol_dev', 25.0))
    tol_kink = float(cfg.get('tol_kink', 6.0))

    # 1) 实测基频偏离目标容差
    for k in keys:
        if k.get('f_meas'):
            if abs(k['meas_cents']) > tol_dev:
                confs.append({'type': '测量偏离', 'notes': [k['m']],
                              'msg': f"{k['name']} 实测偏离目标 {k['meas_cents']:+.1f} 音分 "
                                     f"(容差 ±{tol_dev:.0f})"})

    # 2) 相邻段突跳: 目标曲线二阶差分
    for m in range(MIDI_MIN + 1, MIDI_MAX):
        d2 = s[m + 1] - 2 * s[m] + s[m - 1]
        if abs(d2) > tol_kink:
            confs.append({'type': '曲线突跳', 'notes': [m - 1, m, m + 1],
                          'msg': f"{note_name(m)} 附近曲线二阶跳变 {d2:+.1f} 音分 "
                                 f"(阈值 ±{tol_kink:.0f})"})

    # 拟合 B 的相邻跳跳变 (实测键之间, 按每半音归一)
    ms = sorted(fitted_B)
    for a, b in zip(ms, ms[1:]):
        if b - a <= 3:
            dl_per_step = abs(math.log10(fitted_B[b])
                              - math.log10(fitted_B[a])) / (b - a)
            if dl_per_step > 0.12:
                confs.append({'type': '非谐性突跳', 'notes': [a, b],
                              'msg': f"{note_name(a)}→{note_name(b)} 非谐性 B "
                                     f"相差 {10 ** (dl_per_step * (b - a)):.1f} 倍, "
                                     f"疑似测量或弦组异常"})

    # 3) 匹配规则拍频超限 → 指出琴键与冲突的规则 (容差随分音频率按音分计)
    tol_bc = float(cfg.get('tol_beat_cents', 2.0))
    for r in beat_rows:
        limit = max(0.5, r['f_partial'] * tol_bc / 1200 * math.log(2))
        if abs(r['beat']) > limit:
            confs.append({'type': '拍频冲突', 'notes': [r['i'], r['j']],
                          'msg': f"{note_name(r['i'])}–{note_name(r['j'])} {r['label']} "
                                 f"残余拍频 {r['beat']:+.2f} Hz (容差 ±{limit:.1f})",
                          'rule': r['label']})
    return confs


# ---------------------------------------------------------------- 调律顺序

def tuning_order():
    """标准调律顺序: A4/A3 与平均律区(F3~E4), 再半音下探低音、上探高音。

    每个新键的低八度都已先调好, 可直接做八度核对。
    """
    order = [69, 57]                       # A4, A3
    order += [64, 59, 66, 61, 56, 63, 58, 65, 60, 55, 62, 68, 67, 54, 53]
    order += list(range(52, MIDI_MIN - 1, -1))   # E3 半音下行 → A0
    order += list(range(70, MIDI_MAX + 1))       # A#4 半音上行 → C8
    seen, out = set(), []
    for m in order:
        if MIDI_MIN <= m <= MIDI_MAX and m not in seen:
            seen.add(m)
            out.append(m)
    assert len(out) == 88 and len(set(out)) == 88
    return out
