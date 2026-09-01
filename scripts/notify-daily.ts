/**
 * 日报生成后推送微信（测试号模板消息）— B1 外发渠道（2026-09-01）
 *
 * 用法：npm run notify  （daily.yml「Push WeChat notification」步骤调用）
 *
 * env（CI secrets / vars）：
 *   WX_APP_ID      必填 测试号 appID
 *   WX_APP_SECRET  必填 测试号 appsecret
 *   WX_TEMPLATE_ID 必填 模板 ID（非敏感，亦可硬编码进 workflow）
 *   WX_USER_ID     可选 显式目标 openid（逗号分隔；关注者列表之外补发，如给自己发）
 *   REPORT_BASE_URL 可选 报告根 URL，默认 https://shengc-shv.github.io/gzinfo
 *   REPORT_TZ       可选 报告时区，默认 Asia/Shanghai（决定取哪天的 store.json）
 *
 * 数据源：history/<date>/store.json → executive.hero_line（今日定调）
 * 发送目标：测试号关注者列表（user/get）+ WX_USER_ID（去重）
 * 失败策略：任何失败都不退出非零 → 推送绝不阻断发布主流程；结果打到 stdout。
 */
import fs from "node:fs";
import path from "node:path";
import { pushDailyReport, buildTemplatePayload } from "../lib/notify/wechat.js";

function log(msg: string) {
  console.log(`[notify] ${msg}`);
}

async function main() {
  const appId = process.env.WX_APP_ID ?? "";
  const appSecret = process.env.WX_APP_SECRET ?? "";
  const templateId = process.env.WX_TEMPLATE_ID ?? "";
  if (!appId || !appSecret || !templateId) {
    log("缺少 WX_APP_ID / WX_APP_SECRET / WX_TEMPLATE_ID，跳过微信推送");
    return;
  }

  const tz = process.env.REPORT_TZ || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // 今日定调：history/<date>/store.json → executive.hero_line
  let heroLine = "";
  const storePath = path.join("history", dateStr, "store.json");
  if (fs.existsSync(storePath)) {
    try {
      const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as { executive?: { hero_line?: string } };
      heroLine = store.executive?.hero_line ?? "";
      log(`读取定调: ${heroLine.slice(0, 40)}${heroLine.length > 40 ? "…" : ""}`);
    } catch (e) {
      log(`store.json 解析失败，使用默认定调: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    log(`未找到 ${storePath}，使用默认定调`);
  }

  const payload = buildTemplatePayload(heroLine, dateStr);
  const base = (process.env.REPORT_BASE_URL || "https://shengc-shv.github.io/gzinfo").replace(/\/+$/, "");
  const reportUrl = `${base}/${dateStr}/${dateStr}.html`;

  const extraOpenIds = (process.env.WX_USER_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const result = await pushDailyReport(
    { appId, appSecret, templateId, baseUrl: base, extraOpenIds },
    payload,
    reportUrl,
  );

  if (result.error) {
    log(`❌ 推送失败: ${result.error}`);
  } else if (result.targets === 0) {
    log(`⚠️ 无发送目标（无关注者且未配置 WX_USER_ID），跳过`);
  } else {
    log(`✅ 微信推送完成：目标 ${result.targets} 人，成功 ${result.sent}，失败 ${result.failed.length}`);
  }
  for (const f of result.failed) {
    log(`   失败 ${f.openid}: ${f.reason}`);
  }
  log(`报告链接: ${reportUrl}`);
}

main().catch((e) => {
  log(`❌ 未捕获异常: ${e instanceof Error ? e.message : String(e)}`);
  // 推送失败不阻断主流程（CI step 另有 continue-on-error 双保险）
});
