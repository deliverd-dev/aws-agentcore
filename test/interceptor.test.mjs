// node --test. No dependencies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, gateBody, governs, isWriteTool, callerOf, refuse, passOn } from "../interceptor.mjs";
import { actionBody } from "../register.mjs";

const env = (extra = {}) => ({ DELIVERD_API_KEY: "dlv_agent", DELIVERD_GATEWAY_NAME: "payments", ...extra });
const event = (name, args = {}, headers = { "Mcp-Session-Id": "s1" }) => ({
  interceptorInputVersion: "1.0",
  mcp: { gatewayRequest: { path: "/mcp", httpMethod: "POST", headers, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } } } },
});

function fakeDeliverd(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, body, auth: init.headers.Authorization });
    const path = new URL(url).pathname;
    const answer = path.endsWith("/execution") ? { receipt: {} } : answers.shift();
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { calls, fetchImpl };
}

test("names: target___tool writes when the tool's first word is a write verb", () => {
  assert.equal(isWriteTool("payments___createRefund"), true);
  assert.equal(isWriteTool("payments___listRefunds"), false);
  assert.equal(isWriteTool("crm___delete_contact"), true);
  assert.equal(governs({ DELIVERD_MODE: "all" }, "x___list"), true);
  assert.equal(governs({ DELIVERD_MODE: "^payments___" }, "payments___list"), true);
  assert.equal(governs({ DELIVERD_MODE: "(" }, "x"), true, "a broken pattern governs everything");
});

test("tools/list and reads pass on untouched, with no call to Deliverd", async () => {
  const { calls, fetchImpl } = fakeDeliverd([]);
  const list = { mcp: { gatewayRequest: { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } } } };
  assert.deepEqual(await decide(list, env(), fetchImpl), passOn(list.mcp.gatewayRequest.body));
  const read = await decide(event("payments___listRefunds"), env(), fetchImpl);
  assert.ok(read.mcp.transformedGatewayRequest);
  assert.equal(calls.length, 0);
});

test("a write that needs a person is answered here, with the link", async () => {
  const { fetchImpl } = fakeDeliverd([{ id: "g1", canExecute: false, status: "pending", approvalUrl: "https://deliverd.dev/approvals/1" }]);
  const out = await decide(event("payments___createRefund", { amount: 40 }), env(), fetchImpl);
  assert.equal(out.mcp.transformedGatewayRequest, undefined);
  const body = out.mcp.transformedGatewayResponse.body;
  assert.equal(body.id, 3);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /approvals\/1/);
});

test("an allowed write goes on with its decision token, and its use is recorded", async () => {
  const { calls, fetchImpl } = fakeDeliverd([{ id: "g2", canExecute: true, status: "approved", decisionToken: "dlv_dt1.x" }]);
  const out = await decide(event("payments___createRefund", { amount: 40 }), env(), fetchImpl);
  assert.equal(out.mcp.transformedGatewayRequest.body.params._meta["dev.deliverd/decision-token"], "dlv_dt1.x");
  assert.equal(calls[0].body.actionId, "agentcore.tool_call");
  assert.equal(calls[0].auth, "Bearer dlv_agent");
  assert.match(calls[1].url, /\/gates\/g2\/execution$/);
});

test("the same call names the same gate, so a retry after approval re-reads it", () => {
  const a = gateBody(env(), { tool: "t", arguments: { b: 1, a: 2 } }, "s1");
  const b = gateBody(env(), { tool: "t", arguments: { a: 2, b: 1 } }, "s1");
  assert.equal(a.externalId, b.externalId);
  assert.notEqual(gateBody(env(), { tool: "t", arguments: {} }, "s1", 1).externalId, a.externalId);
});

test("a used permission asks again", async () => {
  const { calls, fetchImpl } = fakeDeliverd([{ id: "g3", status: "used" }, { id: "g4", canExecute: true, status: "allowed" }]);
  const out = await decide(event("payments___createRefund"), env(), fetchImpl);
  assert.ok(out.mcp.transformedGatewayRequest);
  assert.match(calls[1].body.externalId, /:1$/);
});

test("fails closed when Deliverd cannot be reached, unless log-only", async () => {
  const down = () => fakeDeliverd([new Error("timeout")]).fetchImpl;
  const closed = await decide(event("payments___createRefund"), env(), down());
  assert.equal(closed.mcp.transformedGatewayResponse.body.result.isError, true);
  const open = await decide(event("payments___createRefund"), env({ DELIVERD_LOG_ONLY: "true" }), down());
  assert.ok(open.mcp.transformedGatewayRequest);
  const noKey = await decide(event("payments___createRefund"), env({ DELIVERD_API_KEY: "" }), down());
  assert.ok(noKey.mcp.transformedGatewayResponse);
});

test("the caller is read from the gateway's token when headers are passed", () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ sub: "user-42" })).toString("base64url")}.y`;
  assert.equal(callerOf({ Authorization: `Bearer ${jwt}` }), "user-42");
  assert.equal(callerOf({}), null);
});

test("output shapes are version 1.0", () => {
  assert.equal(refuse(1, "no").interceptorOutputVersion, "1.0");
  assert.equal(actionBody().inputSchema.required.length, 3);
});
