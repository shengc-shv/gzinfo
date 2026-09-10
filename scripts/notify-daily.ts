/**
 * 日报外发：公众号（微信测试号模板消息）+ 企业号（企业微信）**合并为一条流程**。
 *
 * 用法：npm run notify（由 .github/workflows/notify.yml 人工触发调用）
 *
 * 推送顺序（用户 2026-09-10 拍板）：① 公众号先推；② 企业号后推。
 * 任一渠道成功送达即视为正式交付（notify 退出 0）→ notify.yml 据此写当日交付信号
 * 并**立即结算**进长期记忆（Fix A；见 mark-delivered.ts）。两渠道均失败才退出 1。
 *
 * 渠道选择：默认 `both`（两渠道都推）；可用 NOTIFY_CHANNEL=wechat|wecom 单独指定
 * （仅单测 / 兜底用）。各渠道缺配置则跳过该渠道（不影响另一渠道）。
 *
 * env（CI secrets / vars）：
 *   公众号：
 *     WX_APP_ID       必填 测试号 appID
 *     WX_APP_SECRET   必填 测试号 appsecret
 *     WX_TEMPLATE_ID  必填 模板 ID
 *     WX_USER_ID      可选 显式目标 openid（逗号分隔；关注者列表之外补发）
 *   企业号：
 *     WECOM_WEBHOOK         可选 群机器人 Webhook（自带 key 鉴权，不受企业可信 IP 限制，推荐）
 *     WECOM_CORP_ID / _AGENT_ID / _CORP_SECRET / _USER_IDS  可选 自建应用 message/send
 *   公共：
 *     REPORT_BASE_URL 可选 报告根 URL，默认 https://shengc-shv.github.io/gzinfo
 *     REPORT_TZ       可选 报告时区，默认 Asia/Shanghai
 *
 * 数据源：history/<date>/store.json → executive.hero_line（+ guangdong_ipo.spoken 一行）
 *
 * 退出码：任一渠道真正送达 → 0；两渠道均缺配置或失败 → 1。
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

/**
 * 读 store.json 的执行摘要（宽松解析，缺字段返回空，绝不抛错）。
 * - heroLine：今日定调（模板消息 / markdown 正文主体）；
 * - ipoLine：当日「广东IPO」口播稿（2026-09-10 回检 P2：推送正文补一行广东IPO，
 *   此前领导必须点开报告才知道当天有没有可跟进的 IPO 商机）。
 */
function loadExecSummary(storePath: string): { heroLine: string; ipoLine: string } {
  const empty = { heroLine: "", ipoLine: "" };
  if (!fs.existsSync(storePath)) {
    log(`未找到 ${storePath}，使用默认数据`);
    return empty;
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      executive?: { hero_line?: string; guangdong_ipo?: { spoken?: string } };
    };
    return {
      heroLine: store.executive?.hero_line ?? "",
      ipoLine: store.executive?.guangdong_ipo?.spoken ?? "",
    };
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
  ipoLine?: string;
  dateStr: string;
  reportUrl: string;
}): Promise<boolean> {
  const markdown = buildWecomMarkdown(cfg.heroLine, cfg.dateStr, cfg.reportUrl, cfg.ipoLine);
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
  ipoLine?: string;
  dateStr: string;
  reportUrl: string;
}): Promise<boolean> {
  // 默认 text：markdown 在个人微信显示「暂不支持此消息类型，请在企业微信中查看」
  // （官方答复微信侧不支持渲染 markdown），text 才能在个人微信直接阅读。
  // 想要企业微信内的富文本排版时，设 WECOM_WEBHOOK_MSGTYPE=markdown。
  const msgtype = (process.env.WECOM_WEBHOOK_MSGTYPE || "text").toLowerCase() === "markdown" ? "markdown" : "text";
  const content =
    msgtype === "markdown"
      ? buildWecomMarkdown(cfg.heroLine, cfg.dateStr, cfg.reportUrl, cfg.ipoLine)
      : buildWecomText(cfg.heroLine, cfg.dateStr, cfg.reportUrl, cfg.ipoLine);
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

  const { heroLine, ipoLine } = loadExecSummary(path.join("history", dateStr, "store.json"));
  if (heroLine) {
    log(`读取定调: ${heroLine.slice(0, 40)}${heroLine.length > 40 ? "…" : ""}`);
  }
  if (ipoLine) {
    log(`读取广东IPO: ${ipoLine.slice(0, 40)}${ipoLine.length > 40 ? "…" : ""}`);
  }

  const base = (process.env.REPORT_BASE_URL || "https://shengc-shv.github.io/gzinfo").replace(/\/+$/, "");
  const reportUrl = `${base}/${dateStr}/${dateStr}.html`;

  // 渠道选择：默认 both（公众号 + 企业号合并推送）；NOTIFY_CHANNEL 可单测/兜底指定单一渠道。
  const channel = (process.env.NOTIFY_CHANNEL || "both").toLowerCase();

  let okWechat = false;
  let okWecom = false;

  // ① 公众号（微信测试号模板消息）—— 顺序在前
  if (channel === "both" || channel === "wechat") {
    const appId = process.env.WX_APP_ID ?? "";
    const appSecret = process.env.WX_APP_SECRET ?? "";
    const templateId = process.env.WX_TEMPLATE_ID ?? "";
    if (!appId || !appSecret || !templateId) {
      log("⚠️ 公众号未配置（缺 WX_APP_ID / WX_APP_SECRET / WX_TEMPLATE_ID），跳过");
    } else {
      const extraOpenIds = (process.env.WX_USER_ID ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      okWechat = await pushWechat({ appId, appSecret, templateId, baseUrl: base, extraOpenIds, heroLine, dateStr, reportUrl });
    }
  }

  // ② 企业号（群机器人 Webhook 优先；否则自建应用 message/send）—— 顺序在后
  if (channel === "both" || channel === "wecom") {
    const webhookUrl = process.env.WECOM_WEBHOOK ?? "";
    if (webhookUrl) {
      okWecom = await pushWecomViaWebhook({ webhookUrl, heroLine, ipoLine, dateStr, reportUrl });
    } else {
      const corpId = process.env.WECOM_CORP_ID ?? "";
      const agentId = process.env.WECOM_AGENT_ID ?? "";
      const corpSecret = process.env.WECOM_CORP_SECRET ?? "";
      const userIds = (process.env.WECOM_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!corpId || !agentId || !corpSecret || userIds.length === 0) {
        log("⚠️ 企业号未配置（缺 WECOM_WEBHOOK 或 WECOM_CORP_ID/Agent/Secret/UserIds），跳过");
      } else {
        okWecom = await pushWecom({ corpId, agentId, corpSecret, userIds, heroLine, ipoLine, dateStr, reportUrl });
      }
    }
  }

  log(`报告链接: ${reportUrl}`);

  // 任一渠道成功即视为正式交付（触发 notify.yml 写交付信号 + 结算）；两渠道均失败才未交付。
  if (okWechat || okWecom) {
    log(`✅ 交付达成：公众号=${okWechat} 企业号=${okWecom} → notify 退出 0，notify.yml 将写交付信号并结算`);
  } else {
    log("❌ 公众号与企业号均未成功送达（缺配置或推送失败）→ 未交付，notify 退出 1");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  log(`❌ 未捕获异常: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
