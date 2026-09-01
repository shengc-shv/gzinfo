/**
 * Server酱（ServerChan）推送 — 日报外发渠道补充（2026-09-01）
 *
 * 链路：POST https://sctapi.ftqq.com/{SENDKEY}.send，form 参数 title + desp（desp 支持 Markdown）。
 * 新版 Server酱³ 的 SendKey 形如 sctp<UID>t... → 走 https://<UID>.push.ft07.com/send/<SENDKEY>.send。
 *
 * 设计约束：
 *   - 任何失败返回 { ok:false, code, message }，不抛异常 → 调用方决定是否阻断
 *   - fetch 可注入（fetchImpl），测试零 mock 全局
 *   - desp 由 buildServerChanDesp() 从 store executive 组装 Markdown（比微信模板消息信息量大得多）
 */

export interface ServerChanConfig {
  sendKey: string;
  title: string;
  desp: string;
  /** 测试注入用，默认 global fetch */
  fetchImpl?: typeof fetch;
}

export interface ServerChanResult {
  ok: boolean;
  /** 接口返回 code（0=成功；网络异常为 null） */
  code: number | null;
  message: string;
}

/** executive 精简结构（从 history/<date>/store.json 读取，缺失字段留空即可） */
export interface ExecutiveBrief {
  hero_line?: string;
  must_read?: { title?: string; why?: string; url?: string }[];
  insights?: { topic?: string; impact?: string; action?: string; tag?: string[] }[];
  risk?: { topic?: string; evidence?: string; impact?: string; action?: string } | null;
  guangdong_ipo?: { spoken?: string } | null;
}

/**
 * 拼接发送 URL：
 * - 标准 SendKey（SCT...）→ https://sctapi.ftqq.com/<key>.send
 * - Server酱³ SendKey（sctp<UID>t...）→ https://<UID>.push.ft07.com/send/<key>.send
 */
export function buildSendUrl(sendKey: string): string {
  const m = sendKey.match(/^sctp(\d+)t/i);
  if (m) {
    return `https://${m[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`;
  }
  return `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
}

/**
 * 发送一条 Server酱 消息。任何失败（网络/非 0 code）返回 ok=false，不抛异常。
 */
export async function sendServerChan(cfg: ServerChanConfig): Promise<ServerChanResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = buildSendUrl(cfg.sendKey);
  try {
    const body = new URLSearchParams({ title: cfg.title, desp: cfg.desp });
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as { code?: unknown; message?: unknown };
    const code = typeof json.code === "number" ? json.code : null;
    if (code !== 0) {
      return { ok: false, code, message: typeof json.message === "string" ? json.message : `HTTP ${res.status}` };
    }
    return { ok: true, code, message: typeof json.message === "string" ? json.message : "ok" };
  } catch (e) {
    return { ok: false, code: null, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 从 executive 组装 Markdown 消息体：今日定调 / 必读 / 商机 / 风险 / 广东IPO / 报告链接。
 * 缺字段的板块自动省略，链接兜底必在。
 */
export function buildServerChanDesp(exec: ExecutiveBrief, reportUrl: string): string {
  const parts: string[] = [];

  if (exec.hero_line) {
    parts.push(`## 📢 今日定调\n\n${exec.hero_line}`);
  }

  if (exec.must_read?.length) {
    const items = exec.must_read
      .map((m, i) => {
        const why = m.why ? ` — ${m.why}` : "";
        return m.url ? `${i + 1}. [${m.title ?? ""}](${m.url})${why}` : `${i + 1}. ${m.title ?? ""}${why}`;
      })
      .join("\n");
    parts.push(`## 📚 必读（${exec.must_read.length}）\n\n${items}`);
  }

  if (exec.insights?.length) {
    const items = exec.insights
      .map((s, i) => {
        const impact = s.impact ? `\n   > ${s.impact}` : "";
        return `${i + 1}. **${s.topic ?? ""}**${impact}`;
      })
      .join("\n");
    parts.push(`## 💡 商机（${exec.insights.length}）\n\n${items}`);
  }

  if (exec.risk?.topic) {
    const evidence = exec.risk.evidence ? `\n\n${exec.risk.evidence}` : "";
    parts.push(`## ⚠️ 风险\n\n**${exec.risk.topic}**${evidence}`);
  }

  if (exec.guangdong_ipo?.spoken) {
    parts.push(`## 📈 广东IPO\n\n${exec.guangdong_ipo.spoken}`);
  }

  parts.push(`[📄 查看完整日报 →](${reportUrl})`);
  return parts.join("\n\n");
}
