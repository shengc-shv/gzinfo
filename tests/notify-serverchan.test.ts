/**
 * lib/notify/serverchan.ts 单元测试 — Server酱推送渠道（2026-09-01 新增）
 * 覆盖：URL 拼接（标准/新版 sctp）/ form body 组装 / code=0 成功 /
 *       非 0 code 失败 / 网络异常不抛 / Markdown 消息体组装 / 空数据兜底
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSendUrl, sendServerChan, buildServerChanDesp, type ExecutiveBrief } from "../lib/notify/serverchan.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

test("buildSendUrl: 标准 SendKey → sctapi.ftqq.com", () => {
  assert.equal(buildSendUrl("SCTabc123"), "https://sctapi.ftqq.com/SCTabc123.send");
});

test("buildSendUrl: Server酱³ sctp SendKey → push.ft07.com（UID 取自 sctp 后数字）", () => {
  assert.equal(buildSendUrl("sctp12345tABCxyz"), "https://12345.push.ft07.com/send/sctp12345tABCxyz.send");
});

test("sendServerChan: code=0 成功，form body 组装正确", async () => {
  let sentUrl = "";
  let sentBody = "";
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    sentUrl = String(input);
    sentBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ code: 0, message: "", data: { id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const r = await sendServerChan({ sendKey: "SCTabc", title: "标题", desp: "内容", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(sentUrl, "https://sctapi.ftqq.com/SCTabc.send");
  assert.ok(sentBody.includes("title=%E6%A0%87%E9%A2%98"));
  assert.ok(sentBody.includes("desp=%E5%86%85%E5%AE%B9"));
});

test("sendServerChan: 非 0 code → ok=false + message，不抛异常", async () => {
  const fetchImpl = (async () => {
    return new Response(JSON.stringify({ code: 40001, message: "sendkey 无效" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const r = await sendServerChan({ sendKey: "SCTbad", title: "t", desp: "d", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.code, 40001);
  assert.match(r.message, /sendkey 无效/);
});

test("sendServerChan: 网络异常 → ok=false 不抛异常", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as typeof fetch;

  const r = await sendServerChan({ sendKey: "SCTabc", title: "t", desp: "d", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.match(r.message, /ECONNRESET/);
});

test("buildServerChanDesp: 全字段 Markdown 组装（定调/必读/商机/风险/IPO/链接）", () => {
  const exec: ExecutiveBrief = {
    hero_line: "政策窗口开启，抢场景抢客户",
    must_read: [
      { title: "七部门力推商品消费扩容升级", why: "锚定60万亿社零目标", url: "https://x/1" },
      { title: "第二条必读", url: "https://x/2" },
    ],
    insights: [
      { topic: "南沙房地产新生态对接", impact: "分行可梳理按揭与开发贷机会" },
      { topic: "无影响字段商机" },
    ],
    risk: { topic: "资管信披新规合规整改", evidence: "代销端须按新规整改" },
    guangdong_ipo: { spoken: "广东尚睿科技北交所问询阶段" },
  };
  const desp = buildServerChanDesp(exec, "https://gz/2026-09-01/2026-09-01.html");

  assert.ok(desp.includes("## 📢 今日定调"));
  assert.ok(desp.includes("政策窗口开启，抢场景抢客户"));
  assert.ok(desp.includes("## 📚 必读（2）"));
  assert.ok(desp.includes("[七部门力推商品消费扩容升级](https://x/1)"));
  assert.ok(desp.includes("锚定60万亿社零目标"));
  assert.ok(desp.includes("## 💡 商机（2）"));
  assert.ok(desp.includes("**南沙房地产新生态对接**"));
  assert.ok(desp.includes("分行可梳理按揭与开发贷机会"));
  assert.ok(desp.includes("## ⚠️ 风险"));
  assert.ok(desp.includes("**资管信披新规合规整改**"));
  assert.ok(desp.includes("代销端须按新规整改"));
  assert.ok(desp.includes("## 📈 广东IPO"));
  assert.ok(desp.includes("广东尚睿科技北交所问询阶段"));
  assert.ok(desp.includes("[📄 查看完整日报 →](https://gz/2026-09-01/2026-09-01.html)"));
});

test("buildServerChanDesp: 空 executive 兜底（仅保留链接）", () => {
  const desp = buildServerChanDesp({}, "https://gz/2026-09-01/2026-09-01.html");
  assert.equal(desp, "[📄 查看完整日报 →](https://gz/2026-09-01/2026-09-01.html)");
  assert.ok(!desp.includes("## "));
});
