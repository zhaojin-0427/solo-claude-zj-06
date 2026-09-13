"""钢琴拉伸律 Web 工作台 — Flask + SQLite 后端。"""
import json
import os
import sqlite3
import time

from flask import Flask, g, jsonify, render_template, request

import acoustics as ac
from acoustics import A4, MIDI_MAX, MIDI_MIN, cents_between, f_et, fit_inharmonic
from acoustics import interpolate_B, solve_stretch, constraint_beats
from acoustics import CANDIDATE_PRESETS, score_solution, detect_conflicts, tuning_order
from demo import build_demo

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


init_db()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
