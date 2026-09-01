/**
 * 粤企注册表种子生成器（维护工具；同时由 test.yml 每周一定时刷新）
 *
 * 作用：生成 lib/sources/guangdong-registry.json —— 广东地区企业
 *   「企业名 / 别名(含英文名) / 股票代码 / 注册城市」的单一真相源。
 *
 * 数据来源：
 * - A 股候选：用东方财富 F10 公司概况接口实拉 PROVINCE/CITY 校验，只有省份=广东
 *   的才写入（确保准确，避免手填省份出错）。
 * - 港股 / 中概候选：F10 无省份字段，直接用人工标注的城市写入（均为广为人知的粤企）。
 *
 * 复跑：直接 `node scripts/seed-guangdong-registry.mjs` 即可重建 JSON。
 * 日常维护：在下方 CANDIDATES 里增删企业，或拿到 JSON 后手工补 entries 即可。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../lib/sources/guangdong-registry.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 候选清单：type 'a' = A股(用 emweb 校验省份)；'hk'/'us' = 手动标注城市
const CANDIDATES = [
  // ---------- A 股（广东注册，emweb 校验） ----------
  { name: "平安银行", codes: ["000001"], type: "a", aliases: ["Ping An Bank"] },
  { name: "万科A", codes: ["000002"], type: "a", aliases: ["China Vanke", "Vanke"] },
  { name: "深圳能源", codes: ["000027"], type: "a", aliases: ["Shenzhen Energy"] },
  { name: "TCL科技", codes: ["000100"], type: "a", aliases: ["TCL"] },
  { name: "华侨城A", codes: ["000069"], type: "a", aliases: ["OCT"] },
  { name: "中兴通讯", codes: ["000063", "0763.HK"], type: "a", aliases: ["ZTE"] },
  { name: "美的集团", codes: ["000333", "0300.HK"], type: "a", aliases: ["Midea"] },
  { name: "格力电器", codes: ["000651"], type: "a", aliases: ["Gree"] },
  { name: "粤电力A", codes: ["000539"], type: "a", aliases: ["Yuedian"] },
  { name: "广发证券", codes: ["000776", "1776.HK"], type: "a", aliases: ["GF Securities"] },
  { name: "比亚迪", codes: ["002594", "1211.HK"], type: "a", aliases: ["BYD"] },
  { name: "国信证券", codes: ["002736"], type: "a", aliases: ["Guosen"] },
  { name: "立讯精密", codes: ["002475"], type: "a", aliases: ["Luxshare"] },
  { name: "顺丰控股", codes: ["002352"], type: "a", aliases: ["SF Express", "SF Holding"] },
  { name: "海大集团", codes: ["002311"], type: "a", aliases: ["Haid Group"] },
  { name: "视源股份", codes: ["002841"], type: "a", aliases: ["CVTE"] },
  { name: "深南电路", codes: ["002916"], type: "a", aliases: ["SCC"] },
  { name: "大族激光", codes: ["002008"], type: "a", aliases: ["Han's Laser"] },
  { name: "汇川技术", codes: ["300124"], type: "a", aliases: ["Inovance"] },
  { name: "欧菲光", codes: ["002456"], type: "a", aliases: ["OFILM"] },
  { name: "欣旺达", codes: ["300207"], type: "a", aliases: ["Sunwoda"] },
  { name: "德赛电池", codes: ["000049"], type: "a", aliases: ["Desay Battery"] },
  { name: "信维通信", codes: ["300136"], type: "a", aliases: ["Sunway"] },
  { name: "拓邦股份", codes: ["002139"], type: "a", aliases: ["Topband"] },
  { name: "远光软件", codes: ["002063"], type: "a", aliases: ["YGSoft"] },
  { name: "丽珠集团", codes: ["000513"], type: "a", aliases: ["Livzon"] },
  { name: "汤臣倍健", codes: ["300146"], type: "a", aliases: ["By-Health"] },
  { name: "纳思达", codes: ["002180"], type: "a", aliases: ["Ninestars"] },
  { name: "全志科技", codes: ["300458"], type: "a", aliases: ["Allwinner"] },
  { name: "迈瑞医疗", codes: ["300760"], type: "a", aliases: ["Mindray"] },
  { name: "亿纬锂能", codes: ["300014"], type: "a", aliases: ["EVE Energy"] },
  { name: "温氏股份", codes: ["300498"], type: "a", aliases: ["Wens"] },
  { name: "信立泰", codes: ["002294"], type: "a", aliases: ["Salubris"] },
  { name: "康泰生物", codes: ["300601"], type: "a", aliases: ["Kangtai"] },
  { name: "深信服", codes: ["300454"], type: "a", aliases: ["Sangfor"] },
  { name: "新产业", codes: ["300832"], type: "a", aliases: ["Snibe"] },
  { name: "德方纳米", codes: ["300769"], type: "a", aliases: ["Dynanonic"] },
  { name: "稳健医疗", codes: ["300888"], type: "a", aliases: ["Winner"] },
  { name: "惠泰医疗", codes: ["688617"], type: "a", aliases: ["HeartCare"] },
  { name: "传音控股", codes: ["688036"], type: "a", aliases: ["Transsion"] },
  { name: "贝特瑞", codes: ["835185"], type: "a", aliases: ["BTR"] },
  { name: "金地集团", codes: ["600383"], type: "a", aliases: ["Gemdale"] },
  { name: "保利发展", codes: ["600048"], type: "a", aliases: ["Poly Develop"] },
  { name: "白云山", codes: ["600332"], type: "a", aliases: ["Baiyunshan"] },
  { name: "金域医学", codes: ["603882"], type: "a", aliases: ["Kingmed"] },
  { name: "广汽集团", codes: ["601238"], type: "a", aliases: ["GAC"] },
  { name: "工业富联", codes: ["601138"], type: "a", aliases: ["Foxconn Industrial"] },
  { name: "中国平安", codes: ["601318", "2318.HK"], type: "a", aliases: ["Ping An"] },
  { name: "招商证券", codes: ["600999"], type: "a", aliases: ["CMS"] },
  { name: "中信证券", codes: ["600030"], type: "a", aliases: ["CITIC Securities"] },
  { name: "锦龙股份", codes: ["000712"], type: "a", aliases: ["Jinlong"] },
  // ---------- 港股 / 中概（人工标注城市，F10 无省份） ----------
  { name: "腾讯控股", codes: ["0700.HK"], type: "hk", city: "深圳市", aliases: ["Tencent", "Tencent Holdings"] },
  { name: "网易", codes: ["9999.HK"], type: "hk", city: "广州市", aliases: ["NetEase"] },
  { name: "万科企业", codes: ["2202.HK"], type: "hk", city: "深圳市", aliases: ["Vanke"] },
  { name: "碧桂园", codes: ["2007.HK"], type: "hk", city: "佛山市", aliases: ["Country Garden"] },
  { name: "小鹏汽车", codes: ["9868.HK", "XPEV"], type: "hk", city: "广州市", aliases: ["XPeng"] },
  { name: "唯品会", codes: ["VIPS"], type: "us", city: "广州市", aliases: ["Vipshop"] },
  { name: "虎牙", codes: ["HUYA"], type: "us", city: "广州市", aliases: ["HUYA"] },
  { name: "欢聚", codes: ["YY"], type: "us", city: "广州市", aliases: ["JOYY", "YY Inc"] },
  { name: "富途", codes: ["FUTU"], type: "us", city: "深圳市", aliases: ["Futu"] },
  { name: "腾讯音乐", codes: ["TME"], type: "us", city: "深圳市", aliases: ["Tencent Music"] },
  // ---------- 拟上市 / 在审（无代码，人工标注城市，靠名称/别名命中） ----------
  { name: "粤芯半导体", codes: [], type: "manual", city: "广州市", aliases: ["粤芯"], note: "2026-08-30 新增：在审/拟上市企业登记示范——codes 留空（未上市无代码），靠企业名/别名命中（如媒体源报道「证监会同意粤芯半导体首次公开发行股票注册」）；city 供广州企业强调。" },
];

function toEastMoneyCode(c) {
  const code = String(c || "").trim();
  if (/^6/.test(code)) return `SH${code}`;
  if (/^[03]/.test(code)) return `SZ${code}`;
  if (/^[89]/.test(code) || /^920/.test(code) || /^4/.test(code)) return `BJ${code}`;
  return `SZ${code}`;
}

async function provinceOfAshare(code) {
  try {
    const res = await fetch(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${toEastMoneyCode(code)}`,
      { headers: { "User-Agent": UA, Referer: "https://emweb.securities.eastmoney.com/" }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const jbzl = data && data.jbzl;
    if (!jbzl || !jbzl[0]) return null;
    return { province: jbzl[0].PROVINCE || "", city: jbzl[0].CITY || "" };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const companies = [];
const kept = [];
const dropped = [];

// 载入既有注册表：A股在 emweb 偶发瞬断时，沿用旧的城市值，避免周更误删企业
let oldMap = new Map();
let prevCompanies = [];
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    prevCompanies = prev.companies || [];
    for (const c of prevCompanies) {
      for (const code of c.codes || []) oldMap.set(String(code).toUpperCase(), c);
      oldMap.set(c.name, c);
    }
  } catch {
    /* 旧文件损坏则忽略，走全量重建 */
  }
}

for (const c of CANDIDATES) {
  if (c.type === "a") {
    await sleep(120);
    const info = await provinceOfAshare(c.codes[0]);
    if (info && info.province === "广东") {
      companies.push({ name: c.name, aliases: c.aliases || [], codes: c.codes, city: info.city || "" });
      kept.push(`${c.name}(${c.codes[0]}) -> ${info.city}`);
    } else if (info && info.province) {
      // 明确解析为非广东省份（如北京/上海），剔除
      dropped.push(`${c.name}(${c.codes[0]}) -> 非广东(${info.province})`);
    } else {
      // 解析失败（瞬断）：若旧表有此企业则沿用，避免周更误删
      const old = oldMap.get(c.name) || oldMap.get(String(c.codes[0]).toUpperCase());
      if (old) {
        companies.push({
          name: old.name,
          aliases: old.aliases || c.aliases || [],
          codes: old.codes || c.codes,
          city: old.city || "",
        });
        kept.push(`${c.name}(${c.codes[0]}) -> ${old.city || "?"} [解析失败,沿用旧值]`);
      } else {
        dropped.push(`${c.name}(${c.codes[0]}) -> 解析失败且无旧值,剔除`);
      }
    }
  } else {
    companies.push({
      name: c.name,
      aliases: c.aliases || [],
      codes: c.codes || [],
      city: c.city || "",
      ...(c.note ? { note: c.note } : {}),
    });
    kept.push(`${c.name}(${(c.codes && c.codes[0]) || "-"}) -> ${c.city} [${c.type}]`);
  }
}

// 保留旧表中不在候选清单里的手工条目（如粤芯半导体），防止重建误删
const candNames = new Set(CANDIDATES.map((c) => c.name));
for (const c of prevCompanies) {
  if (!candNames.has(c.name) && !companies.some((n) => n.name === c.name)) {
    companies.push(c);
    kept.push(`${c.name} -> ${c.city || "?"} [旧表手工条目,保留]`);
  }
}

companies.sort((a, b) => a.name.localeCompare(b.name, "zh"));
const out = {
  version: 1,
  updatedAt: new Date().toISOString().slice(0, 10),
  note: "广东地区企业单一真相源：企业名/别名(含英文名)/股票代码/注册城市。A股由东方财富F10校验省份；港股中概人工标注。匹配逻辑见 lib/sources/guangdong.mjs。",
  companies,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`\n写入 ${companies.length} 家粤企 -> ${OUT}`);
console.log("\n--- 保留 ---");
kept.forEach((k) => console.log("  ✓", k));
console.log("\n--- 剔除(非广东/解析失败) ---");
dropped.forEach((k) => console.log("  ✗", k));
