# 新北市福瑞斯特中小學 課表查詢系統

純前端靜態網站（HTML / CSS / JS），不需要後端或資料庫。基於 [littleyi22/timetable-demo](https://github.com/littleyi22/timetable-demo) 的架構。

## 檔案說明

| 檔案 | 用途 |
| --- | --- |
| `index.html` / `style.css` / `app.js` | 網頁、樣式與邏輯 |
| `config.js` | 學校名稱、學期清單（指向 CSV）、國小/國中作息時間、登入帳密 |
| `timetable_s1.csv` | 115 學年度第 1 學期課表（以教師為列） |
| `homerooms_s1.json` | 班級 → 導師對照 |
| `scripts/xlsx_to_csv.py` | 把學校的課表 Excel 轉成上面兩個檔案 |

## 網站如何呈現

- **班級查詢**：各年級導師班（101…902）、**分組班**（1A～5C 外籍英語分組、7數A、8自A1…）、**晚自習**。
- 導師班的課表會一併列出「同年級、同時段」的分組班教師（例如 501 的數學時段會列出三位數學教師、英語分組時段會列出各組外籍教師），與紙本課表的呈現方式一致。
- 單/雙週與「第一～四週」輪替會在同一格並列。國中晚自習為第 10、11 節。
- 教師若同時任教國小與國中，節次欄會同時列出兩套作息時間。

## 更新課表（例如下學期）

Excel 需有工作表「教師課表」（星期/週別/節次/班級/科目/教師/啟用）、「教師資料」、「作息時間表」。**「啟用」欄空白的列會被排除。**

```bash
pip install pandas openpyxl
python scripts/xlsx_to_csv.py 全校115-2.xlsx s2        # 產生 timetable_s2.csv、homerooms_s2.json
```

接著在 `config.js` 的 `SEMESTERS` 最下面加一行：

```js
'115學年度 第二學期': './timetable_s2.csv',
```

導師由課表推定（7～9 年級看「班/週會」；1～5 年級看授課最多的教師），並與教師資料的「導師」職稱交叉檢查，不一致時腳本會顯示警告。

## 本機預覽

```bash
python -m http.server 8000     # 然後開 http://localhost:8000
```

## 部署到 GitHub Pages

1. 在 GitHub 建立新 Repo（Pages 免費版需為 Public），把本資料夾所有檔案上傳。
2. Repo → **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)` → Save。
3. 約 1～2 分鐘後網址為 `https://<帳號>.github.io/<Repo名稱>/`。

> ⚠ 網站與課表資料（含教師姓名）是公開可讀的；`config.js` 的帳密與「訪客登入」只是介面，不具保護效果。
