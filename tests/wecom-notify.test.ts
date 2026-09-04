import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWecomMarkdown,
  buildWecomText,
  pushWecomDaily,
  pushWecomWebhook,
  sendWecomWebhook,
} from "../lib/notify/wecom";

/** 简易 fetch mock：handler 返回 JSON 对象，模拟企业微信 API 响应。 */
function mockFetch(handler: (url: string, init?: unknown) => Record<string, unknown>) {
  return (async (url: string, init?: unknown) => ({
    json: async () => handler(url, init),
  })) as unknown as typeof fetch;
}

test("buildWecomMarkdown：含标题/日期星期/定调/链接", () => {
  const md = buildWecomMarkdown("房贷利率再下调", "2026-09-04", "https://x/2026-09-04/2026-09-04.html");
  assert.match(md, /# 📢 广州分行今日日报已生成/);
  assert.match(md, /📅 2026-09-04（周五）/);
  assert.match(md, /今日定调/);
  assert.match(md, /房贷利率再下调/);
  assert.match(md, /\[点击查看完整日报 →\]\(https:\/\/x\/2026-09-04\/2026-09-04\.html\)/);
});

test("buildWecomMarkdown：无定调时给出兜底引导", () => {
  const md = buildWecomMarkdown("", "2026-09-04", "https://x");
  assert.match(md, /今日暂无定调/);
});

test("pushWecomDaily：成功路径（token + send 两次请求）", async () => {
  const calls: string[] = [];
  const fetchImpl = mockFetch((url) => {
    calls.push(url);
    if (url.includes("/gettoken")) return { access_token: "TOK" };
    if (url.includes("/message/send")) return { errcode: 0, errmsg: "ok" };
    return {};
  });
  const r = await pushWecomDaily(
    { corpId: "c", agentId: "1", corpSecret: "s", userIds: ["zhangsan"], fetchImpl },
    "markdown-body",
    "https://x",
  );
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(r.failed.length, 0);
  assert.equal(calls.length, 2, "应先后请求 gettoken 与 message/send");
});

test("pushWecomDaily：token 失败 → ok=false 且带 error", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/gettoken")) return { errcode: 40013, errmsg: "invalid corpid" };
    return {};
  });
  const r = await pushWecomDaily(
    { corpId: "bad", agentId: "1", corpSecret: "s", userIds: ["zhangsan"], fetchImpl },
    "md",
    "https://x",
  );
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("invalid corpid"));
});

test("pushWecomDaily：发送失败 → ok=false 且 failed 记录原因", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/gettoken")) return { access_token: "TOK" };
    if (url.includes("/message/send")) return { errcode: 81013, errmsg: "all invalid", invaliduser: "zhangsan" };
    return {};
  });
  const r = await pushWecomDaily(
    { corpId: "c", agentId: "1", corpSecret: "s", userIds: ["zhangsan"], fetchImpl },
    "md",
    "https://x",
  );
  assert.equal(r.ok, false);
  assert.equal(r.sent, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /81013/);
});

test("pushWecomWebhook：成功路径（POST webhook，errcode=0）", async () => {
  const calls: string[] = [];
  const fetchImpl = mockFetch((url) => {
    calls.push(url);
    if (url.includes("/webhook/send")) return { errcode: 0, errmsg: "ok" };
    return {};
  });
  const r = await pushWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", "md", "https://x", fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(r.failed.length, 0);
  assert.equal(calls.length, 1, "webhook 只发一次 POST");
});

test("pushWecomWebhook：发送失败（errcode≠0）→ ok=false 且 failed 记录原因", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/webhook/send")) return { errcode: 93000, errmsg: "invalid webhook url" };
    return {};
  });
  const r = await pushWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=BAD", "md", "https://x", fetchImpl);
  assert.equal(r.ok, false);
  assert.equal(r.sent, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /93000/);
});

test("sendWecomWebhook：errcode≠0 直接抛错（供上层 try/catch 收集）", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/webhook/send")) return { errcode: 93000, errmsg: "invalid webhook url" };
    return {};
  });
  await assert.rejects(() => sendWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", "md", fetchImpl), /93000/);
});

test("buildWecomText：纯文本正文、URL 明文单行（个人微信可直接阅读）", () => {
  const t = buildWecomText("房贷利率再下调", "2026-09-04", "https://x/2026-09-04/2026-09-04.html");
  assert.match(t, /广州分行今日日报已生成/);
  assert.match(t, /📅 2026-09-04（周五）/);
  assert.match(t, /【今日定调】房贷利率再下调/);
  // 关键：不得出现 markdown / 企业微信专属 inline html —— 微信端不支持渲染，会原样显示成噪音
  assert.ok(!t.includes("#"), "不应含 markdown 标题符 #");
  assert.ok(!t.includes("**"), "不应含 markdown 加粗 **");
  assert.ok(!/\]\(/.test(t), "不应含 markdown 链接语法 []()");
  assert.ok(!t.includes("<font"), "不应含企业微信专属 <font> 标签");
  // URL 单独一行明文 → 微信/企业微信都会自动识别为可点链接
  assert.match(t, /\nhttps:\/\/x\/2026-09-04\/2026-09-04\.html$/);
});

test("buildWecomText：无定调时给出兜底引导", () => {
  const t = buildWecomText("", "2026-09-04", "https://x");
  assert.match(t, /今日暂无定调/);
});

test("sendWecomWebhook：默认 text 格式（微信端可读；markdown 官方不支持）", async () => {
  const bodies: string[] = [];
  const fetchImpl = mockFetch((url, init) => {
    if (url.includes("/webhook/send")) {
      bodies.push(String((init as { body?: unknown })?.body ?? ""));
      return { errcode: 0, errmsg: "ok" };
    }
    return {};
  });
  await sendWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", "正文", fetchImpl);
  assert.equal(bodies.length, 1);
  const payload = JSON.parse(bodies[0]) as Record<string, unknown>;
  assert.equal(payload.msgtype, "text");
  assert.equal((payload.text as { content: string }).content, "正文");
  assert.equal(payload.markdown, undefined, "text 模式不应带 markdown 字段");
});

test("sendWecomWebhook：msgtype=markdown 走 markdown 字段层级（企业微信内富文本）", async () => {
  const bodies: string[] = [];
  const fetchImpl = mockFetch((url, init) => {
    if (url.includes("/webhook/send")) {
      bodies.push(String((init as { body?: unknown })?.body ?? ""));
      return { errcode: 0, errmsg: "ok" };
    }
    return {};
  });
  await sendWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", "# md", fetchImpl, "markdown");
  const payload = JSON.parse(bodies[0]) as Record<string, unknown>;
  assert.equal(payload.msgtype, "markdown");
  assert.equal((payload.markdown as { content: string }).content, "# md");
  assert.equal(payload.text, undefined, "markdown 模式不应带 text 字段");
});

test("pushWecomWebhook：透传 msgtype 到 webhook 请求体", async () => {
  const bodies: string[] = [];
  const fetchImpl = mockFetch((url, init) => {
    if (url.includes("/webhook/send")) {
      bodies.push(String((init as { body?: unknown })?.body ?? ""));
      return { errcode: 0, errmsg: "ok" };
    }
    return {};
  });
  const r = await pushWecomWebhook(
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K",
    "纯文本正文",
    "https://x",
    fetchImpl,
    "text",
  );
  assert.equal(r.ok, true);
  const payload = JSON.parse(bodies[0]) as Record<string, unknown>;
  assert.equal(payload.msgtype, "text");
  assert.equal((payload.text as { content: string }).content, "纯文本正文");
});
