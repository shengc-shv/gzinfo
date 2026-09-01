/**
 * 日报生成后推送外发渠道 — 微信测试号模板消息（B1）+ Server酱（2026-09-01 新增）
 *
 * 用法：npm run notify  （daily.yml「Push notifications」步骤调用）
 *
 * env（CI secrets / vars）：
 *   微信渠道（有 WX_* 才发）：
 *     WX_APP_ID      必填 测试号 appID
 *     WX_APP_SECRET  必填 测试号 appsecret
 *     WX_TEMPLATE_ID 必填 模板 ID（非敏感，亦可硬编码进 workflow）
 *     WX_USER_ID     可选 显式目标 openid（逗号分隔；关注者列表之外补发，如给自己发）
 *   Server酱渠道（有 SCT_SENDKEY 才发；SendKey 为敏感凭据，必须走 CI secrets）：
 *     SCT_SENDKEY    必填 Server酱 SendKey（sct.ftqq.com 登录后「SendKey」页复制）
 *   公共：
 *     REPORT_BASE_URL 可选 报告根 URL，默认 https://shengc-shv.github.io/gzinfo
 *     REPORT_TZ       可选 报告时区，默认 Asia/Shanghai（决定取哪天的 store.json）
 *
 * 数据源：history/<date>/store.json → executive（hero_line / must_read / insights / risk / guangdong_ipo）
 * 失败策略：两个渠道各自独立 try/catch，任一失败都不退出非零 → 推送绝不阻断发布主流程；结果打到 stdout。
 */
import fs from "node:fs";
import path from "node:path";
import { pushDailyReport, buildTemplatePayload } from "../lib/notify/wechat.js";
import { sendServerChan, buildServerChanDesp, type ExecutiveBrief } from "../lib/notify/serverchan.js";

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function log(msg: string) {
  console.log(`[notify] ${msg}`);
}

/** 读 store.json 的 executive（宽松解析，缺字段返回空对象，绝不抛错） */
function loadExecutive(storePath: string): { exec: ExecutiveBrief; heroLine: string } {
  const empty = { exec: {}, heroLine: "" };
  if (!fs.existsSync(storePath)) {
    log(`未找到 ${storePath}，使用默认数据`);
    return empty;
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as { executive?: ExecutiveBrief };
    const exec = store.executive ?? {};
    return { exec, heroLine: exec.hero_line ?? "" };
  } catch (e) {
    log(`store.json 解析失败，使用默认数据: ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}

async function pushWechat(cfg: {
  appId: string;
  appSecret: string;
  templateId: string;
  baseUrl: string;
  extraOpenIds: string[];
  heroLine: string;
  dateStr: string;
  reportUrl: string;
}) {
  const payload = buildTemplatePayload(cfg.heroLine, cfg.dateStr);
  const result = await pushDailyReport(
    { appId: cfg.appId, appSecret: cfg.appSecret, templateId: cfg.templateId, baseUrl: cfg.baseUrl, extraOpenIds: cfg.extraOpenIds },
    payload,
    cfg.reportUrl,
  );
  if (result.error) {
    log(`❌ 微信推送失败: ${result.error}`);
  } else if (result.targets === 0) {
    log(`⚠️ 微信无发送目标（无关注者且未配置 WX_USER_ID），跳过`);
  } else {
    log(`✅ 微信推送完成：目标 ${result.targets} 人，成功 ${result.sent}，失败 ${result.failed.length}`);
  }
  for (const f of result.failed) {
    log(`   失败 ${f.openid}: ${f.reason}`);
  }
}

async function pushServerChan(cfg: {
  sendKey: string;
  exec: ExecutiveBrief;
  dateStr: string;
  reportUrl: string;
}) {
  const weekday = WEEKDAY_CN[new Date(`${cfg.dateStr}T12:00:00+08:00`).getDay()] ?? "";
  const title = `【广州分行】今日日报 ${cfg.dateStr}（${weekday}）`;
  const desp = buildServerChanDesp(cfg.exec, cfg.reportUrl);
  const result = await sendServerChan({ sendKey: cfg.sendKey, title, desp });
  if (result.ok) {
    log(`✅ Server酱推送完成：${title}`);
  } else {
    log(`❌ Server酱推送失败: ${result.message}${result.code !== null ? `（code=${result.code}）` : ""}`);
  }
}

async function main() {
  const tz = process.env.REPORT_TZ || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { exec, heroLine } = loadExecutive(path.join("history", dateStr, "store.json"));
  if (heroLine) {
    log(`读取定调: ${heroLine.slice(0, 40)}${heroLine.length > 40 ? "…" : ""}`);
  }

  const base = (process.env.REPORT_BASE_URL || "https://shengc-shv.github.io/gzinfo").replace(/\/+$/, "");
  const reportUrl = `${base}/${dateStr}/${dateStr}.html`;

  // 渠道 1：微信测试号模板消息
  const appId = process.env.WX_APP_ID ?? "";
  const appSecret = process.env.WX_APP_SECRET ?? "";
  const templateId = process.env.WX_TEMPLATE_ID ?? "";
  if (!appId || !appSecret || !templateId) {
    log("缺少 WX_APP_ID / WX_APP_SECRET / WX_TEMPLATE_ID，跳过微信推送");
  } else {
    try {
      const extraOpenIds = (process.env.WX_USER_ID ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await pushWechat({ appId, appSecret, templateId, baseUrl: base, extraOpenIds, heroLine, dateStr, reportUrl });
    } catch (e) {
      log(`❌ 微信渠道异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 渠道 2：Server酱（SendKey 必须走 CI secrets，绝不硬编码进 workflow）
  const sendKey = process.env.SCT_SENDKEY ?? "";
  if (!sendKey) {
    log("缺少 SCT_SENDKEY，跳过 Server酱推送");
  } else {
    try {
      await pushServerChan({ sendKey, exec, dateStr, reportUrl });
    } catch (e) {
      log(`❌ Server酱渠道异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(`报告链接: ${reportUrl}`);
}

main().catch((e) => {
  log(`❌ 未捕获异常: ${e instanceof Error ? e.message : String(e)}`);
  // 推送失败不阻断主流程（CI step 另有 continue-on-error 双保险）
});
