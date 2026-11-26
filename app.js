/**
 * ============================================================
 *  課表查詢系統 - 應用程式邏輯 (app.js)
 *  新北市福瑞斯特中小學
 * ============================================================
 */

/* ── 全域狀態 ─────────────────────────────────────────────── */
let scheduleData    = [];   // CSV 全部資料
let isLoggedIn      = false;
let navHistory      = [];   // 導航歷史 [{type, value}]
let classGroups     = {};   // 班級分類
let subjectTeachers = {};   // 科目→教師
let homeroomData    = {};   // 班級→導師（homerooms_XXX.json）
let slotIndex       = {};   // "星期-節次" → [{token, subject, teacher}]（班級查詢用）

/* ── 班級代號判斷 ──
   導師班：101、702…　分組班：5A、5A+、7數A、8自A1…　晚自習：晚自習-701、晚自習-7數A、晚自習-選1 */
const isHomeroom   = c => /^[1-9]0\d$/.test(c);
const isEvening    = c => c.startsWith('晚自習-');
const baseToken    = c => c.replace(/^晚自習-/, '');
const gradeOf      = c => { const m = /^([1-9])/.exec(baseToken(c)); return m ? m[1] : ''; };
const isGroupToken = c => !isHomeroom(baseToken(c)) && /^[1-9]/.test(baseToken(c));
const divisionOf   = c => (gradeOf(c) && +gradeOf(c) <= 6) ? '國小' : '國中';   // 1~6 年級=國小，7~9 年級與晚自習=國中

const PERIODS_ALL   = [0,1,2,3,4,5,6,7,8,9,10,11];  // 0=早自習, 1~9=第1~9節, 10~11=晚自習（國中）
const MIN_ROWS      = 9;                        // 課表至少顯示到第9節；有第10、11節資料時才多顯示
const GRADE_NAMES   = { 1:'一年級', 2:'二年級', 3:'三年級', 4:'四年級', 5:'五年級',
                        6:'六年級', 7:'七年級', 8:'八年級', 9:'九年級' };
const DAYS          = ['一','二','三','四','五'];

/* ── DOM 參考 ─────────────────────────────────────────────── */
const loginView    = document.getElementById('loginView');
const queryView    = document.getElementById('queryView');
const resultView   = document.getElementById('resultView');
const loadingOverlay = document.getElementById('loadingOverlay');
const scheduleTitle  = document.getElementById('scheduleTitle');
const scheduleTableContainer = document.getElementById('scheduleTableContainer');

/* ═══════════════════════════════════════════════════════════
   視圖切換
═══════════════════════════════════════════════════════════ */
function showView(viewId) {
    [loginView, queryView, resultView].forEach(v => {
        v.classList.remove('active', 'result-active');
        v.style.display = 'none';
    });
    const target = document.getElementById(viewId);
    if (!target) return;
    if (viewId === 'resultView') {
        target.classList.add('result-active');
        target.style.display = 'block';
    } else {
        target.classList.add('active');
        target.style.display = 'flex';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showQueryView() {
    navHistory = [];
    resetGradeSelects();
    showView('queryView');
}

function logout() {
    isLoggedIn   = false;
    scheduleData = [];
    homeroomData = {};
    navHistory   = [];
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').textContent = '';
    showView('loginView');
}

/* ═══════════════════════════════════════════════════════════
   導航歷史（返回上一頁）
═══════════════════════════════════════════════════════════ */
function pushNav(type, value) {
    navHistory.push({ type, value });
    updateBackBtn();
}

function goBack() {
    if (navHistory.length <= 1) {
        showQueryView();
        return;
    }
    navHistory.pop();                               // 移除目前頁
    const prev = navHistory[navHistory.length - 1];
    navHistory.pop();                               // 移除上一頁（displayX 會再 push）
    if (prev.type === 'class')   displayClassSchedule(prev.value);
    else                          displayTeacherSchedule(prev.value);
}

function updateBackBtn() {
    const btn = document.getElementById('backBtn');
    if (!btn) return;
    btn.style.visibility = navHistory.length > 1 ? 'visible' : 'hidden';
}

/* ═══════════════════════════════════════════════════════════
   學期下拉選單初始化
═══════════════════════════════════════════════════════════ */
function populateSemesterSelect() {
    const sel = document.getElementById('semesterSelect');
    if (!sel || !CONFIG.SEMESTERS) return;
    const keys = Object.keys(CONFIG.SEMESTERS);
    keys.forEach((label, i) => {
        const opt = document.createElement('option');
        opt.value       = label;
        opt.textContent = label;
        if (i === keys.length - 1) opt.selected = true;
        sel.appendChild(opt);
    });
}

/* ═══════════════════════════════════════════════════════════
   登入
═══════════════════════════════════════════════════════════ */
document.getElementById('loginForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl    = document.getElementById('loginError');
    const btn      = document.getElementById('loginBtn');
    const spinner  = document.getElementById('loginSpinner');

    errEl.textContent = '';

    if (username === CONFIG.USERNAME && password === CONFIG.PASSWORD) {
        btn.disabled = true;
        spinner.classList.add('show');
        const semLabel = document.getElementById('semesterSelect')?.value || '';
        await fetchAndParseCSV(semLabel);
        btn.disabled = false;
        spinner.classList.remove('show');
    } else {
        errEl.textContent = '帳號或密碼錯誤，請再試一次';
    }
});

/* ═══════════════════════════════════════════════════════════
   CSV 載入與解析
═══════════════════════════════════════════════════════════ */
async function fetchAndParseCSV(semLabel) {
    loadingOverlay.classList.add('show');

    let csvUrl = (CONFIG.SEMESTERS && Object.values(CONFIG.SEMESTERS).slice(-1)[0]) || './timetable_s1.csv';
    if (CONFIG.SEMESTERS && semLabel && CONFIG.SEMESTERS[semLabel]) {
        csvUrl = CONFIG.SEMESTERS[semLabel];
    }

    try {
        const response = await fetch(csvUrl);
        if (!response.ok) throw new Error(`HTTP 錯誤 ${response.status}`);
        const csvText = await response.text();

        // 取得對應的 homerooms.json
        const jsonUrl = csvUrl.replace('timetable_', 'homerooms_').replace('.csv', '.json');
        try {
            const hmRes = await fetch(jsonUrl);
            if (hmRes.ok) homeroomData = await hmRes.json();
            else homeroomData = {};
        } catch (e) { homeroomData = {}; }

        const parsed  = parseCSV(csvText);
        if (parsed.length === 0) throw new Error('CSV 資料為空');

        scheduleData = parsed;
        buildCategories();
        populateQueryUI();
        isLoggedIn = true;

        const badge = document.getElementById('currentSemester');
        if (badge) badge.textContent = semLabel || '';

        loadingOverlay.classList.remove('show');
        showView('queryView');

    } catch (err) {
        loadingOverlay.classList.remove('show');
        console.error(err);
        document.getElementById('loginError').textContent =
            `載入失敗：${err.message}。請確認課表資料檔（CSV）是否存在。`;
    }
}

/* ── CSV 解析 ─────────────────────────────────────────────── */
function splitCSVLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
        else { cur += c; }
    }
    result.push(cur);
    return result;
}

function parseCSV(text) {
    const lines   = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    const headers = splitCSVLine(lines[0]);
    return lines.slice(1).map(line => {
        const vals = splitCSVLine(line);
        const obj  = {};
        headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
        return obj;
    }).filter(r => r.teachername);
}

/* ═══════════════════════════════════════════════════════════
   建立分類資料
═══════════════════════════════════════════════════════════ */
function buildCategories() {
    // ── 建立「時段索引」與班級代號清單 ──
    slotIndex = {};
    const allClasses = new Set();
    scheduleData.forEach(row => {
        for (let d = 1; d <= 5; d++)
            for (let p of PERIODS_ALL) {
                const classStr = row[`c${d}${p}`], subject = row[`s${d}${p}`];
                if (!classStr || !subject) continue;
                classStr.split(' ').forEach(cls => {
                    if (!cls) return;
                    allClasses.add(cls);
                    (slotIndex[`${d}-${p}`] = slotIndex[`${d}-${p}`] || [])
                        .push({ token: cls, subject, teacher: row.teachername });
                });
            }
    });

    // 分類：導師班依年級（101→一年級、701→七年級…）；其餘為「分組班」「晚自習」「特殊班」
    classGroups = {};
    [...allClasses].forEach(cls => {
        let g;
        if (isEvening(cls))         g = '晚自習';
        else if (isHomeroom(cls))   g = GRADE_NAMES[cls[0]];
        else if (isGroupToken(cls)) g = '分組班';
        else                        g = '特殊班';
        (classGroups[g] = classGroups[g] || []).push(cls);
    });
    Object.values(classGroups).forEach(list =>
        list.sort((a, b) => (parseInt(a) - parseInt(b)) || a.localeCompare(b, 'zh-Hant', { numeric: true })));

    // ── 科目→教師分類（含早自習）──
    subjectTeachers = {};
    scheduleData.forEach(row => {
        for (let d = 1; d <= 5; d++)
            for (let p of PERIODS_ALL) {
                const subj = row[`s${d}${p}`];
                if (!subj) continue;
                const base = normalizeSubject(subj);
                if (!subjectTeachers[base]) subjectTeachers[base] = new Set();
                subjectTeachers[base].add(row.teachername);
            }
    });
    Object.keys(subjectTeachers).forEach(k => {
        subjectTeachers[k] = [...subjectTeachers[k]].sort();
    });
}

function normalizeSubject(subj) {
    // 「單週 美術」「雙週 生活(美)」→ 去掉單雙週前綴，讓同一科目歸在同一個選項
    const s = subj.replace(/^(單週|雙週|第[一二三四、]+週)\s*/, '');
    return s.replace(/輔導$/, '').replace(/加強$/, '').trim() || s || subj;
}

/* 同一格有單/雙週或四週輪替的多組內容時，依週別排序 */
function weekRank(subject) {
    if (subject.startsWith('單週')) return 0;
    if (subject.startsWith('雙週')) return 1;
    const m = /^第([一二三四])/.exec(subject);          // 四週輪替：第一週…第四週
    return m ? 2 + '一二三四'.indexOf(m[1]) : 9;
}
function sortWeekGroups(groups) {
    groups.sort((a, b) => weekRank(a.subject) - weekRank(b.subject));   // Array.sort 為穩定排序
}

/* ═══════════════════════════════════════════════════════════
   填充查詢 UI
═══════════════════════════════════════════════════════════ */
function populateQueryUI() {
    renderGradeSelects();

    const subjectSel = document.getElementById('subjectSelect');
    subjectSel.innerHTML = '<option value="">— 不限科目 —</option>';
    Object.keys(subjectTeachers).sort().forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        subjectSel.appendChild(opt);
    });
    fillTeacherOptions();
}

function renderGradeSelects() {
    const box = document.getElementById('gradeGroups');
    if (!box) return;
    box.innerHTML = '';
    const order = [...Object.values(GRADE_NAMES), '分組班', '晚自習', '特殊班'];
    const names = Object.keys(classGroups).sort((x, y) => {
        const ix = order.indexOf(x), iy = order.indexOf(y);
        return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    });
    names.forEach(name => {                       // 只為「有班級的年級」產生選單
        const digit = Object.keys(GRADE_NAMES).find(k => GRADE_NAMES[k] === name) || ({ '分組班': 'grp', '晚自習': 'eve' })[name] || 'sp';
        const group = document.createElement('div');
        group.className = 'grade-group';
        const label = document.createElement('div');
        label.className = `grade-label grade-${digit}`;
        label.textContent = name;
        const sel = document.createElement('select');
        sel.className = 'form-control grade-select';
        sel.innerHTML = '<option value="">— 選擇班級 —</option>';
        classGroups[name].forEach(cls => {
            const opt = document.createElement('option');
            opt.value = cls; opt.textContent = cls;
            sel.appendChild(opt);
        });
        group.append(label, sel);
        box.appendChild(group);
    });
}

/* ═══════════════════════════════════════════════════════════
   Tab 切換
═══════════════════════════════════════════════════════════ */
function switchTab(tab) {
    document.getElementById('tabClass').classList.toggle('active', tab === 'class');
    document.getElementById('tabTeacher').classList.toggle('active', tab === 'teacher');
    document.getElementById('panelClass').classList.toggle('hidden', tab !== 'class');
    document.getElementById('panelTeacher').classList.toggle('hidden', tab !== 'teacher');
}

/* ═══════════════════════════════════════════════════════════
   班級查詢
═══════════════════════════════════════════════════════════ */
function allGradeSelects() {
    return [...document.querySelectorAll('#gradeGroups .grade-select')];
}

function setupGradeSelects() {
    const box = document.getElementById('gradeGroups');
    if (!box) return;
    // 事件代理：選了某個年級的班級，就清空其他年級的選單
    box.addEventListener('change', e => {
        if (!e.target.classList.contains('grade-select')) return;
        if (e.target.value) allGradeSelects().forEach(el => { if (el !== e.target) el.value = ''; });
        document.getElementById('classError').textContent = '';
    });
}

function resetGradeSelects() {
    allGradeSelects().forEach(el => { el.value = ''; });
    const ce = document.getElementById('classError');
    if (ce) ce.textContent = '';
    const te = document.getElementById('teacherError');
    if (te) te.textContent = '';
}

function submitClassQuery() {
    const cls = allGradeSelects().map(el => el.value).find(v => v);
    if (!cls) {
        document.getElementById('classError').textContent = '請先選擇一個班級';
        return;
    }
    navHistory = [];
    displayClassSchedule(cls);
}

/* ═══════════════════════════════════════════════════════════
   教師查詢
═══════════════════════════════════════════════════════════ */
/* 教師名單：預設列出全部老師，可直接選；科目為選填，選了只是縮小名單 */
function allTeachers() {
    return [...new Set(scheduleData.map(r => r.teachername))]
        .sort((x, y) => x.localeCompare(y, 'zh-Hant-TW'));
}

function fillTeacherOptions() {
    const subj = document.getElementById('subjectSelect').value;
    const sel  = document.getElementById('teacherSelect');
    const keep = sel.value;                                   // 已選的老師若還在名單內就保留
    const list = subj ? (subjectTeachers[subj] || []) : allTeachers();
    sel.innerHTML = `<option value="">— ${subj ? '該科目的老師' : '選擇教師（全部）'} —</option>`;
    list.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        sel.appendChild(opt);
    });
    if (list.includes(keep)) sel.value = keep;
}

function onSubjectChange() {
    fillTeacherOptions();
    document.getElementById('teacherError').textContent = '';
}

function submitTeacherQuery() {
    const subj = document.getElementById('subjectSelect').value;
    let teacher = document.getElementById('teacherSelect').value;
    const err = document.getElementById('teacherError');
    if (!teacher && subj) {                                   // 只選科目：該科目只有一位老師就直接顯示
        const list = subjectTeachers[subj] || [];
        if (list.length === 1) teacher = list[0];
        else { err.textContent = `「${subj}」有 ${list.length} 位老師，請從教師選單選一位`; return; }
    }
    if (!teacher) {
        err.textContent = '請選擇老師（也可以先選科目縮小名單）';
        return;
    }
    err.textContent = '';
    navHistory = [];
    displayTeacherSchedule(teacher);
}

/* ═══════════════════════════════════════════════════════════
   顯示課表
═══════════════════════════════════════════════════════════ */
/* 取得某班在每個時段的上課內容 [{subject, teacher}]
   - 一般代號（分組班、晚自習…）：只看自己的資料
   - 導師班：另外納入「同年級、同時段」的分組班教師，以及同時段同科目的其他導師班教師。
     例：五年級數學同時段有 501、502、5A+ 三組 → 501 的課表會列出三位教師；
         五年級英語分組(5A/5B/5C)時段，501、502 都會列出該時段所有分組的外籍教師。
     晚自習（第10、11節）：導師班 701 → 「晚自習-701」＋同年級的晚自習分組班。 */
function entriesForClass(className) {
    const home = isHomeroom(className), g = gradeOf(className), res = {};
    Object.entries(slotIndex).forEach(([key, ents]) => {
        const evening  = +key.split('-')[1] >= 10;
        const ownToken = (home && evening) ? '晚自習-' + className : className;
        let picked = ents.filter(e => e.token === ownToken);
        if (home) {
            const grp = ents.filter(e => isEvening(e.token) === evening && isGroupToken(e.token) && gradeOf(e.token) === g);
            if (grp.length) {
                const subjects = new Set(grp.map(e => e.subject));
                const sibs = evening ? [] : ents.filter(e => isHomeroom(e.token) && e.token !== className
                                                         && gradeOf(e.token) === g && subjects.has(e.subject));
                picked = picked.concat(grp, sibs);
            }
        }
        if (picked.length) res[key] = picked;
    });
    return res;
}

function displayClassSchedule(className) {
    pushNav('class', className);
    const cells = {};   // key → [ {subject, items:[教師…]}, … ]（同一格有單/雙週或多組時會有多組）
    Object.entries(entriesForClass(className)).forEach(([key, ents]) => {
        const groups = cells[key] = [];
        ents.forEach(e => {
            let g = groups.find(x => x.subject === e.subject);
            if (!g) groups.push(g = { subject: e.subject, items: [] });
            if (!g.items.includes(e.teacher)) g.items.push(e.teacher);
        });
        sortWeekGroups(groups);
    });

    const hmTeacher = homeroomData[className] || '';
    const hmHtml = hmTeacher ? `<span style="font-size: 1.1rem; color: var(--text-dim); margin-left: 0.5rem; font-weight: 500;">(導師：${escHtml(hmTeacher)})</span>` : '';
    
    scheduleTitle.innerHTML = `${className} 班課表 ${hmHtml}`;
    scheduleTableContainer.innerHTML = buildScheduleTable(cells, 'class', [divisionOf(className)]);
    showView('resultView');
    updateBackBtn();
}

function displayTeacherSchedule(teacherName) {
    pushNav('teacher', teacherName);
    // 同名教師可能有多列（單/雙週在同一時段教不同班時會拆成第 2 列），全部合併顯示
    const rows  = scheduleData.filter(r => r.teachername === teacherName);
    const cells = {};
    const divs  = new Set();
    rows.forEach(row => {
        for (let d = 1; d <= 5; d++)
            for (let p of PERIODS_ALL) {
                const subject = row[`s${d}${p}`];
                if (subject) {
                    const key = `${d}-${p}`;
                    const classes = (row[`c${d}${p}`] || '').split(' ').filter(x => x);
                    (cells[key] = cells[key] || []).push({ subject, items: classes });
                    classes.forEach(c => divs.add(divisionOf(c)));
                }
            }
    });
    Object.values(cells).forEach(sortWeekGroups);
    scheduleTitle.textContent = `${teacherName} 老師課表`;
    scheduleTableContainer.innerHTML = buildScheduleTable(cells, 'teacher', [...divs]);
    showView('resultView');
    updateBackBtn();
}

/* ═══════════════════════════════════════════════════════════
   建構課表 HTML
═══════════════════════════════════════════════════════════ */
/* 節次時間：CONFIG.PERIOD_TIMES 為 { '國小': [...], '國中': [...] }（索引=節次）；
   也相容舊版單一陣列。教師若同時任教國小與國中，兩套時間都會列出。 */
function periodTimeHtml(p, divisions) {
    const T = CONFIG.PERIOD_TIMES;
    if (!T) return '';
    const ok = t => t && t.start && t.start !== '——';
    if (Array.isArray(T)) return ok(T[p]) ? `<div class="period-time">${T[p].start}<br>${T[p].end}</div>` : '';
    const list = (divisions || []).map(dv => ({ dv, t: (T[dv] || [])[p] })).filter(x => ok(x.t));
    if (!list.length) return '';
    if (list.length === 1) return `<div class="period-time">${list[0].t.start}<br>${list[0].t.end}</div>`;
    return list.map(x => `<div class="period-time">${x.dv} ${x.t.start}–${x.t.end}</div>`).join('');
}

function buildScheduleTable(cells, mode, divisions) {
    const hasEarly = Object.keys(cells).some(k => k.endsWith('-0'));
    const maxData  = Math.max(0, ...Object.keys(cells).map(k => +k.split('-')[1]));
    const lastRow  = Math.max(MIN_ROWS, maxData);
    divisions = ['國小', '國中'].filter(x => (divisions || []).includes(x));

    let html = '<table class="schedule-table"><thead><tr>';
    html += '<th class="th-period">節次</th>';
    DAYS.forEach(d => html += `<th>${d}</th>`);
    html += '</tr></thead><tbody>';

    // 早自習列（只在有資料時顯示）
    if (hasEarly) {
        html += '<tr><td class="td-period"><div class="period-num">早自習</div></td>';
        for (let d = 1; d <= 5; d++) html += renderCell(cells[`${d}-0`], mode);
        html += '</tr>';
    }

    // 第1節起（至少到第9節；有晚自習資料時延伸到第10、11節）
    for (let p = 1; p <= lastRow; p++) {
        html += `<tr><td class="td-period"><div class="period-num">第${p}節</div>${periodTimeHtml(p, divisions)}</td>`;
        for (let d = 1; d <= 5; d++) html += renderCell(cells[`${d}-${p}`], mode);
        html += '</tr>';
    }

    html += '</tbody></table>';
    return html;
}

function renderCell(cell, mode) {
    if (!cell || (Array.isArray(cell) && !cell.length)) return '<td class="td-empty"></td>';
    const groups = Array.isArray(cell) ? cell : [cell];

    const inner = groups.map(g => {
        const itemsHtml = (g.items || []).map(item => {
            if (mode === 'class') {
                return `<div class="cell-link" onclick="displayTeacherSchedule('${escHtml(item)}')">${item}</div>`;
            } else {
                return `<div class="cell-link" onclick="displayClassSchedule('${escHtml(item)}')">${item}</div>`;
            }
        }).join(' ');
        return `<div class="cell-group">
            <div class="cell-subject">${g.subject}</div>
            <div class="cell-items-container">${itemsHtml}</div>
        </div>`;
    }).join('');

    return `<td class="td-cell">${inner}</td>`;
}

function escHtml(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* ═══════════════════════════════════════════════════════════
   列印
═══════════════════════════════════════════════════════════ */
function printSchedule() {
    const title    = scheduleTitle.textContent;
    const tableHTML = scheduleTableContainer.innerHTML;
    const semLabel  = document.getElementById('currentSemester')?.textContent || '';

    const win = window.open('', '_blank', 'width=1100,height=750');
    win.document.write(`<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>${title}</title>
<style>
  @page { size: A4 landscape; margin: 1cm; }
  body { font-family: 'Noto Sans TC', sans-serif; font-size: 10pt; }
  h2 { text-align:center; margin-bottom:4px; font-size:14pt; }
  p.sem { text-align:center; font-size:9pt; color:#555; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; }
  th, td { border:1px solid #999; padding:4px 6px; text-align:center; vertical-align:middle; }
  th { background:#e8e8e8; font-weight:600; }
  .td-period { background:#f5f5f5; width:4rem; }
  .period-num { font-weight:600; font-size:9pt; }
  .period-time { font-size:7.5pt; color:#555; }
  .cell-subject { font-weight:500; }
  .cell-group + .cell-group { border-top:1px dashed #999; margin-top:3px; padding-top:3px; }
  .cell-link { font-size:8.5pt; color:#444; }
  .td-empty { background:#fafafa; }
</style>
</head><body>
<h2>${title}</h2>
<p class="sem">${semLabel}</p>
${tableHTML}
<script>window.onload=()=>{window.print();window.close();}<\/script>
</body></html>`);
    win.document.close();
}

/* ═══════════════════════════════════════════════════════════
   初始化
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    populateSemesterSelect();
    setupGradeSelects();
    updateBackBtn();
    showView('loginView');
});

/* =====================================================================
   訪客登入
===================================================================== */
async function guestLogin() {
    const errEl    = document.getElementById('loginError');
    const btn      = document.getElementById('guestBtn');
    
    errEl.textContent = '';
    if (btn) btn.disabled = true;
    
    const semLabel = document.getElementById('semesterSelect')?.value || '';
    
    try {
        await fetchAndParseCSV(semLabel);
    } catch(err) {
        errEl.textContent = '載入失敗，請確認資料檔是否存在。';
    } finally {
        if (btn) btn.disabled = false;
    }
}
