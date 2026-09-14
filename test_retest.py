"""音准稳定性复测端到端自检 (不污染正式库, 使用临时数据库)。

流程: 示范琴 → 版本 → 冻结调律作业 → 建立复测档案 → 复测时点 →
两轮采集 (注入成片漂移/单键突变/持续偏移/回稳) → 拍频复查 →
锁定 → 回调清单 → 确认冻结 → 复制档案。

运行: python3 test_retest.py
"""
import os
import tempfile

_fd, TMP_DB = tempfile.mkstemp(suffix='.db')
os.close(_fd)
os.unlink(TMP_DB)

import app as appmod                       # noqa: E402

appmod.DB = TMP_DB
appmod.init_db()
client = appmod.app.test_client()

PASS = []


def check(name, cond, extra=''):
    assert cond, f'✗ {name} {extra}'
    PASS.append(name)
    print(f'✓ {name}')


def api(method, url, body=None, expect=200):
    r = getattr(client, method)(url, json=body)
    j = r.get_json()
    if r.status_code != expect:
        raise AssertionError(f'{method.upper()} {url} → {r.status_code}: {j}')
    return j


def post(url, body=None, expect=200):
    return api('post', url, body, expect)


def cents_f(base, cents):
    return base * 2.0 ** (cents / 1200.0)


# ---------------------------------------------------------------- 准备冻结作业
demo = client.get('/api/demo').get_json()
inp = {'name': demo['name'], 'a4': 440.0, 'keys': demo['keys'],
       'pweights': demo['pweights']}
cfg = {'rule': 'balanced', 'oct_partial': 1, 'extension': 'moderate',
       'strength': 1.0, 'smooth': 0.5, 'tol_dev': 25, 'tol_beat_cents': 2.0,
       'tol_kink': 6}
res = post('/api/analyze', {**inp, 'cfg': cfg})
check('分析示范琴', 'keys' in res and len(res['keys']) == 88)
ft = {k['m']: k['f_target'] for k in res['keys']}

sid = post('/api/sessions', {'name': '自检琴', 'input': inp})['id']
scid = post('/api/schemes', {'session_id': sid, 'name': 'v1',
                             'cfg': cfg, 'result': res})['id']
jid = post('/api/jobs', {'scheme_id': scid, 'tol_cents': 5})['id']
post(f'/api/jobs/{jid}/start')
for m in range(21, 109):                      # 粗调: 全部命中目标
    post(f'/api/jobs/{jid}/measure', {'m': m, 'f_meas': ft[m]})
d = post(f'/api/jobs/{jid}/advance')          # → 精调 (范围为空)
check('粗调全达标进精调', d['job']['phase'] == 'fine')
d = post(f'/api/jobs/{jid}/advance')          # → 复核 (88 键)
check('精调空轮进复核', d['job']['phase'] == 'review')
for m in range(21, 109):
    post(f'/api/jobs/{jid}/measure', {'m': m, 'f_meas': ft[m]})
d = post(f'/api/jobs/{jid}/advance')          # → 冻结
check('作业已冻结', d['job']['phase'] == 'frozen')

# ---------------------------------------------------------------- 建立档案
bad = post('/api/retests', {'job_id': jid, 'tol_cents': 3.0,
                            'tol_beat_cents': 2.0})
rid = bad['id']
check('档案初始为待复测', client.get(f'/api/retests/{rid}').get_json()
      ['retest']['status'] == 'pending')

# 未冻结作业不可作为来源
jid2 = post('/api/jobs', {'scheme_id': scid, 'tol_cents': 5})['id']
post('/api/retests', {'job_id': jid2}, expect=400)
check('非冻结作业被拒绝建档', True)

d = post(f'/api/retests/{rid}/rounds', {'label': '静置24h', 'planned_ts': 1900000000})
r1 = d['rounds'][0]['id']
d = post(f'/api/retests/{rid}/rounds', {'label': '静置72h', 'planned_ts': 1900100000})
r2 = d['rounds'][1]['id']
check('添加两个复测时点', len(d['rounds']) == 2)

# 待复测状态不可录测值
post(f'/api/retests/{rid}/measure', {'m': 69, 'f_meas': 440.0}, expect=400)
check('待复测状态拒绝录值', True)

d = post(f'/api/retests/{rid}/activate',
         {'round_id': r1, 'temp': 23.5, 'humidity': 48})
check('开始第1轮 → 采集中', d['retest']['status'] == 'collecting'
      and d['active_round'] == r1)
check('室温湿度已记录', d['rounds'][0]['temp'] == 23.5
      and d['rounds'][0]['humidity'] == 48)

base = {k['m']: k['f_base'] for k in d['keys']}
check('完工基线 = 冻结作业最终测值',
      all(abs(base[m] - ft[m]) < 1e-6 for m in range(21, 109)))

# 第1轮场景: 60~66 成片 +5¢; 80 单键 -7¢; 40 持续 +4¢; 50 暂偏 +5¢ (下轮回稳)
def drift_of(m, round_no):
    if 60 <= m <= 66:
        return 5.0
    if m == 80:
        return -7.0 if round_no == 1 else 0.0
    if m == 40:
        return 4.0
    if m == 50:
        return 5.0 if round_no == 1 else 0.5
    return ((m * 7) % 5 - 2) * 0.4            # ±0.8¢ 底噪

for m in range(21, 109):
    d = post(f'/api/retests/{rid}/measure',
             {'m': m, 'f_meas': cents_f(base[m], drift_of(m, 1))})
check('第1轮 88 键录齐', d['rounds'][0]['n_meas'] == 88)

anoms = {(a['kind'], a['keys'][0]): a for a in d['anomalies']}
check('识别同音区成片漂移',
      ('region', 60) in anoms and anoms[('region', 60)]['keys'] == list(range(60, 67)))
check('识别单键突变', ('sudden', 80) in anoms)
check('第1轮尚无持续偏移/回稳',
      not any(a['kind'] in ('persistent', 'restabilize') for a in d['anomalies']))
reg = anoms[('region', 60)]
check('成片漂移含受影响音程 (60→72 八度越限)',
      any(iv['lo'] == 60 and iv['hi'] == 72 for iv in reg['intervals']))
check('异常携带环境记录', reg['env']['cur']['temp'] == 23.5)

post(f'/api/retests/{rid}/finish')
check('第1轮完成', True)

# 完成本轮后才可开始下一轮; 环境变化 +2.5°C / +12%
post(f'/api/retests/{rid}/activate',
     {'round_id': r2, 'temp': 26.0, 'humidity': 60})
post(f'/api/retests/{rid}/env', {'temp': 26.0, 'humidity': 61})
for m in range(21, 109):
    d = post(f'/api/retests/{rid}/measure',
             {'m': m, 'f_meas': cents_f(base[m], drift_of(m, 2))})
d = post(f'/api/retests/{rid}/finish')
check('第2轮完成', all(r['finished'] for r in d['rounds']))

kinds = {}
for a in d['anomalies']:
    kinds.setdefault(a['kind'], []).append(a)
check('第2轮仍识别成片漂移', any(a['keys'] == list(range(60, 67))
                                 for a in kinds.get('region', [])))
pers_keys = {m for a in kinds.get('persistent', []) for m in a['keys']}
check('识别持续偏移 (40 与 60~66)', 40 in pers_keys
      and set(range(60, 67)) <= pers_keys)
check('识别回稳 (50)', any(a['keys'] == [50] for a in kinds.get('restabilize', [])))
re50 = next(a for a in kinds['restabilize'] if a['keys'] == [50])
check('回稳记录历史最差值', abs(re50['data']['worst'] - 5.0) < 0.01)
check('异常含环境变化 (+2.5°C)',
      abs(re50['env']['d_temp'] - 2.5) < 1e-6)

# 相邻复测漂移: 键50 第2轮 delta ≈ 0.5 - 5.0 = -4.5¢
k50 = next(k for k in d['keys'] if k['m'] == 50)
check('相邻复测漂移计算', abs(k50['series'][1]['delta'] - (-4.5)) < 0.01
      and abs(k50['series'][1]['drift'] - 0.5) < 0.01)

# 拍频复查: 60(+4) 与 72(~0) 的八度应越限
pairs2 = d['beats'][str(d['rounds'][1]['id'])]
p6072 = next(p for p in pairs2 if p['lo'] == 60 and p['up'] == 12)
check('八度拍频越限被复查出', p6072['over'])

# ---------------------------------------------------------------- 锁定与回调清单
core_before = {e['m'] for e in d['retune'] if e['kind'] == 'core'}
check('回调清单含超差键与拍频端点',
      set(range(60, 67)) <= core_before and 40 in core_before and 72 in core_before)
orders = [e['order'] for e in d['retune']]
check('回调清单沿用调律顺序', orders == sorted(orders))
check('关联键被纳入', any(e['kind'] == 'related' for e in d['retune']))

d = post(f'/api/retests/{rid}/lock', {'m': 60, 'locked': True})
core_after = {e['m'] for e in d['retune'] if e['kind'] == 'core'}
check('锁定键退出回调清单', 60 not in core_after and 60 in d['locks'])
d = post(f'/api/retests/{rid}/lock', {'m': 60, 'locked': False})
check('解锁恢复', 60 in {e['m'] for e in d['retune'] if e['kind'] == 'core'})

# ---------------------------------------------------------------- 确认冻结与复制
d = post(f'/api/retests/{rid}/confirm')
check('确认后状态=已确认', d['retest']['status'] == 'confirmed')
post(f'/api/retests/{rid}/measure', {'m': 69, 'f_meas': 440.0}, expect=400)
post(f'/api/retests/{rid}/rounds', {'label': 'x'}, expect=400)
post(f'/api/retests/{rid}/lock', {'m': 61, 'locked': True}, expect=400)
check('冻结后测值与判断不可再改', True)

ev = appmod.sqlite3.connect(TMP_DB).execute(
    "SELECT data FROM retest_events WHERE retest_id=? AND kind='freeze'",
    (rid,)).fetchone()
import json
snap = json.loads(ev[0])
check('冻结事件保存判断快照', bool(snap['anomalies']) and bool(snap['retune']))

rid2 = post(f'/api/retests/{rid}/copy')['id']
d2 = client.get(f'/api/retests/{rid2}').get_json()
check('复制档案为待复测/无轮次',
      d2['retest']['status'] == 'pending' and not d2['rounds'])
check('复制沿用同一完工基线',
      all(abs(k['f_base'] - base[k['m']]) < 1e-9 for k in d2['keys']))
post(f'/api/retests/{rid2}/copy', expect=400)
check('未确认档案不可复制', True)

lst = client.get('/api/retests').get_json()
check('档案列表', len(lst) == 2)

os.unlink(TMP_DB)
print(f'\n全部 {len(PASS)} 项检查通过。')
