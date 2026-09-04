/**
 * 企业微信自建应用消息推送 — 日报外发渠道（新增，2026-09-04）
 *
 * 送达位置：企业微信 App 内聊天；在「我的企业 → 微信插件」扫码绑定后，
 * 应用消息直接进接收人的个人微信聊天列表 —— 即用户要求的「正常聊天窗口」。
 *
 * 链路：gettoken → message/send（msgtype=markdown）。
 * markdown 支持标题/加粗/链接/引用/字体颜色，长度上限 4096 字节，远比公众号
 * 模板消息的 40 字截断宽松，日报定调可完整呈现。
 *
 * 与 lib/notify/wechat.ts（公众号模板消息）并存，由 scripts/notify-daily.ts 的
 * NOTIFY_CHANNEL=wecom|wechat 选择；下游 mark-delivered / 交付结算闸门完全复用。
 *
 * 设计约束（与 wechat.ts 对齐）：
 *   - 发送失败不中断整体（try/catch 收集 failed）
 *   - 任何阶段失败都返回 { ok:false, error }，不抛异常 → 调用方决定是否阻断
 *   - fetch 可注入（fetchImpl），测试零 mock 全局
 */

export interface WecomNotifierConfig {
  corpId: string;
  agentId: string;
  corpSecret: string;
  /** 目标成员 userid 列表（逗号分隔）；含 "@all" 即推应用可见范围全员 */
  userIds: string[];
  /** 测试注入用，默认 global fetch */
  fetchImpl?: typeof fetch;
}

export interface WecomNotifyResult {
  ok: boolean;
  targets: number;
  sent: number;
  failed: { userid: string; reason: string }[];
  /** 整体失败原因（token/发送失败等），逐条失败则只进 failed */
  error?: string;
}

const API = "https://qyapi.weixin.qq.com";

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 换取 access_token（2h 有效，CI 一次性使用无需缓存） */
export async function getWecomToken(
  corpId: string,
  corpSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${API}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
  const res = await fetchImpl(url);
  const body = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
  if (!body.access_token) {
    throw new Error(`企业微信 access_token 获取失败: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/** 给成员发 markdown 应用消息（touser 用 | 拼接，上限 1000）。失败抛错。 */
export async function sendWecomMarkdown(
  opts: {
    accessToken: string;
    agentId: string;
    touser: string; // 已拼接，如 "zhangsan|lisi" 或 "@all"
    content: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${API}/cgi-bin/message/send?access_token=${encodeURIComponent(opts.accessToken)}`;
  const payload = {
    touser: opts.touser,
    msgtype: "markdown",
    agentid: Number(opts.agentId),
    markdown: { content: opts.content },
    enable_duplicate_check: 1,
    duplicate_check_interval: 1800,
  };
  const res = await fetchImpl(url, { method: "POST", body: JSON.stringify(payload) });
  const body = (await res.json()) as { errcode?: number; errmsg?: string; invaliduser?: string };
  if (body.errcode && body.errcode !== 0) {
    const detail = body.invaliduser ? ` invaliduser=${body.invaliduser}` : "";
    throw new Error(`企业微信消息发送失败(errcode=${body.errcode})${detail}: ${body.errmsg ?? JSON.stringify(body)}`);
  }
}

/**
 * 组装 markdown 正文（不被 40 字截断；完整定调 + 跳转链接）。
 * 企业微信 markdown 语法有限：# 标题 / **加粗** / [链接](url) / > 引用 / <font color>。
 */
export function buildWecomMarkdown(heroLine: string, dateStr: string, url: string): string {
  const weekday = WEEKDAY_CN[new Date(`${dateStr}T12:00:00+08:00`).getDay()] ?? "";
  const title = "# 📢 广州分行今日日报已生成";
  const dateLine = `📅 ${dateStr}（${weekday}）`;
  const hero = heroLine
    ? `> **【今日定调】** ${heroLine}`
    : "> ⚠️ 今日暂无定调，点击查看完整日报";
  const link = `[点击查看完整日报 →](${url})`;
  return [title, dateLine, "", hero, "", link].join("\n");
}

/**
 * 组装**纯文本**正文（2026-09-04 中午新增，群机器人默认格式）。
 *
 * 为什么需要纯文本版：微信侧不支持渲染 markdown 消息——企业微信开发者中心官方答复
 * 「微信侧不支持展示 markdown 消息」，个人微信收到时会显示「暂不支持此消息类型，
 * 请在企业微信中查看」。而 text 消息在个人微信可正常阅读（同一场景的 zabbix 告警实践
 * 已证实：markdown 改成 text 后无需打开企业微信即可阅读）。
 *
 * 因此面向「个人微信可见」的群机器人通道默认用 text：
 *   - 不用 # / ** / []() 等 markdown 语法（微信端会原样显示成噪音字符）
 *   - 不用 <font color> 等企业微信专属 inline html（微信端会显示成字面标签）
 *   - URL 单独一行**明文**给出 → 微信/企业微信都会自动识别为可点链接
 *   - emoji 与全角标点在两端都能正常渲染，用于保留可读性
 */
export function buildWecomText(heroLine: string, dateStr: string, url: string): string {
  const weekday = WEEKDAY_CN[new Date(`${dateStr}T12:00:00+08:00`).getDay()] ?? "";
  const title = "📢 广州分行今日日报已生成";
  const dateLine = `📅 ${dateStr}（${weekday}）`;
  const hero = heroLine ? `【今日定调】${heroLine}` : "【今日定调】今日暂无定调，请点击下方链接查看完整日报";
  return [title, dateLine, "", hero, "", "👉 点击查看完整日报：", url].join("\n");
}

/**
 * 主编排：token → 组装 markdown → 发送（单条失败收集进 failed）。
 * 任何整体阶段失败返回 ok=false + error；逐条失败进 failed。
 */
export async function pushWecomDaily(
  cfg: WecomNotifierConfig,
  markdown: string,
  url: string,
): Promise<WecomNotifyResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const touser = cfg.userIds.includes("@all") ? "@all" : cfg.userIds.join("|");
  const targets = cfg.userIds.length;
  try {
    const token = await getWecomToken(cfg.corpId, cfg.corpSecret, fetchImpl);
    try {
      await sendWecomMarkdown({ accessToken: token, agentId: cfg.agentId, touser, content: markdown }, fetchImpl);
      return { ok: true, targets, sent: targets, failed: [] };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, targets, sent: 0, failed: cfg.userIds.map((u) => ({ userid: u, reason })) };
    }
  } catch (e) {
    return { ok: false, targets: 0, sent: 0, failed: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * ── 群机器人 Webhook 通道（2026-09-04 新增，推荐）──
 *
 * 自建应用 message/send 受「企业可信 IP」白名单约束（errcode 60020），而 GitHub
 * Actions runner 出口 IP 动态变化无法稳定加白名单。群机器人 Webhook 走独立鉴权
 * key，完全不受企业可信 IP 限制，从 CI 直接 POST 即可。
 *
 * 代价：消息送达「群聊」而非 1:1 私聊（可建一个只有自己的群，近似私聊体验）。
 * 获取方式：企业微信任意群 → 群设置 → 群机器人 → 添加 → 复制
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxx
 * 把整串 URL 填进 WECOM_WEBHOOK 即可，无需 corpId/agentId/secret/userIds。
 */

/**
 * 群机器人支持的消息类型。
 * - text（默认）：**个人微信可直接阅读**。markdown 消息在微信端显示「暂不支持此消息
 *   类型，请在企业微信中查看」（官方答复：微信侧不支持展示 markdown 消息）。
 * - markdown：排版更好（标题/加粗/引用/字体色），但**只能在企业微信 App 内查看**。
 */
export type WecomWebhookMsgType = "text" | "markdown";

/** 向群机器人 webhook 发送一条消息（失败抛错）。默认 text，保证个人微信可直接阅读。 */
export async function sendWecomWebhook(
  webhookUrl: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
  msgtype: WecomWebhookMsgType = "text",
): Promise<void> {
  // 群机器人两种格式的字段层级不同：text → { text: { content } }；markdown → { markdown: { content } }
  const contentBody = msgtype === "markdown" ? { markdown: { content } } : { text: { content } };
  const payload = { msgtype, ...contentBody };
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { errcode?: number; errmsg?: string };
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`企业微信群机器人发送失败(errcode=${body.errcode}): ${body.errmsg ?? JSON.stringify(body)}`);
  }
}

/** 群机器人主编排：组装正文 → 发送。返回结构与 pushWecomDaily 同形。 */
export async function pushWecomWebhook(
  webhookUrl: string,
  content: string,
  url: string,
  fetchImpl?: typeof fetch,
  msgtype: WecomWebhookMsgType = "text",
): Promise<WecomNotifyResult> {
  try {
    await sendWecomWebhook(webhookUrl, content, fetchImpl, msgtype);
    return { ok: true, targets: 1, sent: 1, failed: [] };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, targets: 1, sent: 0, failed: [{ userid: "(webhook)", reason }] };
  }
}
