#!/usr/bin/env python3
"""
全校課表 Excel → timetable_XXX.csv + homerooms_XXX.json

輸入：學校的課表 Excel（需含工作表「教師課表」「教師資料」「作息時間表」）
  教師課表：長表格式，每列一筆 = 星期 / 週別 / 節次 / 班級 / 科目 / 教師 / 啟用
            （第一欄表頭可能是亂碼，這裡一律依「欄位順序」讀取）
輸出：
  timetable_<tag>.csv   以「教師」為列、以 s{星期}{節次}/c{星期}{節次} 為欄（節次 0~11）
  homerooms_<tag>.json  { "班級": "導師" }
  並在畫面印出「作息時間」的 config.js 片段

用法：
  pip install pandas openpyxl
  python scripts/xlsx_to_csv.py 全校115-1.xlsx s1            # 輸出到目前資料夾
  python scripts/xlsx_to_csv.py 全校115-1.xlsx s1 --report   # 只印診斷資訊
"""
import argparse, collections, csv, datetime, json, re, sys
import pandas as pd

DAYS = range(1, 6)           # 週一 ~ 週五
PERIODS = range(0, 12)       # 0=晨間, 1~9=第1~9節, 10~11=晚自習（國中）
CN_NUM = {'第一週': '一', '第二週': '二', '第三週': '三', '第四週': '四'}
HOMEROOM_RE = re.compile(r'^[1-9]0\d$')          # 101、702…（導師班）


# ───────────────────────── 讀取 ─────────────────────────
def read_excel(path):
    sheets = pd.read_excel(path, sheet_name=None)
    for need in ('教師課表', '教師資料', '作息時間表'):
        if need not in sheets:
            sys.exit(f'找不到工作表「{need}」，現有：{list(sheets)}')
    t = sheets['教師課表'].iloc[:, :7].copy()        # 第 8 欄起若有雜訊一律忽略
    t.columns = ['星期', '週別', '節次', '班級', '科目', '教師', '啟用']
    t = t.dropna(subset=['星期', '節次', '班級', '科目', '教師'])
    for c in ('班級', '科目', '教師'):
        t[c] = t[c].astype(str).str.strip()
    t['週別'] = t['週別'].fillna('').astype(str).str.strip()
    t['星期'] = t['星期'].astype(int)
    t['節次'] = t['節次'].astype(int)
    assert set(t['星期']) <= {1, 2, 3, 4, 5}, f"星期欄出現 1~5 以外的值：{set(t['星期'])}"
    t['啟用'] = t['啟用'].apply(lambda v: v is True or v == 1)
    return t, sheets['教師資料'], sheets['作息時間表']


def normalize_names(sched, roster):
    """課表寫「陳仕勛」、教師資料寫「黑洞-陳仕勛」→ 以教師資料的寫法為準（PDF 也是這種寫法）"""
    roster_names = set(roster['姓名'].astype(str).str.strip())
    mapping = {}
    for n in sorted(set(sched['教師'])):
        if n in roster_names:
            continue
        hits = [r for r in roster_names if r.endswith('-' + n)]
        if len(hits) == 1:
            mapping[n] = hits[0]
    sched['教師'] = sched['教師'].replace(mapping)
    unknown = sorted(set(sched['教師']) - roster_names)
    return mapping, unknown


# ───────────────────────── 週別標籤 ─────────────────────────
def week_label(weeks):
    """同一堂課（相同班級/科目/教師）在哪些週上 → 顯示用前綴；每週都上則回傳 ''"""
    ws = set(weeks)
    if '' in ws or ws >= {'單週', '雙週'} or ws >= set(CN_NUM):
        return ''
    if len(ws) == 1:
        return next(iter(ws))
    nums = [CN_NUM[w] for w in CN_NUM if w in ws]
    if nums and len(nums) == len(ws):
        return '第' + '、'.join(nums) + '週'
    return '、'.join(sorted(ws))


# ───────────────────────── 建立教師列 ─────────────────────────
def build_layers(act):
    # 先把「同班同科同師」跨週別合併成一個標籤
    merged = collections.defaultdict(set)
    for r in act.itertuples():
        merged[(r.教師, r.星期, r.節次, r.班級, r.科目)].add(r.週別)
    slots = collections.defaultdict(lambda: collections.defaultdict(set))  # (教師,d,p) → {科目標籤: {班級}}
    for (t, d, p, cls, subj), weeks in merged.items():
        wl = week_label(weeks)
        slots[(t, d, p)][f'{wl} {subj}' if wl else subj].add(cls)
    # CSV 一格只能放一個科目；同一教師同時段有不同內容（例如單週教 A 班、雙週教 B 班）
    # → 以「同名教師的第 2、3… 列」存放，前端會自動合併顯示
    layers = collections.defaultdict(list)
    multi = []
    for (t, d, p), subjmap in slots.items():
        items = sorted(subjmap.items())
        if len(items) > 1:
            multi.append((t, d, p, {k: sorted(v) for k, v in items}))
        for i, (label, classes) in enumerate(items):
            while len(layers[t]) <= i:
                layers[t].append({})
            layers[t][i][(d, p)] = (label, ' '.join(sorted(classes)))
    return layers, multi


# ───────────────────────── 導師 ─────────────────────────
def infer_homerooms(act, roster):
    """PDF/Excel 都沒有「班級→導師」對照，只能推定，並用教師資料的「職稱=導師」交叉驗證。
    規則 1：該班「班/週會」格的教師。
    規則 2：沒有時，採該班授課列數最多的教師，且 ≥ 40%、並至少為第 2 名的 2 倍（小學包班制）。"""
    hm, basis = {}, {}
    own = act[act['班級'].map(lambda c: bool(HOMEROOM_RE.match(c)))]
    for cls, g in own.groupby('班級'):
        names = set(g[g['科目'].isin(['班/週會', '班會', '週會'])]['教師'])
        if len(names) == 1:
            hm[cls], basis[cls] = names.pop(), '班/週會'
            continue
        cnt = g['教師'].value_counts()
        top = cnt.iloc[0]
        if top >= 0.4 * len(g) and (len(cnt) == 1 or top >= 2 * cnt.iloc[1]):
            hm[cls], basis[cls] = cnt.index[0], f'主授教師({top}/{len(g)}列)'
    titled = set(roster[roster['職稱'] == '導師']['姓名'].astype(str).str.strip())
    problems = []
    if set(hm.values()) != titled:
        problems.append(f"推定導師與教師資料「導師」職稱不一致：只在推定={sorted(set(hm.values()) - titled)}，"
                        f"只在教師資料={sorted(titled - set(hm.values()))}")
    if len(set(hm.values())) != len(hm):
        problems.append('有教師被推定為兩個班的導師')
    return hm, basis, problems


# ───────────────────────── 作息時間 ─────────────────────────
def period_times(sched_sheet):
    out = collections.defaultdict(dict)
    for r in sched_sheet.itertuples(index=False):
        div, p, st, en, on = r[0], int(r[1]), r[2], r[3], r[4]
        if not (on is True or on == 1):
            continue
        f = lambda v: v.strftime('%H:%M') if isinstance(v, (datetime.time, datetime.datetime)) else str(v)[:5]
        out[str(div)][p] = (f(st), f(en))
    return out


def times_js(times):
    lines = ['    PERIOD_TIMES: {']
    for div in ('國小', '國中'):
        if div not in times:
            continue
        lines.append(f"        '{div}': [")
        for p in range(0, max(times[div]) + 1):
            st, en = times[div].get(p, ('——', '——'))
            lines.append(f"            {{ start: '{st}', end: '{en}' }},  // " + ('晨間' if p == 0 else f'第{p}節'))
        lines.append('        ],')
    lines.append('    },')
    return '\n'.join(lines)


# ───────────────────────── 輸出 ─────────────────────────
def write_outputs(layers, homerooms, outdir, tag):
    header = ['teachername']
    for d in DAYS:
        for p in PERIODS:
            header += [f's{d}{p}', f'c{d}{p}']
    csv_path = f'{outdir}/timetable_{tag}.csv'
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for t in sorted(layers):
            for layer in layers[t]:
                row = [t]
                for d in DAYS:
                    for p in PERIODS:
                        row += list(layer.get((d, p), ('', '')))
                w.writerow(row)
    json_path = f'{outdir}/homerooms_{tag}.json'
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(dict(sorted(homerooms.items())), fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    return csv_path, json_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx'); ap.add_argument('tag')
    ap.add_argument('--out', default='.')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()

    t, roster, bell = read_excel(a.xlsx)
    disabled = t[~t['啟用']]
    act = t[t['啟用']].copy()
    mapping, unknown = normalize_names(act, roster)
    layers, multi = build_layers(act)
    hm, basis, problems = infer_homerooms(act, roster)
    times = period_times(bell)

    if a.report:
        print('總列數', len(t), '| 啟用', len(act), '| 停用(已排除)', len(disabled))
        print(disabled.to_string() if len(disabled) else '')
        print('姓名統一:', mapping)
        print('不在教師資料表的教師:', unknown)
        print('教師數', len(layers), '| CSV 列數', sum(len(v) for v in layers.values()))
        print('同教師同時段多內容:', len(multi))
        print('導師:', hm); print('依據:', basis); print('導師檢查問題:', problems or '無')
        print(times_js(times))
    else:
        if problems:
            print('⚠', *problems, sep='\n  ', file=sys.stderr)
        print(*write_outputs(layers, hm, a.out, a.tag), sep='\n')
        print('\n# 請把下面這段貼到 config.js（取代原本的 PERIOD_TIMES）：')
        print(times_js(times))


if __name__ == '__main__':
    main()
