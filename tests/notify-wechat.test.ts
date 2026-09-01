/**
 * lib/notify/wechat.ts 单元测试 — B1 微信测试号推送（2026-09-01）
 * 覆盖：token 获取 / 分页拉粉丝 / 模板 data 组装 / 端到端发送统计 /
 *       单条失败不中断 / 整体失败不抛异常 / 空目标 / 去重合并
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAccessToken,
  getFollowerOpenIds,
  sendTemplateMessage,
  buildTemplatePayload,
  pushDailyReport,
  type TemplatePayload,
} from "../lib/notify/wechat.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** 按 URL 子串匹配返回预置 JSON 的 fake fetch */
function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit) => {
    const u = String(input);
    for (const [pat, body] of Object.entries(routes)) {
      if (u.includes(pat)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
}

const TOKEN_URL_PAT = "/cgi-bin/token?";
const USERS_URL_PAT = "/cgi-bin/user/get?";
const SEND_URL_PAT = "/cgi-bin/message/template/send?";

const CFG = {
  appId: "wx-test-app-id",
  appSecret: "s3cret",
  templateId: "TPL-1",
  baseUrl: "https://example.com/gzinfo",
};

function payload(hero = "今日定调测试"): TemplatePayload {
  return buildTemplatePayload(hero, "2026-09-01");
}

test("getAccessToken: 成功返回 token", async () => {
  const fetchImpl = jsonFetch({ [TOKEN_URL_PAT]: { access_token: "TOK_ABC", expires_in: 7200 } });
  const t = await getAccessToken("id", "secret", fetchImpl);
  assert.equal(t, "TOK_ABC");
});

test("getAccessToken: errcode 抛错", async () => {
  const fetchImpl = jsonFetch({ [TOKEN_URL_PAT]: { errcode: 40013, errmsg: "invalid appid" } });
  await assert.rejects(() => getAccessToken("id", "secret", fetchImpl), /access_token 获取失败/);
});

test("getFollowerOpenIds: 分页跟随 next_openid 全量合并", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: FetchInput) => {
    const u = String(input);
    calls.push(u);
    if (!u.includes("next_openid")) {
      return new Response(JSON.stringify({ data: { openid: ["o_1", "o_2"] }, next_openid: "o_3" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: { openid: ["o_3", "o_4"] }, next_openid: "" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const ids = await getFollowerOpenIds("TOK", fetchImpl);
  assert.deepEqual(ids, ["o_1", "o_2", "o_3", "o_4"]);
  assert.equal(calls.length, 2);
});

test("sendTemplateMessage: 组装正确 payload 且 errcode=0 不抛", async () => {
  let sentBody: unknown = null;
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    sentBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await sendTemplateMessage(
    { accessToken: "TOK", openid: "o_1", templateId: "TPL-1", url: "https://x/2026-09-01.html", data: { title: "T", date: "2026-09-01", words: "W" } },
    fetchImpl,
  );
  assert.deepEqual(sentBody, {
    touser: "o_1",
    template_id: "TPL-1",
    url: "https://x/2026-09-01.html",
    data: { title: { value: "T" }, date: { value: "2026-09-01" }, words: { value: "W" } },
  });
});

test("sendTemplateMessage: 非零 errcode 抛错", async () => {
  const fetchImpl = jsonFetch({ [SEND_URL_PAT]: { errcode: 40003, errmsg: "invalid openid" } });
  await assert.rejects(
    () =>
      sendTemplateMessage(
        { accessToken: "TOK", openid: "bad", templateId: "T", url: "https://x", data: { title: "a" } },
        fetchImpl,
      ),
    /errcode=40003/,
  );
});

test("buildTemplatePayload: 定调截断 40 字 + 空值兜底 + 醒目文案 + tip 引导行", () => {
  const long = "今".repeat(60);
  const p = buildTemplatePayload(long, "2026-09-01");
  assert.equal(p.title, "📢 广州分行今日日报已生成");
  assert.equal(p.date, "📅 2026-09-01（周二）");
  assert.equal(p.words.length, 40);
  assert.ok(p.words.startsWith("【今日定调】"));
  assert.equal(p.tip, "点击查看完整日报 →");
  const empty = buildTemplatePayload("", "2026-09-01");
  assert.equal(empty.words, "⚠️ 今日暂无定调，点击查看完整日报");
});

test("pushDailyReport: 端到端 粉丝+extra 去重合并、逐人发送、统计正确", async () => {
  const sent: string[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const u = String(input);
    if (u.includes(TOKEN_URL_PAT)) return new Response(JSON.stringify({ access_token: "TOK" }), { headers: { "content-type": "application/json" } });
    if (u.includes(USERS_URL_PAT)) return new Response(JSON.stringify({ data: { openid: ["o_1", "o_2"] }, next_openid: "" }), { headers: { "content-type": "application/json" } });
    if (u.includes(SEND_URL_PAT)) {
      const body = JSON.parse(String(init?.body));
      sent.push(body.touser);
      return new Response(JSON.stringify({ errcode: 0 }), { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const r = await pushDailyReport(
    { ...CFG, extraOpenIds: ["o_2", "o_3"], fetchImpl },
    payload(),
    "https://example.com/gzinfo/2026-09-01/2026-09-01.html",
  );
  assert.equal(r.ok, true);
  assert.equal(r.targets, 3); // o_1, o_2（去重）, o_3
  assert.equal(r.sent, 3);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(sent, ["o_1", "o_2", "o_3"]);
});

test("pushDailyReport: 单条失败不中断，其余照发，failed 收集原因", async () => {
  const sent: string[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const u = String(input);
    if (u.includes(TOKEN_URL_PAT)) return new Response(JSON.stringify({ access_token: "TOK" }), { headers: { "content-type": "application/json" } });
    if (u.includes(USERS_URL_PAT)) return new Response(JSON.stringify({ data: { openid: ["o_1", "o_2"] }, next_openid: "" }), { headers: { "content-type": "application/json" } });
    if (u.includes(SEND_URL_PAT)) {
      const body = JSON.parse(String(init?.body));
      sent.push(body.touser);
      if (body.touser === "o_1") {
        return new Response(JSON.stringify({ errcode: 40003, errmsg: "invalid openid" }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ errcode: 0 }), { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const r = await pushDailyReport({ ...CFG, fetchImpl }, payload(), "https://x/2026-09-01.html");
  assert.equal(r.ok, false); // 有失败
  assert.equal(r.targets, 2);
  assert.equal(r.sent, 1);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /errcode=40003/);
});

test("pushDailyReport: token 整体失败 → ok=false + error，不抛异常", async () => {
  const fetchImpl = jsonFetch({ [TOKEN_URL_PAT]: { errcode: 40013, errmsg: "bad appid" } });
  const r = await pushDailyReport({ ...CFG, fetchImpl }, payload(), "https://x");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /access_token 获取失败/);
  assert.equal(r.sent, 0);
});

test("pushDailyReport: 空目标（无粉丝无 extra）→ ok=false 且提示", async () => {
  const fetchImpl = jsonFetch({
    [TOKEN_URL_PAT]: { access_token: "TOK" },
    [USERS_URL_PAT]: { data: { openid: [] }, next_openid: "" },
  });
  const r = await pushDailyReport({ ...CFG, fetchImpl }, payload(), "https://x");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /无关注者/);
});
