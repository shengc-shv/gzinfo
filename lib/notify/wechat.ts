/**
 * 微信公众号（测试号）主动推送 — 日报外发渠道（B1，2026-09-01）
 *
 * 链路：access_token → 拉取关注者 openid（user/get）→ 逐人发模板消息（template/send）。
 * 只主动调 API，不接收微信事件回调 → 无需配置服务器 URL/Token，CI 里直接跑。
 *
 * 微信接口：
 *   GET  https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=..&secret=..
 *   GET  https://api.weixin.qq.com/cgi-bin/user/get?access_token=..[&next_openid=..]
 *   POST https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=..
 *
 * 设计约束：
 *   - 单条发送失败不中断整体（逐人 try/catch，收集 failed）
 *   - 任何阶段失败都返回 { ok:false, error }，不抛异常 → 调用方决定是否阻断
 *   - fetch 可注入（fetchImpl），测试零 mock 全局
 */

export interface WechatNotifierConfig {
  appId: string;
  appSecret: string;
  templateId: string;
  /** 报告链接前缀，如 https://shengc-shv.github.io/gzinfo（模板消息 url 跳转用） */
  baseUrl: string;
  /** 额外显式目标 openid（WX_USER_ID，逗号分隔拆出），与粉丝列表去重合并 */
  extraOpenIds?: string[];
  /** 测试注入用，默认 global fetch */
  fetchImpl?: typeof fetch;
}

export interface TemplatePayload {
  title: string;
  date: string;
  words: string;
}

export interface NotifyResult {
  ok: boolean;
  targets: number;
  sent: number;
  failed: { openid: string; reason: string }[];
  /** 整体失败原因（token/拉取关注者失败等），逐条失败则只进 failed */
  error?: string;
}

const API = "https://api.weixin.qq.com";

/** 换取 access_token（2h 有效，CI 一次性使用无需缓存） */
export async function getAccessToken(
  appId: string,
  appSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${API}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
  const res = await fetchImpl(url);
  const body = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
  if (!body.access_token) {
    throw new Error(`微信 access_token 获取失败: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/** 全量拉取关注者 openid（分页跟随 next_openid；几个人一次性拿完） */
export async function getFollowerOpenIds(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const openids: string[] = [];
  let next = "";
  do {
    const url = `${API}/cgi-bin/user/get?access_token=${encodeURIComponent(accessToken)}${next ? `&next_openid=${encodeURIComponent(next)}` : ""}`;
    const res = await fetchImpl(url);
    const body = (await res.json()) as { data?: { openid?: string[] }; next_openid?: string; errcode?: number; errmsg?: string };
    if (body.errcode && body.errcode !== 0) {
      throw new Error(`拉取关注者失败: ${JSON.stringify(body)}`);
    }
    openids.push(...(body.data?.openid ?? []));
    next = body.next_openid ?? "";
  } while (next);
  return openids;
}

/** 给单个用户发模板消息（失败抛错，由调用方收集） */
export async function sendTemplateMessage(
  opts: {
    accessToken: string;
    openid: string;
    templateId: string;
    url: string;
    data: Record<string, string>;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${API}/cgi-bin/message/template/send?access_token=${encodeURIComponent(opts.accessToken)}`;
  const payload = {
    touser: opts.openid,
    template_id: opts.templateId,
    url: opts.url,
    data: Object.fromEntries(Object.entries(opts.data).map(([k, v]) => [k, { value: v }])),
  };
  const res = await fetchImpl(url, { method: "POST", body: JSON.stringify(payload) });
  const body = (await res.json()) as { errcode?: number; errmsg?: string };
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`模板消息发送失败(errcode=${body.errcode}): ${body.errmsg ?? JSON.stringify(body)}`);
  }
}

/**
 * 组装模板 data（与用户建的测试模板对应：{{title.DATA}} / {{date.DATA}} / {{words.DATA}}）。
 * 微信 keyword 类字段对长度敏感，words 截断到 40 字兜底（完整定调看日报正文，消息仅作提醒）。
 * 2026-09-01 用户反馈"收到的信息很不起眼" → 文案强化：
 *   title 加 📢（会话列表摘要醒目）；date 加星期；words 定调前置【今日定调】标签。
 */
const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function buildTemplatePayload(heroLine: string, dateStr: string): TemplatePayload {
  const weekday = WEEKDAY_CN[new Date(`${dateStr}T12:00:00+08:00`).getDay()] ?? "";
  const words = heroLine
    ? `【今日定调】${heroLine}`.slice(0, 40)
    : "⚠️ 今日暂无定调，点击查看完整日报";
  return {
    title: "📢 广州分行今日日报已生成",
    date: `📅 ${dateStr}（${weekday}）`,
    words,
  };
}

/**
 * 主编排：token → 粉丝 + 显式目标（去重）→ 逐人发送（单条失败不中断）。
 * 任何整体阶段失败返回 ok=false + error；逐条失败进 failed。
 */
export async function pushDailyReport(
  cfg: WechatNotifierConfig,
  payload: TemplatePayload,
  url: string,
): Promise<NotifyResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  try {
    const token = await getAccessToken(cfg.appId, cfg.appSecret, fetchImpl);
    const followers = await getFollowerOpenIds(token, fetchImpl);
    const targets = [...new Set([...followers, ...(cfg.extraOpenIds ?? [])])];
    if (targets.length === 0) {
      return { ok: false, targets: 0, sent: 0, failed: [], error: "无关注者且无显式目标 openid，跳过发送" };
    }
    const failed: NotifyResult["failed"] = [];
    let sent = 0;
    for (const openid of targets) {
      try {
        await sendTemplateMessage(
          { accessToken: token, openid, templateId: cfg.templateId, url, data: { ...payload } },
          fetchImpl,
        );
        sent++;
      } catch (e) {
        failed.push({ openid, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ok: failed.length === 0, targets: targets.length, sent, failed };
  } catch (e) {
    return { ok: false, targets: 0, sent: 0, failed: [], error: e instanceof Error ? e.message : String(e) };
  }
}
