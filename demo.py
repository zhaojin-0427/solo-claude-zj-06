"""生成一台示范琴的实测数据: 真实非谐性曲线 + 拉伸目标 + 测量噪声与异常点。"""
import math
import random

from acoustics import A4, MIDI_MAX, MIDI_MIN, f_et, partial_freq, solve_stretch

# log10(B) 的典型分段折线 (低音弦粗、中音最平直、高音又上升)
# log10(B) 的典型分段折线 (低音粗弦最大、中音最平直、高音再上升)
B_ANCHORS = {21: -2.92, 33: -3.60, 45: -4.40, 57: -4.95,
             69: -5.05, 81: -4.60, 96: -3.90, 108: -3.30}


def _true_logB(m):
    xs = sorted(B_ANCHORS)
    if m <= xs[0]:
        return B_ANCHORS[xs[0]]
    for a, b in zip(xs, xs[1:]):
        if a <= m <= b:
            t = (m - a) / (b - a)
            return B_ANCHORS[a] + t * (B_ANCHORS[b] - B_ANCHORS[a])
    return B_ANCHORS[xs[-1]]


def build_demo(a4=440.0, seed=7):
    rng = random.Random(seed)
    B_true = {}
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        lb = _true_logB(m) + rng.uniform(-0.02, 0.02)
        B_true[m] = 10.0 ** lb

    demo_cfg = {'rule': 'balanced', 'oct_partial': 1,
                'extension': 'moderate', 'strength': 1.0, 'smooth': 0.5}
    s_true, _ = solve_stretch(a4, B_true, demo_cfg)

    keys = []
    for m in range(MIDI_MIN, MIDI_MAX + 1, 3):         # 每 3 个键测一组
        f1 = f_et(m, a4) * 2 ** (s_true[m] / 1200.0)
        f1 *= 2 ** (rng.uniform(-0.03, 0.03) / 1200)      # ±0.03 音分基频噪声
        nmax = 6 if m < 84 else (4 if m < 96 else 3)
        measures = {1: f1}
        for n in range(2, nmax + 1):
            measures[n] = partial_freq(f1, B_true[m], n) * rng.uniform(0.99985, 1.00015)
        keys.append({'m': m, 'measures': measures})

    # 注入两个典型问题, 便于演示冲突定位
    bad1 = 87                      # G#6: 读错基频, 偏出容差
    f_bad = f_et(bad1, a4) * 2 ** ((s_true[bad1] + 38) / 1200.0)
    for k in keys:
        if k['m'] == bad1:
            k['measures'] = {1: f_bad, 2: partial_freq(f_bad, B_true[bad1], 2),
                             3: partial_freq(f_bad, B_true[bad1], 3)}
    weird = 90                    # F#6: B 异常偏大 (弦码/测量问题)
    B_weird = B_true[weird] * 6
    f2 = f_et(weird, a4) * 2 ** (s_true[weird] / 1200.0)
    for k in keys:
        if k['m'] == weird:
            k['measures'] = {n: partial_freq(f2, B_weird, n) * rng.uniform(0.9999, 1.0001)
                             for n in range(1, 5)}

    return {
        'a4': a4,
        'name': '示范琴 · 1926 Steinway B 风格',
        'keys': keys,
        'pweights': {str(n): 1.0 for n in range(2, 9)},
        'note': '含两处异常: G#6 基频读数偏离、F#6 非谐性突跳',
    }
