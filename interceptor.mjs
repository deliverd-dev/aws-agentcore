// A REQUEST interceptor for Amazon Bedrock AgentCore Gateway: every MCP
// `tools/call` that reaches the gateway is checked with a Deliverd gate before
// the gateway sends it to the target. No change to any agent, because the
// gateway runs this, not the agent.
//
// - The tool is not governed (see DELIVERD_MODE): passed on untouched.
// - Your policy, or a person, says yes: passed on, with the signed decision
//   token in `params._meta["dev.deliverd/decision-token"]`, so a target that
//   checks it can refuse arguments nobody agreed to.
// - It needs a person: answered by the gateway as a tool error the model
//   reads, with the approval link. The same call made again once a person
//   approved goes through, because it names the same gate.
// - Refused, or Deliverd cannot be reached: answered as a tool error. Fails
//   closed, unless DELIVERD_LOG_ONLY is "true", which records the decision and
//   lets every call through, like AgentCore Policy's log-only mode.
//
// Node.js 22 on Lambda, no dependencies beyond the AWS SDK the runtime ships.
// The shapes follow the AgentCore Gateway interceptor documentation
// (interceptorInputVersion / interceptorOutputVersion "1.0").

import { createHash } from "node:crypto";

export const HOSTED = "https://deliverd.dev";
export const ACTION_ID = "agentcore.tool_call";
export const TOKEN_META = "dev.deliverd/decision-token";
const TIMEOUT_MS = 8_000;

export const WRITE_VERBS = new Set([
  "create", "update", "delete", "remove", "send", "merge", "publish", "deploy", "refund", "charge", "transfer", "execute", "apply",
  "write", "put", "patch", "cancel", "approve", "close", "archive", "move", "rename", "upload", "invite", "grant", "revoke", "pay",
  "set", "add", "edit", "modify", "submit", "post", "reply", "terminate", "destroy", "drop", "run", "trigger", "start", "stop", "restart",
]);

/** A tool name as AgentCore gives it, `target___tool`, says it writes when the tool's first word is a write verb. */
export function isWriteTool(name) {
  const own = String(name).split("__").pop().replace(/^_+/, "");
  const first = own.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/[_\-.\s]+/)[0].toLowerCase();
  return WRITE_VERBS.has(first);
}

/** DELIVERD_MODE: "writes" (default), "all", or a regular expression over the tool name. */
export function governs(env, tool) {
  const mode = env.DELIVERD_MODE || "writes";
  if (mode === "all") return true;
  if (mode === "writes") return isWriteTool(tool);
  try {
    return new RegExp(mode, "i").test(tool);
  } catch {
    return true;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The schema the action is registered with (register.mjs): exactly what `gateBody` sends. */
export const INPUT_SCHEMA = {
  type: "object",
  required: ["gateway", "tool", "arguments"],
  additionalProperties: false,
  properties: {
    gateway: { type: "string", minLength: 1, maxLength: 120 },
    tool: { type: "string", minLength: 1, maxLength: 200 },
    arguments: { type: "string", maxLength: 4000 },
  },
};

/** The caller, from the gateway's inbound token when headers are passed: its `sub`, never verified here (the gateway's authorizer did that). */
export function callerOf(headers = {}) {
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const jwt = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
  const [, payload] = jwt.split(".");
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.sub === "string" ? claims.sub.slice(0, 200) : null;
  } catch {
    return null;
  }
}

const header = (headers = {}, name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;

export function gateBody(env, call, session, attempt = 0) {
  const args = canonicalJson(call.arguments);
  const digest = createHash("sha256").update(`${call.tool}\n${args}`).digest("hex").slice(0, 32);
  const gateway = (env.DELIVERD_GATEWAY_NAME || "agentcore").slice(0, 120);
  const sessionPart = String(session ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "none";
  return {
    actionId: env.DELIVERD_ACTION_ID || ACTION_ID,
    externalId: `agentcore:${gateway.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}:${sessionPart}:${digest}${attempt ? `:${attempt}` : ""}`,
    input: { gateway, tool: call.tool.slice(0, 200), arguments: args.slice(0, 4000) },
    description: `An agent wants to call ${call.tool} through the AgentCore gateway ${gateway}: ${args.slice(0, 300)}`,
    ...(env.DELIVERD_ENVIRONMENT ? { environment: env.DELIVERD_ENVIRONMENT.slice(0, 60) } : {}),
    metadata: { source: "agentcore-interceptor", ...(call.caller ? { caller: call.caller } : {}), ...(session ? { sessionId: String(session).slice(0, 100) } : {}) },
  };
}

export function verdict(gate, tool) {
  if (gate.canExecute === true) return { allow: true };
  if (gate.status === "used") return { allow: false, retry: true };
  const why = {
    pending: `needs a person's approval, and Deliverd has asked for it${gate.approvalUrl ? ` at ${gate.approvalUrl}` : ""}. Stop here and tell the user. Once it is approved, make exactly the same call again`,
    denied: `is refused by your organisation's policy${gate.reason ? `: ${gate.reason}` : ""}`,
    rejected: "was rejected by the person who decided",
    changes_requested: "was sent back by the person who decided. Change it, then try again",
    expired: "was not decided in time. Try again to ask again",
    cancelled: "was withdrawn",
    revoked: "had its permission taken back",
  }[gate.status] ?? `was not allowed (${gate.status})`;
  return { allow: false, retry: false, reason: `Deliverd: the call to ${tool} ${why}. Do not look for another way to do the same thing.` };
}

/** Pass the request on, optionally rewritten. */
export const passOn = (body) => ({ interceptorOutputVersion: "1.0", mcp: { transformedGatewayRequest: { body } } });

/** Answer here instead of calling the target: a tool error the model reads. */
export const refuse = (id, reason) => ({
  interceptorOutputVersion: "1.0",
  mcp: { transformedGatewayResponse: { statusCode: 200, body: { jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text: reason }], isError: true } } } },
});

export async function api(env, method, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${(env.DELIVERD_API_URL || HOSTED).replace(/\/$/, "")}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.DELIVERD_API_KEY}`, "Content-Type": "application/json", "User-Agent": "deliverd-agentcore-interceptor/0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
  return json;
}

/** The decision for one interceptor event. `env` carries the key once resolved. */
export async function decide(event, env, fetchImpl = fetch) {
  const request = event?.mcp?.gatewayRequest ?? {};
  const message = request.body;
  if (!message || Array.isArray(message) || message.method !== "tools/call") return passOn(message ?? request.body);
  const tool = String(message.params?.name ?? "");
  const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
  if (!governs(env, tool)) return passOn(message);
  const logOnly = env.DELIVERD_LOG_ONLY === "true";
  const fail = (reason) => (logOnly ? passOn(message) : refuse(message.id, reason));
  if (!env.DELIVERD_API_KEY) return fail(`Deliverd: ${tool} must be checked first, and the interceptor has no Deliverd key.`);
  const call = { tool, arguments: args, caller: callerOf(request.headers) };
  const session = header(request.headers, "mcp-session-id") ?? call.caller;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const gate = await api(env, "POST", "/gates", gateBody(env, call, session, attempt), fetchImpl);
      const v = verdict(gate, tool);
      if (v.retry) continue;
      if (!v.allow) return fail(v.reason);
      // Claim the use before the target acts, so one yes is spent once.
      await api(env, "POST", `/gates/${gate.id}/execution`, { phase: "completed", executedAt: new Date().toISOString(), result: { agent: "agentcore-interceptor", tool, outcome: "forwarded" } }, fetchImpl);
      const params = { ...message.params, _meta: { ...(message.params?._meta ?? {}), ...(gate.decisionToken ? { [TOKEN_META]: gate.decisionToken } : {}) } };
      return passOn({ ...message, params });
    }
    return fail(`Deliverd: the call to ${tool} has been made too many times in this session.`);
  } catch (error) {
    return fail(`Deliverd: could not check ${tool}, so it does not go ahead (${error.message}).`);
  }
}

let cachedKey = null;

/** The key from DELIVERD_API_KEY, or from Secrets Manager when DELIVERD_API_KEY_SECRET_ARN is set. Read once per container. */
async function resolveKey(env) {
  if (env.DELIVERD_API_KEY) return env.DELIVERD_API_KEY;
  if (!env.DELIVERD_API_KEY_SECRET_ARN) return null;
  if (cachedKey) return cachedKey;
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env.DELIVERD_API_KEY_SECRET_ARN }));
  cachedKey = (out.SecretString ?? "").trim() || null;
  return cachedKey;
}

export async function handler(event) {
  let key = null;
  try {
    key = await resolveKey(process.env);
  } catch (error) {
    console.error("deliverd: could not read the key", error.message);
  }
  const out = await decide(event, { ...process.env, DELIVERD_API_KEY: key ?? "" });
  if (out.mcp.transformedGatewayResponse) console.log(JSON.stringify({ deliverd: "refused", tool: event?.mcp?.gatewayRequest?.body?.params?.name }));
  return out;
}
