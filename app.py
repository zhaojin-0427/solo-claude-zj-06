"""钢琴拉伸律 Web 工作台 — Flask + SQLite 后端。"""
import json
import math
import os
import sqlite3
import time

from flask import Flask, g, jsonify, render_template, request

import acoustics as ac
from acoustics import A4, MIDI_MAX, MIDI_MIN, cents_between, f_et, fit_inharmonic
from acoustics import interpolate_B, solve_stretch, constraint_beats
from acoustics import CANDIDATE_PRESETS, score_solution, detect_conflicts, tuning_order
from demo import build_demo

try:
    import numpy  # noqa: F401  (solve_stretch 内使用; 提前失败以便提示安装)
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        '缺少运行依赖 numpy (调律曲线求解需要)。\n'
        '请先安装: python3 -m pip install -r requirements.txt'
    ) from e

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'tuning.db')

app = Flask(__name__)


def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def _close(_):
    d = g.pop('db', None)
    if d:
        d.close()


def init_db():
    con = sqlite3.connect(DB)
    con.executescript("""
    CREATE TABLE IF NOT EXISTS sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, input TEXT, created REAL
    );
    CREATE TABLE IF NOT EXISTS schemes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER, name TEXT, cfg TEXT, result TEXT,
      locked INTEGER DEFAULT 0, created REAL
    );
    CREATE TABLE IF NOT EXISTS jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, phase TEXT,               -- pending|coarse|fine|review|frozen
      source TEXT,                          -- 来源方案冻结快照 (cfg/result/a4/tol)
      scheme_id INTEGER, session_id INTEGER,
      created REAL, updated REAL
    );
    CREATE TABLE IF NOT EXISTS job_rounds(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER, idx INTEGER, kind TEXT,  -- coarse|fine|review
      scope TEXT,                             -- 本轮处理键 [m]
      started REAL, finished REAL
    );
    CREATE TABLE IF NOT EXISTS job_meas(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER, round_id INTEGER, m INTEGER,
      f_meas REAL, cents REAL, beat_max REAL,
      reason TEXT, ts REAL
    );
    CREATE TABLE IF NOT EXISTS job_locks(
      job_id INTEGER, m INTEGER, round_id INTEGER, ts REAL,
      PRIMARY KEY (job_id, m)
    );
    CREATE TABLE IF NOT EXISTS job_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER, round_id INTEGER, m INTEGER, kind TEXT,
      data TEXT, ts REAL
    );
    CREATE INDEX IF NOT EXISTS idx_job_meas ON job_meas(job_id, m);
    CREATE TABLE IF NOT EXISTS retests(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, status TEXT,               -- pending|collecting|confirmed
      source TEXT,                          -- 来源快照: 冻结作业 + 完工基线
      job_id INTEGER,
      tol_cents REAL,                       -- 漂移容差 (音分)
      tol_beat_cents REAL, tol_beat_hz REAL,
      created REAL, updated REAL
    );
    CREATE TABLE IF NOT EXISTS retest_rounds(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retest_id INTEGER, idx INTEGER,
      label TEXT, planned_ts REAL,          -- 复测时点 (计划)
      temp REAL, humidity REAL,             -- 室温 / 湿度
      started REAL, finished REAL
    );
    CREATE TABLE IF NOT EXISTS retest_meas(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retest_id INTEGER, round_id INTEGER, m INTEGER,
      f_meas REAL, cents REAL,              -- cents 相对完工基线
      ts REAL
    );
    CREATE TABLE IF NOT EXISTS retest_locks(
      retest_id INTEGER, m INTEGER, ts REAL,
      PRIMARY KEY (retest_id, m)
    );
    CREATE TABLE IF NOT EXISTS retest_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retest_id INTEGER, round_id INTEGER, m INTEGER, kind TEXT,
      data TEXT, ts REAL
    );
    CREATE INDEX IF NOT EXISTS idx_rt_meas ON retest_meas(retest_id, round_id, m);
    """)
    con.commit()
    con.close()


# ---------------------------------------------------------------- 分析管线

def run_analysis(inp, cfg):
    a4 = float(inp.get('a4', 440.0))
    raw_keys = inp.get('keys', [])
    pweights = {int(n): float(w) for n, w in (inp.get('pweights') or {}).items()}
    pweights.setdefault(1, 1.0)

    fitted, measured = {}, {}
    for k in raw_keys:
        m = int(k['m'])
        if not MIDI_MIN <= m <= MIDI_MAX:
            continue
        measures = {int(n): float(f) for n, f in (k.get('measures') or {}).items()
                    if f}
        fit = fit_inharmonic(measures, pweights) if measures else None
        f_meas = measures.get(1)
        measured[m] = {'m': m, 'name': ac.note_name(m), 'f_meas': f_meas,
                       'fit': fit, 'n_partials': len(measures)}
        if fit:
            fitted[m] = fit[1]

    if not fitted:
        return {'error': '没有任何含实测分音的琴键, 无法拟合非谐性。'}

    Bmap = interpolate_B(fitted, cfg.get('extension', 'moderate'))
    locks = inp.get('locks') or []
    s, specs = solve_stretch(a4, Bmap, cfg, locks)
    beat_rows = constraint_beats(s, a4, Bmap, specs)

    keys = []
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        md = measured.get(m)
        k = {'m': m, 'name': ac.note_name(m), 'f_et': f_et(m, a4),
             'B': Bmap[m], 'fitted': md is not None and md['fit'] is not None,
             'measured': md is not None,
             'f_target': f_et(m, a4) * 2 ** (s[m] / 1200),
             'cents': s[m]}
        k['f_meas'] = md['f_meas'] if md else None
        k['n_partials'] = md['n_partials'] if md else 0
        k['meas_cents'] = (cents_between(k['f_target'], k['f_meas'])
                           if md and md['f_meas'] else None)
        keys.append(k)

    score = score_solution(s, beat_rows, locks, a4)
    confs = detect_conflicts(keys, s, Bmap, beat_rows, cfg, fitted)
    return {'a4': a4, 'keys': keys, 'beat_rows': beat_rows,
            'fitted_B': {str(m): fitted[m] for m in sorted(fitted)},
            'score': score, 'conflicts': confs}


def run_candidates(inp):
    """比较多组权重/延伸组合。锁定键改动量 = 锁定值相对该配置无锁自然曲线的偏离。"""
    locks = inp.get('locks') or []
    out = []
    for pc in CANDIDATE_PRESETS:
        cfg = {'smooth': 0.5, 'tol_dev': 25, 'tol_beat_cents': 2.0,
               'tol_kink': 6, **pc}
        r_locked = run_analysis(inp, cfg)
        if 'error' in r_locked:
            return r_locked
        score = dict(r_locked['score'])
        if locks:
            r_free = run_analysis({**inp, 'locks': []}, cfg)
            nat = {k['m']: k['cents'] for k in r_free['keys']}
            score['lock_change'] = sum(
                abs(lk['cents'] - nat[lk['m']]) for lk in locks
                if lk.get('cents') is not None and lk['m'] in nat)
        out.append({'id': pc['id'], 'name': pc['name'], 'cfg': pc,
                    'score': score, 'n_conflicts': len(r_locked['conflicts'])})
    return out


# ---------------------------------------------------------------- 路由

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/demo')
def api_demo():
    return jsonify(build_demo(float(request.args.get('a4', 440))))


@app.route('/api/analyze', methods=['POST'])
def api_analyze():
    body = request.get_json(force=True)
    cfg = body.get('cfg') or {}
    cfg.setdefault('smooth', 0.5)
    cfg.setdefault('tol_dev', 25.0)
    cfg.setdefault('tol_beat_cents', 2.0)
    cfg.setdefault('tol_kink', 6.0)
    return jsonify(run_analysis(body, cfg))


@app.route('/api/candidates', methods=['POST'])
def api_candidates():
    return jsonify(run_candidates(request.get_json(force=True)))


@app.route('/api/checkcard', methods=['POST'])
def api_checkcard():
    body = request.get_json(force=True)
    r = run_analysis(body, body.get('cfg') or {})
    if 'error' in r:
        return jsonify(r), 400
    bym = {k['m']: k for k in r['keys']}
    cards = []
    for idx, m in enumerate(tuning_order(), 1):
        k = bym.get(m)
        if not k:
            continue
        checks = []
        for up, name in ((12, '八度'), (19, '十二度'), (24, '双八度')):
            hi = bym.get(m + up)
            if hi:
                b, p = (2, 1) if up == 12 else (3, 1) if up == 19 else (4, 1)
                fb = ac.partial_freq(k['f_target'], k['B'], b)
                fp = ac.partial_freq(hi['f_target'], hi['B'], p)
                checks.append({'name': name, 'note_hi': hi['name'],
                               'beat': fb - fp,
                               'f_hi_target': hi['f_target']})
        cards.append({'order': idx, 'm': m, 'name': k['name'],
                      'f_target': k['f_target'], 'cents': k['cents'],
                      'f_meas': k['f_meas'], 'meas_cents': k['meas_cents'],
                      'locked': any(l['m'] == m for l in body.get('locks', [])),
                      'checks': checks})
    return jsonify({'cards': cards, 'conflicts': r['conflicts']})


@app.route('/api/measure-effects', methods=['POST'])
def api_measure_effects():
    """预览浏览器采集的候选分音对该键 B 与目标音分的影响。

    variants: [{"id": "BASE"|"ALL"|"测量id", "measures": {分音序号: 频率},
                "replace": bool}];
    replace=True 时用 measures 替换该键; 否则把该键已有的其他测量合成值
    (未被本变体覆盖的分音取其中位数) 并入后再跑完整分析。
    """
    import copy
    body = request.get_json(force=True)
    inp = body.get('input') or {}
    cfg = body.get('cfg') or {}
    m = int(body['m'])

    # 该键既有测量 (input.keys 中的 measures 为已写回值)
    existing = {}
    for k in inp.get('keys', []):
        if int(k['m']) == m:
            existing = {int(n): float(f) for n, f in (k.get('measures') or {}).items()
                        if f}

    def med_by_partial(captures, skip_id=None):
        vals = {}
        for t in captures:
            if skip_id and str(t.get('id')) == str(skip_id):
                continue
            if t.get('excluded'):
                continue
            use = t.get('use') or {}
            for ns, p in (t.get('partials') or {}).items():
                n = int(ns)
                if use.get(str(n)) is False or use.get(n) is False:
                    continue
                vals.setdefault(n, []).append(float(p['f']))
        return {n: sorted(v)[len(v) // 2] for n, v in vals.items() if v}

    captures = next((k.get('captures') or [] for k in inp.get('keys', [])
                     if int(k['m']) == m), [])
    out = []
    for v in body.get('variants') or []:
        inp2 = copy.deepcopy(inp)
        keys = [k for k in inp2.get('keys', []) if int(k['m']) != m]
        measures = {int(n): float(f) for n, f in (v.get('measures') or {}).items()
                    if f}
        if not v.get('replace', True) and captures:
            base = med_by_partial(captures, skip_id=v.get('id'))
            for n, f in base.items():
                measures.setdefault(n, f)
        elif not v.get('replace') and existing:
            for n, f in existing.items():
                measures.setdefault(n, f)
        if measures:
            keys.append({'m': m, 'measures': measures})
        inp2['keys'] = keys
        r = run_analysis(inp2, cfg)
        if 'error' in r:
            out.append({'id': v.get('id'), 'ok': False, 'error': r['error']})
            continue
        kk = next(k for k in r['keys'] if k['m'] == m)
        out.append({'id': v.get('id'), 'ok': True, 'B': kk['B'],
                    'fitted': kk['fitted'], 'cents': kk['cents'],
                    'f_target': kk['f_target']})
    return jsonify(out)


@app.route('/api/sessions', methods=['GET', 'POST'])
def api_sessions():
    con = db()
    if request.method == 'POST':
        body = request.get_json(force=True)
        sid = body.get('id')
        if sid and con.execute('SELECT 1 FROM sessions WHERE id=?', (sid,)).fetchone():
            con.execute('UPDATE sessions SET name=?, input=?, created=? WHERE id=?',
                        (body.get('name', '未命名方案'),
                         json.dumps(body.get('input', {})), time.time(), sid))
        else:
            cur = con.execute(
                'INSERT INTO sessions(name,input,created) VALUES(?,?,?)',
                (body.get('name', '未命名方案'), json.dumps(body.get('input', {})),
                 time.time()))
            sid = cur.lastrowid
        con.commit()
        return jsonify({'id': sid})
    rows = con.execute(
        'SELECT id,name,created FROM sessions ORDER BY id DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/sessions/<int:sid>', methods=['GET', 'DELETE'])
def api_session(sid):
    con = db()
    if request.method == 'DELETE':
        con.execute('DELETE FROM schemes WHERE session_id=?', (sid,))
        con.execute('DELETE FROM sessions WHERE id=?', (sid,))
        con.commit()
        return jsonify({'ok': True})
    row = con.execute('SELECT * FROM sessions WHERE id=?', (sid,)).fetchone()
    if not row:
        return jsonify({'error': 'not found'}), 404
    schemes = con.execute(
        'SELECT id,name,cfg,result,locked,created FROM schemes WHERE session_id=? '
        'ORDER BY id', (sid,)).fetchall()
    out = []
    for s in schemes:
        d = dict(s)
        d['cfg'] = json.loads(d['cfg'])
        d['result'] = json.loads(d['result']) if d['result'] else None
        out.append(d)
    return jsonify({'id': row['id'], 'name': row['name'],
                    'input': json.loads(row['input']), 'schemes': out})


@app.route('/api/schemes', methods=['POST'])
def api_schemes():
    body = request.get_json(force=True)
    sid = int(body['session_id'])
    con = db()
    cur = con.execute(
        'INSERT INTO schemes(session_id,name,cfg,result,locked,created) '
        'VALUES(?,?,?,?,?,?)',
        (sid, body.get('name', 'v'), json.dumps(body.get('cfg', {})),
         json.dumps(body.get('result', {})),
         int(body.get('locked_count', 0)), time.time()))
    con.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/schemes/<int:scid>', methods=['DELETE'])
def api_scheme_delete(scid):
    con = db()
    con.execute('DELETE FROM schemes WHERE id=?', (scid,))
    con.commit()
    return jsonify({'ok': True})


# ---------------------------------------------------------------- 逐键调律作业

# (音程半音数, 名称, 低分音 b, 高分音 p)
JOB_INTERVALS = ((12, '八度', 2, 1), (19, '十二度', 3, 1), (24, '双八度', 4, 1))
DEFAULT_TOL_CENTS = 5.0          # 单键偏离目标容差 (音分)
DEFAULT_TOL_BEAT_CENTS = 4.0     # 拍频音分阈值 (方案残拍/高音快拍需要的余量)
DEFAULT_TOL_BEAT_HZ = 0.8        # 低音区分音低, 绝对拍频宽限


def _beat_cents(beat, fp):
    """拍频 Hz 折算为高音分音频率的音分。"""
    return 1200.0 * math.log2((fp + beat) / fp)


def _beat_limit(fp, tol_cents, tol_hz):
    """音程拍频容差: 音分阈值随分音频率换算, 低音区以绝对 Hz 兜底放宽。"""
    return max(float(tol_hz), fp * float(tol_cents) / 1200.0 * math.log(2))


def _beat_over(beat, fp, tol_cents, tol_hz):
    """拍频是否越限: Hz 硬阈值且音分超 1.5 倍名义阈值 (临界迟滞, 防抖动返工)。"""
    lim = _beat_limit(fp, tol_cents, tol_hz)
    over = abs(beat) > lim and abs(_beat_cents(beat, fp)) > tol_cents * 1.5
    return over, lim


def _get_job(con, jid):
    row = con.execute('SELECT * FROM jobs WHERE id=?', (jid,)).fetchone()
    if not row:
        return None
    j = dict(row)
    j['source'] = json.loads(j['source']) if j['source'] else {}
    return j


def _job_targets(src):
    """来源方案 → {m: {name, f_target, cents, B}} 与 a4。"""
    a4 = float(src.get('a4', 440.0))
    out = {}
    for k in src.get('result', {}).get('keys', []):
        out[int(k['m'])] = {'name': k['name'], 'f_target': float(k['f_target']),
                            'cents': float(k['cents']), 'B': float(k['B'])}
    return a4, out


def _rounds(con, jid):
    rows = con.execute(
        'SELECT * FROM job_rounds WHERE job_id=? ORDER BY idx', (jid,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d['scope'] = set(json.loads(d['scope'] or '[]'))
        out.append(d)
    return out


def _latest_meas(con, jid):
    """每键最新一条测量 → {m: row(dict)}。"""
    rows = con.execute("""
      SELECT * FROM job_meas t WHERE id =
        (SELECT MAX(id) FROM job_meas WHERE job_id=? AND m=t.m)
    """, (jid,)).fetchall()
    return {r['m']: dict(r) for r in rows}


def _all_meas(con, jid):
    return [dict(r) for r in con.execute(
        'SELECT * FROM job_meas WHERE job_id=? ORDER BY id', (jid,)).fetchall()]


def _locks(con, jid):
    return {r['m']: dict(r) for r in con.execute(
        'SELECT * FROM job_locks WHERE job_id=?', (jid,)).fetchall()}


def _beat_checks(targets, fmap, tol_b=DEFAULT_TOL_BEAT_CENTS,
                 tol_hz=DEFAULT_TOL_BEAT_HZ):
    """用各键当前实测基频计算音程拍频; 仅返回两端都有测值的音程。

    返回 checks: {m: [{up,name,note_hi,beat,beat_cents,fp,limit,over,hi_m}]}
    与 pair: 无向边列表。
    """
    pair = []
    checks = {}
    for m, lo in targets.items():
        fl = fmap.get(m)
        if fl is None:
            continue
        for up, name, b, p in JOB_INTERVALS:
            hm = m + up
            hi = targets.get(hm)
            fh = fmap.get(hm)
            if not hi or fh is None:
                continue
            bl = ac.partial_freq(fl, lo['B'], b)
            bh = ac.partial_freq(fh, hi['B'], p)
            beat = bl - bh
            fp = 0.5 * (bl + bh)
            # 两端都"恰好命中目标"时的固有残拍 (方案加权解残留)
            tbl = (ac.partial_freq(lo['f_target'], lo['B'], b)
                   - ac.partial_freq(hi['f_target'], hi['B'], p))
            over, lim = _beat_over(beat, fp, tol_b, tol_hz)
            row = {'up': up, 'name': name, 'hi_m': hm, 'note_hi': hi['name'],
                   'beat': beat, 'target_beat': tbl,
                   'beat_cents': _beat_cents(beat, fp),
                   'fp': fp, 'limit': lim, 'over': over}
            checks.setdefault(m, []).append(row)
            pair.append({'lo': m, 'hi': hm, 'up': up, 'name': name,
                         'beat': beat, 'beat_cents': row['beat_cents'],
                         'fp': fp, 'limit': lim, 'over': over})
    return checks, pair


def _failing_now(targets, latest, locks, tol_c, tol_b, tol_hz, scope=None):
    """当前最新测值下仍未达标的键: 自身偏离或处于任一越限音程端点。"""
    fmap = {m: r['f_meas'] for m, r in latest.items()}
    _, pair = _beat_checks(targets, fmap, tol_b, tol_hz)
    bad = {m for m, r in latest.items() if abs(r['cents']) > tol_c}
    for pr in pair:
        if pr['over']:
            bad.add(pr['lo'])
            bad.add(pr['hi'])
    if scope is not None:
        bad = {m for m in bad if m in scope}
    return {m for m in bad if m not in locks}


def _reopen_events(con, jid, targets, tol_c, tol_b, tol_hz, latest, locks=None):
    """未解决的重开事件: 受影响键当前仍未达标 (按最新测值判定)。"""
    locks = locks if locks is not None else _locks(con, jid)
    bad = _failing_now(targets, latest, locks, tol_c, tol_b, tol_hz)
    evs = []
    for r in con.execute(
            "SELECT * FROM job_events WHERE job_id=? AND kind='reopen' ORDER BY id",
            (jid,)).fetchall():
        d = dict(r)
        if d['m'] not in bad:
            continue
        d['data'] = json.loads(d['data'] or '{}')
        evs.append(d)
    return evs


def _job_detail(con, jid):
    j = _get_job(con, jid)
    if not j:
        return None
    src = j['source']
    a4, targets = _job_targets(src)
    tol_c = float(src.get('tol_cents', DEFAULT_TOL_CENTS))
    tol_b = float(src.get('tol_beat_cents', DEFAULT_TOL_BEAT_CENTS))
    tol_hz = float(src.get('tol_beat_hz', DEFAULT_TOL_BEAT_HZ))
    latest = _latest_meas(con, jid)
    locks = _locks(con, jid)
    rounds = _rounds(con, jid)
    cur = rounds[-1] if rounds else None
    cur_scope = cur['scope'] if cur else set()
    # 本轮每键最新测值 (推进完成判定只认当前轮记录)
    cur_meas = {}
    if cur:
        for r in con.execute(
                'SELECT * FROM job_meas WHERE job_id=? AND round_id=? ORDER BY id',
                (jid, cur['id'])).fetchall():
            cur_meas[r['m']] = dict(r)
    fmap = {m: r['f_meas'] for m, r in latest.items()}
    checks, pair = _beat_checks(targets, fmap, tol_b, tol_hz)
    # 以任一越限音程端点计为"拍频未达标"
    beat_bad = set()
    for pr in pair:
        if pr['over']:
            beat_bad.add(pr['lo'])
            beat_bad.add(pr['hi'])

    # 每键状态
    keys = []
    order = tuning_order()
    pos = {m: i for i, m in enumerate(order)}
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        t = targets.get(m)
        if not t:
            continue
        lm = latest.get(m)
        cm = cur_meas.get(m)
        chk = checks.get(m, [])
        bad_beats = [c for c in chk if c['over']]
        passing = bool(lm) and abs(lm['cents']) <= tol_c and m not in beat_bad
        # 本轮是否已测并达标 (锁定键本轮免测, 视为已完成)
        round_done = (bool(cm) and abs(cm['cents']) <= tol_c
                      and m not in beat_bad) or m in locks
        in_scope = m in cur_scope
        locked = m in locks
        if cur is None:
            status = 'pending'
        elif locked:
            status = 'locked'
        elif not in_scope:
            status = 'outside' if passing else 'outside-bad'
        elif round_done:
            status = 'done'
        else:
            status = 'open'
        round_idx = None
        if lm:
            rr = next((r for r in rounds if r['id'] == lm['round_id']), None)
            round_idx = rr['idx'] if rr else None
        keys.append({'m': m, 'name': t['name'], 'f_target': t['f_target'],
                     'target_cents': t['cents'], 'B': t['B'],
                     'f_meas': lm['f_meas'] if lm else None,
                     'cents': lm['cents'] if lm else None,
                     'round_idx': round_idx,
                     'cur_round_idx': cur['idx'] if (cur and cm) else None,
                     'ts': (cm or lm)['ts'] if (cm or lm) else None,
                     'reason': (cm or lm)['reason'] if (cm or lm) else None,
                     'beat_max': max((abs(c['beat_cents']) for c in chk), default=None),
                     'beat_rows': chk, 'locked': locked,
                     'in_scope': in_scope, 'passing': passing,
                     'round_done': round_done or locked, 'status': status,
                     'order': pos[m] + 1})

    # 重开事件 (未解决)
    reopens = []
    rid2idx = {r['id']: r['idx'] for r in rounds}
    for d in _reopen_events(con, jid, targets, tol_c, tol_b, tol_hz, latest, locks):
        reopens.append({'id': d['id'], 'm': d['m'],
                        'name': targets.get(d['m'], {}).get('name'),
                        'round_idx': rid2idx.get(d['round_id']),
                        'data': d['data']})

    # 队列: 当前轮范围内本轮未完成 (未在本轮测达标, 也未锁定), 按调律顺序
    queue = [k for k in sorted(keys, key=lambda k: k['order'])
             if k['in_scope'] and not k['round_done']]
    done_n = sum(1 for k in keys if k['passing'] or k['locked'])
    cur_done = sum(1 for k in keys if k['in_scope'] and k['round_done'])

    return {'job': {'id': j['id'], 'name': j['name'], 'phase': j['phase'],
                    'scheme_id': j['scheme_id'], 'session_id': j['session_id'],
                    'created': j['created'], 'updated': j['updated'],
                    'tol_cents': tol_c, 'tol_beat_cents': tol_b,
                    'tol_beat_hz': tol_hz,
                    'source_name': src.get('name'), 'a4': a4},
            'rounds': [{'id': r['id'], 'idx': r['idx'], 'kind': r['kind'],
                        'scope': sorted(r['scope']),
                        'started': r['started'], 'finished': r['finished']}
                       for r in rounds],
            'current_round': {'id': cur['id'], 'idx': cur['idx'], 'kind': cur['kind']}
                             if cur else None,
            'keys': keys, 'queue': queue, 'reopens': reopens,
            'done_count': done_n, 'total': len(keys),
            'cur_done': cur_done, 'cur_total': len(cur_scope),
            'locked_count': len(locks)}


@app.route('/api/jobs', methods=['GET', 'POST'])
def api_jobs():
    con = db()
    if request.method == 'POST':
        body = request.get_json(force=True)
        scid = int(body['scheme_id'])
        srow = con.execute(
            'SELECT s.*, ss.name AS session_name FROM schemes s '
            'LEFT JOIN sessions ss ON ss.id=s.session_id WHERE s.id=?',
            (scid,)).fetchone()
        if not srow:
            return jsonify({'error': '版本不存在, 请先在会话中保存该版本'}), 404
        result = json.loads(srow['result'])
        cfg = json.loads(srow['cfg'])
        src = {'scheme_id': scid, 'session_id': srow['session_id'],
               'name': srow['name'], 'cfg': cfg, 'result': result,
               'a4': result.get('a4', 440.0),
               'tol_cents': float(body.get('tol_cents', DEFAULT_TOL_CENTS)),
               'tol_beat_cents': float(body.get('tol_beat_cents',
                                                 DEFAULT_TOL_BEAT_CENTS)),
               'tol_beat_hz': float(body.get('tol_beat_hz',
                                             DEFAULT_TOL_BEAT_HZ)),
               'created': time.time()}
        now = time.time()
        cur = con.execute(
            'INSERT INTO jobs(name,phase,source,scheme_id,session_id,created,updated) '
            'VALUES(?,?,?,?,?,?,?)',
            (body.get('name') or f"{srow['session_name'] or '作业'} · {srow['name']}",
             'pending', json.dumps(src), scid, srow['session_id'], now, now))
        jid = cur.lastrowid
        con.commit()
        return jsonify({'id': jid})
    rows = con.execute('SELECT * FROM jobs ORDER BY id DESC').fetchall()
    out = []
    for r in rows:
        src = json.loads(r['source']) if r['source'] else {}
        nmeas = con.execute('SELECT COUNT(*) FROM job_meas WHERE job_id=?',
                            (r['id'],)).fetchone()[0]
        nlock = con.execute('SELECT COUNT(*) FROM job_locks WHERE job_id=?',
                            (r['id'],)).fetchone()[0]
        out.append({'id': r['id'], 'name': r['name'], 'phase': r['phase'],
                    'source_name': src.get('name'), 'created': r['created'],
                    'updated': r['updated'], 'n_meas': nmeas, 'n_locks': nlock})
    return jsonify(out)


@app.route('/api/jobs/<int:jid>')
def api_job(jid):
    con = db()
    d = _job_detail(con, jid)
    if not d:
        return jsonify({'error': 'not found'}), 404
    return jsonify(d)


@app.route('/api/jobs/<int:jid>/start', methods=['POST'])
def api_job_start(jid):
    """待开始 → 粗调: 建立覆盖 88 键的粗调轮。"""
    con = db()
    j = _get_job(con, jid)
    if not j:
        return jsonify({'error': 'not found'}), 404
    if j['phase'] != 'pending':
        return jsonify({'error': '作业已开始'}), 400
    now = time.time()
    cur = con.execute(
        'INSERT INTO job_rounds(job_id,idx,kind,scope,started,finished) '
        'VALUES(?,?,?,?,?,?)',
        (jid, 1, 'coarse', json.dumps(tuning_order()), now, None))
    con.execute("UPDATE jobs SET phase='coarse', updated=? WHERE id=?", (now, jid))
    con.execute("INSERT INTO job_events(job_id,round_id,m,kind,data,ts) "
                "VALUES(?,?,?,?,?,?)",
                (jid, cur.lastrowid, None, 'phase',
                 json.dumps({'phase': 'coarse'}), now))
    con.commit()
    return jsonify(_job_detail(con, jid))


@app.route('/api/jobs/<int:jid>/measure', methods=['POST'])
def api_job_measure(jid):
    """录入一轮测量: f_meas 手工或采集带入; 越限自动重开受影响完成键。"""
    con = db()
    j = _get_job(con, jid)
    if not j:
        return jsonify({'error': 'not found'}), 404
    if j['phase'] not in ('coarse', 'fine', 'review'):
        return jsonify({'error': '当前阶段不可录入测量'}), 400
    body = request.get_json(force=True)
    m = int(body['m'])
    f = float(body['f_meas'])
    rounds = _rounds(con, jid)
    cur = rounds[-1]
    if m not in cur['scope']:
        return jsonify({'error': f'{ac.note_name(m)} 不在本轮范围'}), 400
    if con.execute('SELECT 1 FROM job_locks WHERE job_id=? AND m=?', (jid, m)).fetchone():
        return jsonify({'error': '该键已锁定, 请先解锁'}), 400

    a4, targets = _job_targets(j['source'])
    t = targets.get(m)
    if not t or f <= 0:
        return jsonify({'error': '无效琴键或频率'}), 400
    cents = cents_between(t['f_target'], f)
    tol_c = float(j['source'].get('tol_cents', DEFAULT_TOL_CENTS))
    tol_b = float(j['source'].get('tol_beat_cents', DEFAULT_TOL_BEAT_CENTS))
    tol_hz = float(j['source'].get('tol_beat_hz', DEFAULT_TOL_BEAT_HZ))
    now = time.time()
    prev = _latest_meas(con, jid).get(m)
    n_before = con.execute(
        'SELECT COUNT(*) FROM job_meas WHERE job_id=? AND m=?', (jid, m)).fetchone()[0]
    con.execute(
        'INSERT INTO job_meas(job_id,round_id,m,f_meas,cents,reason,ts) '
        'VALUES(?,?,?,?,?,?,?)',
        (jid, cur['id'], m, f, cents, body.get('reason') or None, now))

    # 用最新测值重算全部音程拍频
    latest = _latest_meas(con, jid)
    locks = _locks(con, jid)
    fmap = {mm: r['f_meas'] for mm, r in latest.items()}
    checks, pair = _beat_checks(targets, fmap, tol_b, tol_hz)

    reopened, lock_warn = [], []

    def log_reopen(am, data):
        con.execute(
            "INSERT INTO job_events(job_id,round_id,m,kind,data,ts) "
            "VALUES(?,?,?,'reopen',?,?)",
            (jid, cur['id'], am, json.dumps(data, ensure_ascii=False), now))
        reopened.append(am)

    # 自身偏离越限 (有更早测值才算返工重开)
    if abs(cents) > tol_c and n_before:
        log_reopen(m, {'kind': 'deviation', 'interval': '本键偏离',
                       'trigger_m': m, 'trigger_name': t['name'],
                       'prev_cents': prev['cents'] if prev else None,
                       'new_cents': cents, 'tol': tol_c})

    # 音程拍频越限: 只检查以本次测量键 m 为端点的音程 (关联键),
    # 其他越限音程与本次测量无关, 不应进入待回查或改动返工统计。
    # 已有同类未解决事件时不重复记录。
    open_evs = _reopen_events(con, jid, targets, tol_c, tol_b, tol_hz, latest, locks)
    incident = [pr for pr in pair if pr['lo'] == m or pr['hi'] == m]
    for pr in incident:
        if not pr['over']:
            continue
        am = pr['hi'] if pr['lo'] == m else pr['lo']
        if am not in cur['scope']:
            continue
        other = latest.get(am)
        if not other or abs(other['cents']) > tol_c:
            continue                      # 对端本就未达标, 队列里自然会处理
        if am in locks:
            lock_warn.append({'m': am, 'name': targets[am]['name'],
                              'interval': pr['name'],
                              'beat_cents': pr['beat_cents']})
            continue
        dup = any(e['m'] == am and e['data'].get('interval') == pr['name']
                  and e['data'].get('trigger_m') == m for e in open_evs)
        if dup:
            continue
        data = {'kind': 'beat', 'interval': pr['name'],
                'trigger_m': m, 'trigger_name': t['name'], 'up': pr['up'],
                'prev_cents': other['cents'], 'new_cents': cents,
                'beat_hz': pr['beat'], 'beat_cents': pr['beat_cents'],
                'limit_hz': pr['limit'], 'tol': tol_b}
        log_reopen(am, data)

    con.execute('UPDATE jobs SET updated=? WHERE id=?', (now, jid))
    con.commit()
    d = _job_detail(con, jid)
    d['just'] = {'m': m, 'cents': cents, 'reopened': reopened,
                 'lock_warn': lock_warn}
    return jsonify(d)


@app.route('/api/jobs/<int:jid>/lock', methods=['POST'])
def api_job_lock(jid):
    con = db()
    j = _get_job(con, jid)
    if not j:
        return jsonify({'error': 'not found'}), 404
    if j['phase'] not in ('coarse', 'fine', 'review'):
        return jsonify({'error': '当前阶段不可锁定'}), 400
    body = request.get_json(force=True)
    m = int(body['m'])
    do_lock = bool(body.get('locked', True))
    cur = _rounds(con, jid)[-1]
    now = time.time()
    if do_lock:
        con.execute('INSERT OR IGNORE INTO job_locks(job_id,m,round_id,ts) '
                    'VALUES(?,?,?,?)', (jid, m, cur['id'], now))
        con.execute("INSERT INTO job_events(job_id,round_id,m,kind,data,ts) "
                    "VALUES(?,?,?,'lock','{}',?)", (jid, cur['id'], m, now))
    else:
        con.execute('DELETE FROM job_locks WHERE job_id=? AND m=?', (jid, m))
        con.execute("INSERT INTO job_events(job_id,round_id,m,kind,data,ts) "
                    "VALUES(?,?,?,'unlock','{}',?)", (jid, cur['id'], m, now))
    con.execute('UPDATE jobs SET updated=? WHERE id=?', (now, jid))
    con.commit()
    return jsonify(_job_detail(con, jid))


def _failing_scope(con, j, targets, tol_c, tol_b, tol_hz, scope=None):
    """未达标键 (含无测值) + 与它们有音程关系的关联键, 排除锁定。"""
    latest = _latest_meas(con, j['id'])
    locks = _locks(con, j['id'])
    bad = _failing_now(targets, latest, {}, tol_c, tol_b, tol_hz)
    # 无测值的键也算未达标
    bad |= {m for m in targets if m not in latest}
    if scope is not None:
        bad &= set(scope)
    related = set(bad)
    for m in list(bad):
        for up, *_ in JOB_INTERVALS:
            for am in (m - up, m + up):
                if am in targets:
                    related.add(am)
    return {m for m in related if m not in locks}


@app.route('/api/jobs/<int:jid>/advance', methods=['POST'])
def api_job_advance(jid):
    """结束当前轮: 粗调→精调(仅未达标及关联键) / 精调→精调或复核 / 复核→完成冻结。"""
    con = db()
    j = _get_job(con, jid)
    if not j:
        return jsonify({'error': 'not found'}), 404
    if j['phase'] not in ('coarse', 'fine', 'review'):
        return jsonify({'error': '当前阶段不可推进'}), 400
    a4, targets = _job_targets(j['source'])
    tol_c = float(j['source'].get('tol_cents', DEFAULT_TOL_CENTS))
    tol_b = float(j['source'].get('tol_beat_cents', DEFAULT_TOL_BEAT_CENTS))
    tol_hz = float(j['source'].get('tol_beat_hz', DEFAULT_TOL_BEAT_HZ))
    rounds = _rounds(con, jid)
    cur = rounds[-1]
    now = time.time()

    locks = _locks(con, jid)
    # 本轮每键最新测值 (完成判定只认当前轮记录)
    cur_meas = {}
    for r in con.execute(
            'SELECT * FROM job_meas WHERE job_id=? AND round_id=? ORDER BY id',
            (jid, cur['id'])).fetchall():
        cur_meas[r['m']] = dict(r)

    missing = sorted(m for m in cur['scope']
                     if m not in cur_meas and m not in locks)
    if missing:
        names = '、'.join(ac.note_name(m) for m in missing[:6])
        kind = {'coarse': '粗调', 'fine': '精调', 'review': '复核'}[cur['kind']]
        tail = '…' if len(missing) > 6 else ''
        return jsonify({'error':
            f'{kind}轮还有 {len(missing)} 个键未在本轮测量/锁定: {names}{tail}'}), 400

    # 本轮全部测完后, 用最新测值判断本轮范围内仍未达标的键
    latest = _latest_meas(con, jid)
    failing = _failing_now(targets, latest, locks, tol_c, tol_b, tol_hz,
                           scope=cur['scope'])

    if failing and cur['kind'] == 'review':
        return jsonify({'error':
            f'复核轮已测完但仍有 {len(failing)} 个键未达标, 需返工后重新复核'}), 400

    con.execute('UPDATE job_rounds SET finished=? WHERE id=?', (now, cur['id']))
    nxt_scope = _failing_scope(con, j, targets, tol_c, tol_b, tol_hz)

    if j['phase'] == 'review':
        # 本轮未测完或未达标均已在上方拦截; 冻结来源快照、最终测值与状态
        final = {str(m): {'f_meas': r['f_meas'], 'cents': r['cents']}
                 for m, r in latest.items()}
        con.execute("INSERT INTO job_events(job_id,round_id,m,kind,data,ts) "
                    "VALUES(?,?,?,?,?,?)",
                    (jid, cur['id'], None, 'freeze',
                     json.dumps({'final': final, 'rounds': len(rounds)},
                                ensure_ascii=False), now))
        con.execute("UPDATE jobs SET phase='frozen', updated=? WHERE id=?", (now, jid))
        con.commit()
        return jsonify(_job_detail(con, jid))

    # 粗调后必进精调 (即使全部达标也保留精调轮记录, 范围为空);
    # 精调后仍有未达标 → 再开精调轮 (仅未达标及关联键); 全部达标 → 复核
    if cur['kind'] == 'coarse':
        new_kind, phase, scope = 'fine', 'fine', sorted(nxt_scope)
    elif failing or nxt_scope:
        new_kind, phase, scope = 'fine', 'fine', sorted(nxt_scope)
    else:
        new_kind, phase, scope = 'review', 'review', sorted(targets)
    rc = con.execute(
        'INSERT INTO job_rounds(job_id,idx,kind,scope,started,finished) '
        'VALUES(?,?,?,?,?,?)',
        (jid, cur['idx'] + 1, new_kind, json.dumps(scope), now, None))
    con.execute("UPDATE jobs SET phase=?, updated=? WHERE id=?", (phase, now, jid))
    con.execute("INSERT INTO job_events(job_id,round_id,m,kind,data,ts) "
                "VALUES(?,?,?,?,?,?)",
                (jid, rc.lastrowid, None, 'phase',
                 json.dumps({'phase': phase, 'scope_n': len(scope)},
                            ensure_ascii=False), now))
    con.commit()
    return jsonify(_job_detail(con, jid))


@app.route('/api/jobs/<int:jid>/copy', methods=['POST'])
def api_job_copy(jid):
    """冻结后复制作业: 同一来源方案, 全新轮次。"""
    con = db()
    j = _get_job(con, jid)
    if not j:
        return jsonify({'error': 'not found'}), 404
    if j['phase'] != 'frozen':
        return jsonify({'error': '仅复核完成(冻结)的作业可复制'}), 400
    now = time.time()
    cur = con.execute(
        'INSERT INTO jobs(name,phase,source,scheme_id,session_id,created,updated) '
        "VALUES(?,'pending',?,?,?,?,?)",
        (f"{j['name']} (副本)", json.dumps(j['source']),
         j['scheme_id'], j['session_id'], now, now))
    con.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/jobs/<int:jid>/compare')
def api_job_compare(jid):
    """各轮并排: 每键每轮偏差/漂移、返工次数、最大拍频误差。"""
    con = db()
    j = _get_job(con, jid)
    if not j:
        return jsonify({'error': 'not found'}), 404
    a4, targets = _job_targets(j['source'])
    tol_c = float(j['source'].get('tol_cents', DEFAULT_TOL_CENTS))
    tol_b = float(j['source'].get('tol_beat_cents', DEFAULT_TOL_BEAT_CENTS))
    tol_hz = float(j['source'].get('tol_beat_hz', DEFAULT_TOL_BEAT_HZ))
    rounds = _rounds(con, jid)
    rmeta = {r['id']: r for r in rounds}
    by_round = {r['id']: {} for r in rounds}
    for r in _all_meas(con, jid):
        by_round[r['round_id']][r['m']] = r
    rework = {}
    for r in con.execute(
            "SELECT m, COUNT(*) c FROM job_events WHERE job_id=? AND kind='reopen' "
            'GROUP BY m', (jid,)).fetchall():
        rework[r['m']] = r['c']

    rows = []
    latest = _latest_meas(con, jid)
    fmap = {mm: rr['f_meas'] for mm, rr in latest.items()}
    chk_all, _ = _beat_checks(targets, fmap, tol_b, tol_hz)
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        t = targets.get(m)
        if not t:
            continue
        series = []
        for r in rounds:
            mm = by_round[r['id']].get(m)
            series.append(None if not mm else
                          {'cents': mm['cents'], 'f_meas': mm['f_meas'],
                           'ts': mm['ts'], 'reason': mm['reason']})
        vals = [s['cents'] for s in series if s]
        chk = chk_all.get(m, [])
        max_beat = max((abs(c['beat_cents']) for c in chk), default=None)
        rows.append({'m': m, 'name': t['name'], 'series': series,
                     'drift': (max(vals) - min(vals)) if len(vals) >= 2 else 0,
                     'rework': rework.get(m, 0),
                     'max_beat': max_beat,
                     'last_cents': vals[-1] if vals else None,
                     'passing': bool(vals) and abs(vals[-1]) <= tol_c
                                and all(not c['over'] for c in chk)})
    return jsonify({'rounds': [{'idx': r['idx'], 'kind': r['kind'],
                                'scope_n': len(r['scope'])} for r in rounds],
                    'rows': rows, 'tol_cents': tol_c,
                    'tol_beat_cents': tol_b, 'tol_beat_hz': tol_hz})


# ---------------------------------------------------------------- 音准稳定性复测

RT_DEFAULT_TOL_CENTS = 3.0     # 复测漂移容差 (音分)
RT_JUMP_MIN = 2.0              # 单键突变阈值下限 (音分), 实际取 max(2*tol, 此值)
RT_REGION_MIN = 3              # 同音区成片漂移最少连续键数


def _get_retest(con, rid):
    row = con.execute('SELECT * FROM retests WHERE id=?', (rid,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d['source'] = json.loads(d['source']) if d['source'] else {}
    return d


def _rt_rounds(con, rid):
    return [dict(r) for r in con.execute(
        'SELECT * FROM retest_rounds WHERE retest_id=? ORDER BY idx',
        (rid,)).fetchall()]


def _rt_meas(con, rid):
    """{round_id: {m: row}} — 同键同轮多次录入取最新一条。"""
    out = {}
    for r in con.execute(
            'SELECT * FROM retest_meas WHERE retest_id=? ORDER BY id', (rid,)):
        out.setdefault(r['round_id'], {})[r['m']] = dict(r)
    return out


def _rt_locks(con, rid):
    return {r['m'] for r in
            con.execute('SELECT m FROM retest_locks WHERE retest_id=?', (rid,))}


def _rt_active(rounds):
    return next((r for r in rounds if r['started'] and not r['finished']), None)


def _sign_runs(vals, thresh, min_len):
    """vals: {m: v}; 连续同号且 |v|>thresh 的键段 (长度 ≥ min_len)。"""
    runs, cur, cur_sign = [], [], 0
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        v = vals.get(m)
        s = 0 if v is None or abs(v) <= thresh else (1 if v > 0 else -1)
        if s and s == cur_sign:
            cur.append(m)
        else:
            if len(cur) >= min_len:
                runs.append(cur)
            cur = [m] if s else []
            cur_sign = s
    if len(cur) >= min_len:
        runs.append(cur)
    return runs


def _group_consecutive(flagged):
    """{m: payload} → 相邻键 (步进 1) 归并成 [(keys, payloads)]。"""
    groups, cur = [], []
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        if m in flagged:
            cur.append(m)
        elif cur:
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return [(g, [flagged[m] for m in g]) for g in groups]


def _rt_anomalies(considered, meas, baseline, tol_c, beats):
    """异常识别: 同音区成片漂移 / 单键突变 / 持续偏移 / 回稳。

    considered: 有测值的复测轮 (按 idx 排序); 以最后一轮为当前观察面。
    """
    out = []
    if not considered:
        return out
    latest = considered[-1]
    lid = latest['id']
    lmeas = meas.get(lid, {})
    drifts = {m: cents_between(baseline[m], r['f_meas'])
              for m, r in lmeas.items()}
    if len(considered) >= 2:
        prev_r = considered[-2]
        prev_map = {m: r['f_meas'] for m, r in meas.get(prev_r['id'], {}).items()}
    else:
        prev_r = None
        prev_map = baseline
    deltas = {m: cents_between(prev_map[m], r['f_meas'])
              for m, r in lmeas.items() if m in prev_map}
    pairs = beats.get(lid, [])

    def env_of(r):
        return {'temp': r['temp'], 'humidity': r['humidity']} if r else \
               {'temp': None, 'humidity': None}

    d_temp = d_hum = None
    if prev_r and latest['temp'] is not None and prev_r['temp'] is not None:
        d_temp = latest['temp'] - prev_r['temp']
    if prev_r and latest['humidity'] is not None and prev_r['humidity'] is not None:
        d_hum = latest['humidity'] - prev_r['humidity']

    def add(kind, keys, data):
        keys = sorted(keys)
        ks = set(keys)
        intervals = [{'lo': p['lo'], 'hi': p['hi'], 'name': p['name'],
                      'beat': p['beat'], 'beat_cents': p['beat_cents'],
                      'limit': p['limit']}
                     for p in pairs if p['over'] and (p['lo'] in ks or p['hi'] in ks)]
        out.append({'id': f"{kind}-{latest['idx']}-{keys[0]}", 'kind': kind,
                    'keys': keys, 'round_id': lid, 'round_idx': latest['idx'],
                    'round_label': latest['label'],
                    'env': {'cur': env_of(latest), 'prev': env_of(prev_r),
                            'd_temp': d_temp, 'd_humidity': d_hum},
                    'intervals': intervals, 'data': data})

    # 1) 同音区成片漂移: 当前轮相对完工值同向超差的连续键段
    for run in _sign_runs(drifts, tol_c, RT_REGION_MIN):
        vals = [drifts[m] for m in run]
        add('region', run, {'n': len(run), 'mean': sum(vals) / len(vals),
                            'max': max(vals, key=abs),
                            'direction': 'sharp' if vals[0] > 0 else 'flat'})

    # 2) 单键突变: 相邻两次复测间剧变, 且不属于同向成片移动
    jump_th = max(2.0 * tol_c, RT_JUMP_MIN)
    in_shift = set()
    for run in _sign_runs(deltas, jump_th, RT_REGION_MIN):
        in_shift.update(run)
    sudden = {m: deltas[m] for m in sorted(deltas)
              if abs(deltas[m]) > jump_th and m not in in_shift}
    for g, vals in _group_consecutive(sudden):
        add('sudden', g, {'deltas': {str(m): v for m, v in zip(g, vals)},
                          'thresh': jump_th})

    if len(considered) >= 2:
        # 各键逐轮相对完工漂移序列
        seqs = {}
        for m in range(MIDI_MIN, MIDI_MAX + 1):
            seq = []
            for r in considered:
                mm = meas.get(r['id'], {}).get(m)
                if mm:
                    seq.append((r['idx'], cents_between(baseline[m], mm['f_meas'])))
            seqs[m] = seq

        # 3) 持续偏移: 截至当前轮连续 ≥2 轮同向超差
        trail = {}
        for m, seq in seqs.items():
            run, sign = 0, 0
            for _, d in reversed(seq):
                s = 0 if abs(d) <= tol_c else (1 if d > 0 else -1)
                if s and (not sign or s == sign):
                    sign, run = s, run + 1
                else:
                    break
            if run >= 2:
                trail[m] = {'sign': sign, 'rounds': run, 'latest': seq[-1][1]}
        for g, vals in _group_consecutive(trail):
            add('persistent', g,
                {'rounds': max(v['rounds'] for v in vals),
                 'mean_latest': sum(v['latest'] for v in vals) / len(vals),
                 'direction': 'sharp' if vals[0]['sign'] > 0 else 'flat'})

        # 4) 回稳: 曾超差, 当前轮回到容差内
        stab = {}
        for m, seq in seqs.items():
            if len(seq) < 2 or abs(seq[-1][1]) > tol_c:
                continue
            worst_idx, worst = max(seq[:-1], key=lambda x: abs(x[1]))
            if abs(worst) > tol_c:
                stab[m] = {'worst': worst, 'worst_idx': worst_idx,
                           'now': seq[-1][1]}
        for g, vals in _group_consecutive(stab):
            w = max(vals, key=lambda v: abs(v['worst']))
            add('restabilize', g, {'worst': w['worst'], 'worst_idx': w['worst_idx'],
                                   'now': sum(v['now'] for v in vals) / len(vals)})

    kind_order = {'region': 0, 'sudden': 1, 'persistent': 2, 'restabilize': 3}
    out.sort(key=lambda a: (kind_order[a['kind']], a['keys'][0]))
    return out


def _rt_retune(targets, baseline, lmeas, pairs, locks, tol_c, pos):
    """回调清单: 超差键 (漂移/拍频) + 关联键, 排除锁定, 按调律顺序。"""
    drifts = {m: cents_between(baseline[m], r['f_meas'])
              for m, r in lmeas.items()}
    beat_bad = set()
    for p in pairs:
        if p['over']:
            beat_bad.add(p['lo'])
            beat_bad.add(p['hi'])
    core = ({m for m, d in drifts.items() if abs(d) > tol_c} | beat_bad) - locks
    related = set()
    for m in core:
        for up, *_ in JOB_INTERVALS:
            for am in (m - up, m + up):
                if am in targets and am not in core:
                    related.add(am)
    related -= locks
    entries = []
    for m in sorted(core | related, key=lambda x: pos[x]):
        d = drifts.get(m)
        mm = lmeas.get(m)
        is_core = m in core
        reasons = []
        if is_core:
            if d is not None and abs(d) > tol_c:
                reasons.append('偏离')
            if m in beat_bad:
                reasons.append('拍频')
        else:
            reasons.append('关联')
        entries.append({'m': m, 'name': targets[m]['name'], 'order': pos[m] + 1,
                        'kind': 'core' if is_core else 'related',
                        'drift': d, 'f_now': mm['f_meas'] if mm else None,
                        'f_base': baseline[m],
                        'adjust': -d if (is_core and d is not None) else None,
                        'reasons': reasons})
    return entries


def _retest_detail(con, rid):
    rt = _get_retest(con, rid)
    if not rt:
        return None
    src = rt['source']
    a4, targets = _job_targets(src['job_source'])
    baseline = {int(m): float(f) for m, f in src['baseline'].items()}
    tol_c = float(rt['tol_cents'])
    tol_b = float(rt['tol_beat_cents'])
    tol_hz = float(rt['tol_beat_hz'])
    rounds = _rt_rounds(con, rid)
    meas = _rt_meas(con, rid)
    locks = _rt_locks(con, rid)
    active = _rt_active(rounds)
    considered = [r for r in rounds if meas.get(r['id'])]
    latest_r = considered[-1] if considered else None

    # 各轮音程拍频 (八度/十二度/双八度)
    beats = {}
    for r in considered:
        fmap = {m: mm['f_meas'] for m, mm in meas[r['id']].items()}
        _, pair = _beat_checks(targets, fmap, tol_b, tol_hz)
        beats[r['id']] = pair

    anomalies = _rt_anomalies(considered, meas, baseline, tol_c, beats)

    order = tuning_order()
    pos = {m: i for i, m in enumerate(order)}
    keys = []
    for m in range(MIDI_MIN, MIDI_MAX + 1):
        t = targets.get(m)
        if not t:
            continue
        series = []
        prev_f = baseline[m]
        for r in rounds:
            mm = meas.get(r['id'], {}).get(m)
            if not mm:
                series.append(None)
                continue
            drift = cents_between(baseline[m], mm['f_meas'])
            delta = cents_between(prev_f, mm['f_meas'])
            series.append({'round_id': r['id'], 'idx': r['idx'],
                           'f': mm['f_meas'], 'drift': drift, 'delta': delta,
                           'ts': mm['ts']})
            prev_f = mm['f_meas']
        done = [s for s in series if s]
        keys.append({'m': m, 'name': t['name'], 'f_target': t['f_target'],
                     'target_cents': t['cents'], 'B': t['B'],
                     'f_base': baseline[m], 'series': series,
                     'latest': done[-1] if done else None,
                     'locked': m in locks})

    retune = []
    if latest_r:
        retune = _rt_retune(targets, baseline, meas[latest_r['id']],
                            beats[latest_r['id']], locks, tol_c, pos)

    return {'retest': {'id': rt['id'], 'name': rt['name'], 'status': rt['status'],
                       'job_id': rt['job_id'], 'job_name': src.get('job_name'),
                       'a4': a4, 'tol_cents': tol_c, 'tol_beat_cents': tol_b,
                       'tol_beat_hz': tol_hz,
                       'created': rt['created'], 'updated': rt['updated']},
            'rounds': [{'id': r['id'], 'idx': r['idx'], 'label': r['label'],
                        'planned_ts': r['planned_ts'], 'temp': r['temp'],
                        'humidity': r['humidity'], 'started': r['started'],
                        'finished': r['finished'],
                        'n_meas': len(meas.get(r['id'], {}))} for r in rounds],
            'active_round': active['id'] if active else None,
            'keys': keys, 'anomalies': anomalies,
            'beats': {str(qid): p for qid, p in beats.items()},
            'retune': retune, 'locks': sorted(locks),
            'view_round': latest_r['id'] if latest_r else None}


@app.route('/api/retests', methods=['GET', 'POST'])
def api_retests():
    con = db()
    if request.method == 'POST':
        body = request.get_json(force=True)
        jid = int(body['job_id'])
        j = _get_job(con, jid)
        if not j:
            return jsonify({'error': '来源作业不存在'}), 404
        if j['phase'] != 'frozen':
            return jsonify({'error': '仅已冻结的调律作业可作为复测来源'}), 400
        # 完工基线: 冻结事件中的最终测值, 缺测键退回目标频率
        ev = con.execute(
            "SELECT data FROM job_events WHERE job_id=? AND kind='freeze' "
            'ORDER BY id DESC LIMIT 1', (jid,)).fetchone()
        final = json.loads(ev['data']).get('final', {}) if ev else {}
        a4, targets = _job_targets(j['source'])
        baseline = {}
        for m, t in targets.items():
            fm = final.get(str(m))
            baseline[str(m)] = float(fm['f_meas']) \
                if fm and fm.get('f_meas') else t['f_target']
        src = {'job_id': jid, 'job_name': j['name'], 'a4': a4,
               'job_source': j['source'], 'baseline': baseline,
               'frozen_ts': j['updated']}
        now = time.time()
        cur = con.execute(
            'INSERT INTO retests(name,status,source,job_id,tol_cents,'
            'tol_beat_cents,tol_beat_hz,created,updated) '
            'VALUES(?,?,?,?,?,?,?,?,?)',
            (body.get('name') or f"{j['name']} · 稳定性复测", 'pending',
             json.dumps(src), jid,
             float(body.get('tol_cents', RT_DEFAULT_TOL_CENTS)),
             float(body.get('tol_beat_cents',
                            j['source'].get('tol_beat_cents',
                                            DEFAULT_TOL_BEAT_CENTS))),
             float(body.get('tol_beat_hz',
                            j['source'].get('tol_beat_hz',
                                            DEFAULT_TOL_BEAT_HZ))),
             now, now))
        rid = cur.lastrowid
        for i, r in enumerate(body.get('rounds') or [], 1):
            con.execute(
                'INSERT INTO retest_rounds(retest_id,idx,label,planned_ts) '
                'VALUES(?,?,?,?)',
                (rid, i, r.get('label') or f'第{i}次复测', r.get('planned_ts')))
        con.commit()
        return jsonify({'id': rid})
    rows = con.execute('SELECT * FROM retests ORDER BY id DESC').fetchall()
    out = []
    for r in rows:
        src = json.loads(r['source'] or '{}')
        nfin = con.execute(
            'SELECT COUNT(*) FROM retest_rounds '
            'WHERE retest_id=? AND finished IS NOT NULL',
            (r['id'],)).fetchone()[0]
        nall = con.execute(
            'SELECT COUNT(*) FROM retest_rounds WHERE retest_id=?',
            (r['id'],)).fetchone()[0]
        out.append({'id': r['id'], 'name': r['name'], 'status': r['status'],
                    'job_name': src.get('job_name'), 'tol_cents': r['tol_cents'],
                    'n_rounds': nall, 'n_finished': nfin,
                    'created': r['created'], 'updated': r['updated']})
    return jsonify(out)


@app.route('/api/retests/<int:rid>')
def api_retest(rid):
    con = db()
    d = _retest_detail(con, rid)
    if not d:
        return jsonify({'error': 'not found'}), 404
    return jsonify(d)


@app.route('/api/retests/<int:rid>/rounds', methods=['POST'])
def api_rt_add_round(rid):
    """添加复测时点 (静置后的计划时间)。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] == 'confirmed':
        return jsonify({'error': '档案已确认冻结, 新一轮复测请复制档案'}), 400
    body = request.get_json(force=True)
    rounds = _rt_rounds(con, rid)
    idx = (rounds[-1]['idx'] + 1) if rounds else 1
    con.execute(
        'INSERT INTO retest_rounds(retest_id,idx,label,planned_ts) '
        'VALUES(?,?,?,?)',
        (rid, idx, body.get('label') or f'第{idx}次复测', body.get('planned_ts')))
    con.execute('UPDATE retests SET updated=? WHERE id=?', (time.time(), rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/rounds/<int:qid>', methods=['DELETE'])
def api_rt_del_round(rid, qid):
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] == 'confirmed':
        return jsonify({'error': '档案已确认冻结'}), 400
    r = next((x for x in _rt_rounds(con, rid) if x['id'] == qid), None)
    if not r:
        return jsonify({'error': '复测时点不存在'}), 404
    if r['started']:
        return jsonify({'error': '该轮已开始, 不可删除'}), 400
    con.execute('DELETE FROM retest_rounds WHERE id=?', (qid,))
    con.execute('UPDATE retests SET updated=? WHERE id=?', (time.time(), rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/activate', methods=['POST'])
def api_rt_activate(rid):
    """开始一个计划中的复测轮 (同时记录室温/湿度)。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] == 'confirmed':
        return jsonify({'error': '档案已确认冻结, 新一轮复测请复制档案'}), 400
    body = request.get_json(force=True)
    qid = int(body['round_id'])
    rounds = _rt_rounds(con, rid)
    r = next((x for x in rounds if x['id'] == qid), None)
    if not r:
        return jsonify({'error': '复测时点不存在'}), 404
    if r['started']:
        return jsonify({'error': '该轮已开始'}), 400
    if _rt_active(rounds):
        return jsonify({'error': '已有进行中的复测轮, 请先完成本轮'}), 400
    now = time.time()
    con.execute(
        'UPDATE retest_rounds SET started=?, temp=?, humidity=? WHERE id=?',
        (now, body.get('temp'), body.get('humidity'), qid))
    con.execute("UPDATE retests SET status='collecting', updated=? WHERE id=?",
                (now, rid))
    con.execute(
        "INSERT INTO retest_events(retest_id,round_id,m,kind,data,ts) "
        "VALUES(?,?,?,'activate',?,?)",
        (rid, qid, None,
         json.dumps({'temp': body.get('temp'),
                     'humidity': body.get('humidity')}), now))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/env', methods=['POST'])
def api_rt_env(rid):
    """更新进行中复测轮的室温/湿度。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] != 'collecting':
        return jsonify({'error': '当前状态不可记录环境'}), 400
    active = _rt_active(_rt_rounds(con, rid))
    if not active:
        return jsonify({'error': '没有进行中的复测轮'}), 400
    body = request.get_json(force=True)
    con.execute('UPDATE retest_rounds SET temp=?, humidity=? WHERE id=?',
                (body.get('temp'), body.get('humidity'), active['id']))
    con.execute('UPDATE retests SET updated=? WHERE id=?', (time.time(), rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/measure', methods=['POST'])
def api_rt_measure(rid):
    """录入当前轮某键频率 (浏览器采集带入或手工录入)。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] == 'confirmed':
        return jsonify({'error': '档案已确认冻结, 测值不可再改'}), 400
    if rt['status'] != 'collecting':
        return jsonify({'error': '档案尚未开始复测, 请先开始一个复测轮'}), 400
    active = _rt_active(_rt_rounds(con, rid))
    if not active:
        return jsonify({'error': '没有进行中的复测轮, 请先开始本轮'}), 400
    body = request.get_json(force=True)
    m = int(body['m'])
    f = float(body['f_meas'])
    baseline = {int(k): float(v) for k, v in
                rt['source'].get('baseline', {}).items()}
    if m not in baseline or f <= 0:
        return jsonify({'error': '无效琴键或频率'}), 400
    cents = cents_between(baseline[m], f)
    now = time.time()
    con.execute(
        'INSERT INTO retest_meas(retest_id,round_id,m,f_meas,cents,ts) '
        'VALUES(?,?,?,?,?,?)',
        (rid, active['id'], m, f, cents, now))
    con.execute('UPDATE retests SET updated=? WHERE id=?', (now, rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/finish', methods=['POST'])
def api_rt_finish(rid):
    """完成当前轮: 需 88 键全部测齐。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] != 'collecting':
        return jsonify({'error': '当前状态不可完成复测轮'}), 400
    rounds = _rt_rounds(con, rid)
    active = _rt_active(rounds)
    if not active:
        return jsonify({'error': '没有进行中的复测轮'}), 400
    n = con.execute(
        'SELECT COUNT(DISTINCT m) FROM retest_meas WHERE round_id=?',
        (active['id'],)).fetchone()[0]
    total = MIDI_MAX - MIDI_MIN + 1
    if n < total:
        return jsonify({'error': f'本轮还有 {total - n} 个键未测量'}), 400
    now = time.time()
    con.execute('UPDATE retest_rounds SET finished=? WHERE id=?',
                (now, active['id']))
    con.execute(
        "INSERT INTO retest_events(retest_id,round_id,m,kind,data,ts) "
        "VALUES(?,?,?,'finish',?,?)",
        (rid, active['id'], None, json.dumps({'n_meas': n}), now))
    con.execute('UPDATE retests SET updated=? WHERE id=?', (now, rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/lock', methods=['POST'])
def api_rt_lock(rid):
    """锁定/解锁无需调整的键 (不进回调清单)。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] == 'confirmed':
        return jsonify({'error': '档案已确认冻结, 判断不可再改'}), 400
    body = request.get_json(force=True)
    m = int(body['m'])
    now = time.time()
    if body.get('locked', True):
        con.execute(
            'INSERT OR IGNORE INTO retest_locks(retest_id,m,ts) VALUES(?,?,?)',
            (rid, m, now))
        kind = 'lock'
    else:
        con.execute('DELETE FROM retest_locks WHERE retest_id=? AND m=?',
                    (rid, m))
        kind = 'unlock'
    con.execute(
        "INSERT INTO retest_events(retest_id,round_id,m,kind,data,ts) "
        "VALUES(?,?,?,?,'{}',?)",
        (rid, None, m, kind, now))
    con.execute('UPDATE retests SET updated=? WHERE id=?', (now, rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/confirm', methods=['POST'])
def api_rt_confirm(rid):
    """确认复测结论: 冻结全部测值与判断 (异常识别 + 回调清单快照)。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] != 'collecting':
        return jsonify({'error': '仅采集中的档案可确认'}), 400
    rounds = _rt_rounds(con, rid)
    if _rt_active(rounds):
        return jsonify({'error': '还有进行中的复测轮, 请先完成本轮'}), 400
    finished = [r for r in rounds if r['finished']]
    if not finished:
        return jsonify({'error': '尚无已完成的复测轮, 无法确认'}), 400
    d = _retest_detail(con, rid)
    now = time.time()
    con.execute(
        "INSERT INTO retest_events(retest_id,round_id,m,kind,data,ts) "
        "VALUES(?,?,?,'freeze',?,?)",
        (rid, None, None,
         json.dumps({'anomalies': d['anomalies'], 'retune': d['retune'],
                     'locks': d['locks'],
                     'rounds': [r['id'] for r in finished]},
                    ensure_ascii=False), now))
    con.execute("UPDATE retests SET status='confirmed', updated=? WHERE id=?",
                (now, rid))
    con.commit()
    return jsonify(_retest_detail(con, rid))


@app.route('/api/retests/<int:rid>/copy', methods=['POST'])
def api_rt_copy(rid):
    """确认后复制档案: 同一来源快照与容差, 全新复测轮次。"""
    con = db()
    rt = _get_retest(con, rid)
    if not rt:
        return jsonify({'error': 'not found'}), 404
    if rt['status'] != 'confirmed':
        return jsonify({'error': '仅已确认的档案可复制'}), 400
    now = time.time()
    cur = con.execute(
        'INSERT INTO retests(name,status,source,job_id,tol_cents,'
        'tol_beat_cents,tol_beat_hz,created,updated) '
        "VALUES(?,'pending',?,?,?,?,?,?,?)",
        (f"{rt['name']} (新一轮)", json.dumps(rt['source']), rt['job_id'],
         rt['tol_cents'], rt['tol_beat_cents'], rt['tol_beat_hz'], now, now))
    con.commit()
    return jsonify({'id': cur.lastrowid})


init_db()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
