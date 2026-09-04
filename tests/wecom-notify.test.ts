import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWecomMarkdown, pushWecomDaily } from "../lib/notify/wecom";

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
