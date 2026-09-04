/**
 * 日报外发：微信测试号模板消息（2026-09-03 起仅微信渠道 —— Server酱已按用户要求整体废弃删除）。
 *
 * 用法：npm run notify（由 .github/workflows/notify.yml 人工触发调用）
 *
 * env（CI secrets / vars）：
 *   WX_APP_ID       必填 测试号 appID
 *   WX_APP_SECRET   必填 测试号 appsecret
 *   WX_TEMPLATE_ID  必填 模板 ID（非敏感，亦可硬编码进 workflow）
 *   WX_USER_ID      可选 显式目标 openid（逗号分隔；关注者列表之外补发，如给自己发）
 *   公共：
 *     REPORT_BASE_URL 可选 报告根 URL，默认 https://shengc-shv.github.io/gzinfo
 *     REPORT_TZ       可选 报告时区，默认 Asia/Shanghai（决定取哪天的 store.json 与报告 URL）
 *
 * 数据源：history/<date>/store.json → executive.hero_line（模板消息内容）
 *
 * 退出码（2026-09-03 新增语义）：微信真正送达（目标 ≥1 且全部成功）→ 0；
 * 缺配置 / 无发送目标 / 任一失败 → 1。
 * notify.yml 据此决定是否写当日「交付信号」（event-memory.json deliveries）——
 * 只有「人工确认过、微信真正送达」的版本才作为内容记忆 beginDay 的结算闸门。
 * 失败不抛未捕获异常（结果与退出码即最终信号）。
 */
import fs from "node:fs";
import path from "node:path";
import { pushDailyReport, buildTemplatePayload } from "../lib/notify/wechat.js";
import {
  pushWecomDaily,
  buildWecomMarkdown,
  buildWecomText,
  pushWecomWebhook,
} from "../lib/notify/wecom.js";

function log(msg: string) {
  console.log(`[notify] ${msg}`);
}

/** 读 store.json 的 hero_line（宽松解析，缺字段返回空，绝不抛错）。 */
function loadHeroLine(storePath: string): string {
  if (!fs.existsSync(storePath)) {
    log(`未找到 ${storePath}，使用默认数据`);
    return "";
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as { executive?: { hero_line?: string } };
    return store.executive?.hero_line ?? "";
  } catch (e) {
    log(`store.json 解析失败，使用默认数据: ${e instanceof Error ? e.message : String(e)}`);
    return "";
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
}): Promise<boolean> {
  const payload = buildTemplatePayload(cfg.heroLine, cfg.dateStr);
  const result = await pushDailyReport(
    { appId: cfg.appId, appSecret: cfg.appSecret, templateId: cfg.templateId, baseUrl: cfg.baseUrl, extraOpenIds: cfg.extraOpenIds },
    payload,
    cfg.reportUrl,
  );
  if (result.error) {
    log(`❌ 微信推送失败: ${result.error}`);
    return false;
  }
  if (result.targets === 0) {
    log(`⚠️ 微信无发送目标（无关注者且未配置 WX_USER_ID），未送达任何客户 → 不算交付`);
    return false;
  }
  if (result.ok) {
    log(`✅ 微信推送完成：目标 ${result.targets} 人，成功 ${result.sent}，失败 ${result.failed.length}`);
    return true;
  }
  log(`❌ 微信部分失败：成功 ${result.sent}/${result.targets} → 不算完全交付`);
  for (const f of result.failed) log(`   失败 ${f.openid}: ${f.reason}`);
  return false;
}

async function pushWecom(cfg: {
  corpId: string;
  agentId: string;
  corpSecret: string;
  userIds: string[];
  heroLine: string;
  dateStr: string;
  reportUrl: string;
}): Promise<boolean> {
  const markdown = buildWecomMarkdown(cfg.heroLine, cfg.dateStr, cfg.reportUrl);
  const result = await pushWecomDaily(
    { corpId: cfg.corpId, agentId: cfg.agentId, corpSecret: cfg.corpSecret, userIds: cfg.userIds },
    markdown,
    cfg.reportUrl,
  );
  if (result.error) {
    log(`❌ 企业微信推送失败: ${result.error}`);
    return false;
  }
  if (result.targets === 0) {
    log(`⚠️ 企业微信无发送目标（未配置 WECOM_USER_IDS），未送达任何客户 → 不算交付`);
    return false;
  }
  if (result.ok) {
    log(`✅ 企业微信推送完成：目标 ${result.targets} 人，成功 ${result.sent}，失败 ${result.failed.length}`);
    return true;
  }
  log(`❌ 企业微信部分失败：成功 ${result.sent}/${result.targets} → 不算完全交付`);
  for (const f of result.failed) log(`   失败 ${f.userid}: ${f.reason}`);
  return false;
}

async function pushWecomViaWebhook(cfg: {
  webhookUrl: string;
  heroLine: string;
  dateStr: string;
  reportUrl: string;
}): Promise<boolean> {
  // 默认 text：markdown 在个人微信显示「暂不支持此消息类型，请在企业微信中查看」
  // （官方答复微信侧不支持渲染 markdown），text 才能在个人微信直接阅读。
  // 想要企业微信内的富文本排版时，设 WECOM_WEBHOOK_MSGTYPE=markdown。
  const msgtype = (process.env.WECOM_WEBHOOK_MSGTYPE || "text").toLowerCase() === "markdown" ? "markdown" : "text";
  const content =
    msgtype === "markdown"
      ? buildWecomMarkdown(cfg.heroLine, cfg.dateStr, cfg.reportUrl)
      : buildWecomText(cfg.heroLine, cfg.dateStr, cfg.reportUrl);
  const result = await pushWecomWebhook(cfg.webhookUrl, content, cfg.reportUrl, undefined, msgtype);
  log(`消息格式: ${msgtype}`);
  if (result.error) {
    log(`❌ 企业微信(群机器人)推送失败: ${result.error}`);
    return false;
  }
  if (result.ok) {
    log(`✅ 企业微信(群机器人)推送完成：成功 ${result.sent}`);
    return true;
  }
  log(`❌ 企业微信(群机器人)部分失败：成功 ${result.sent}/${result.targets}`);
  for (const f of result.failed) log(`   失败 ${f.userid}: ${f.reason}`);
  return false;
}

async function main(): Promise<void> {
  const tz = process.env.REPORT_TZ || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const heroLine = loadHeroLine(path.join("history", dateStr, "store.json"));
  if (heroLine) {
    log(`读取定调: ${heroLine.slice(0, 40)}${heroLine.length > 40 ? "…" : ""}`);
  }

  const base = (process.env.REPORT_BASE_URL || "https://shengc-shv.github.io/gzinfo").replace(/\/+$/, "");
  const reportUrl = `${base}/${dateStr}/${dateStr}.html`;

  // 企业微信（群机器人 Webhook 优先；否则自建应用 message/send）
  const channel = (process.env.NOTIFY_CHANNEL || "wechat").toLowerCase();
  if (channel === "wecom") {
    // 群机器人 Webhook：自带 key 鉴权，不受企业可信 IP 限制，从 CI 直发（推荐，绕过 errcode 60020）
    const webhookUrl = process.env.WECOM_WEBHOOK ?? "";
    if (webhookUrl) {
      const ok = await pushWecomViaWebhook({ webhookUrl, heroLine, dateStr, reportUrl });
      if (!ok) process.exitCode = 1;
      log(`报告链接: ${reportUrl}`);
      return;
    }
    // 自建应用 message/send：需在后台把调用方公网 IP 加进「企业可信 IP」
    const corpId = process.env.WECOM_CORP_ID ?? "";
    const agentId = process.env.WECOM_AGENT_ID ?? "";
    const corpSecret = process.env.WECOM_CORP_SECRET ?? "";
    const userIds = (process.env.WECOM_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!corpId || !agentId || !corpSecret || userIds.length === 0) {
      log("缺少 WECOM_WEBHOOK 或 WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_CORP_SECRET / WECOM_USER_IDS，跳过企业微信推送 → 未交付");
      process.exitCode = 1;
      return;
    }
    const ok = await pushWecom({ corpId, agentId, corpSecret, userIds, heroLine, dateStr, reportUrl });
    if (!ok) process.exitCode = 1;
    log(`报告链接: ${reportUrl}`);
    return;
  }

  // 微信测试号模板消息（公众号渠道，2026-09-03 起保留，默认 NOTIFY_CHANNEL=wechat）
  const appId = process.env.WX_APP_ID ?? "";
  const appSecret = process.env.WX_APP_SECRET ?? "";
  const templateId = process.env.WX_TEMPLATE_ID ?? "";
  if (!appId || !appSecret || !templateId) {
    log("缺少 WX_APP_ID / WX_APP_SECRET / WX_TEMPLATE_ID，跳过微信推送 → 未交付");
    process.exitCode = 1;
    return;
  }
  const extraOpenIds = (process.env.WX_USER_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = await pushWechat({ appId, appSecret, templateId, baseUrl: base, extraOpenIds, heroLine, dateStr, reportUrl });
  if (!ok) process.exitCode = 1;
  log(`报告链接: ${reportUrl}`);
}

main().catch((e) => {
  log(`❌ 未捕获异常: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
