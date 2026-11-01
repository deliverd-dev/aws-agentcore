// Registers the action the interceptor's gates are checked against. Run it
// once, with a key that belongs to an owner or administrator and carries
// actions:write (an agent key is refused on purpose):
//
//   DELIVERD_API_KEY=dlv_… node register.mjs

import { pathToFileURL } from "node:url";
import { ACTION_ID, INPUT_SCHEMA, api } from "./interceptor.mjs";

export function actionBody(actionId = ACTION_ID) {
  return {
    actionId,
    name: "Call a tool through an AgentCore gateway",
    description: "An MCP tool call an agent made through Amazon Bedrock AgentCore Gateway, checked by the Deliverd interceptor before the target sees it.",
    displayTitle: "Call {{tool}} through {{gateway}}",
    defaultRisk: "high",
    inputSchema: INPUT_SCHEMA,
  };
}

async function main() {
  if (!process.env.DELIVERD_API_KEY) throw new Error("Set DELIVERD_API_KEY to an owner's or administrator's key with actions:write.");
  const body = actionBody(process.env.DELIVERD_ACTION_ID || ACTION_ID);
  await api(process.env, "POST", "/actions", body);
  console.log(`Registered ${body.actionId}. Now say what it needs under Admin → Publishing & request rules: allowed, refused, or a person decides.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
