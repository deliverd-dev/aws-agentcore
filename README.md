# Deliverd for Amazon Bedrock AgentCore Gateway

A REQUEST interceptor that checks every MCP tool call your AgentCore gateway
governs with your organisation's policy on [Deliverd](https://deliverd.dev)
before the target sees it. AgentCore Policy (Cedar) says whether a call is
allowed; Deliverd adds the person who must say yes, and the record that they
did.

No agent changes. The gateway runs the interceptor on each request, so every
agent behind the gateway is covered, whatever framework it is built on.

What happens to a `tools/call`:

- **Not governed** (a read, by default): passed on untouched, with no call to
  Deliverd.
- **Your policy, or a person, says yes**: passed on, with the signed decision
  token in `params._meta["dev.deliverd/decision-token"]`. A target of your own
  can verify it with `deliverd.decisionTokens.verify` in `@deliverd/sdk` and
  refuse arguments nobody agreed to.
- **A person must decide**: the gateway answers with a tool error the model
  reads, carrying the approval link. Once the person approves, the same call
  made again goes through.
- **Refused, or Deliverd cannot be reached**: answered as a tool error. It
  fails closed, unless you deploy it in log-only mode.

## Setup

1. In Deliverd, create two API tokens under **Settings → API tokens**:
   - an agent key for the interceptor, with `gates:write` and `gates:execute`;
   - one for yourself, as an owner or administrator, with `actions:write`.
2. Register the action the interceptor checks against, with your own token:

   ```bash
   DELIVERD_API_KEY=dlv_… node register.mjs
   ```

   Then, under **Admin → Publishing & request rules**, say what
   `agentcore.tool_call` needs. Until a rule says otherwise, a person decides.
3. Deploy the stack, then put the interceptor's code in it:

   ```bash
   aws cloudformation deploy --stack-name deliverd-interceptor --template-file template.yaml \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides DeliverdApiKey=dlv_… GatewayName=payments GatewayRoleName=<your gateway's service role>
   cp interceptor.mjs index.mjs && zip function.zip index.mjs
   aws lambda update-function-code --function-name deliverd-agentcore-interceptor-deliverd-interceptor --zip-file fileb://function.zip
   ```

4. Attach it to your gateway, with the stack's `InterceptorConfiguration` output:

   ```bash
   aws cloudformation describe-stacks --stack-name deliverd-interceptor \
     --query "Stacks[0].Outputs[?OutputKey=='InterceptorConfiguration'].OutputValue" --output text > interceptors.json
   aws bedrock-agentcore-control update-gateway --gateway-identifier <gateway-id> \
     --interceptor-configurations file://interceptors.json   # plus the gateway's other required parameters
   ```

   `passRequestHeaders` is on so the interceptor can read the MCP session id
   and the caller's `sub` for the record. The gateway's own authorizer has
   already verified that token; the interceptor never trusts it for access.

## Settings

| Variable | Meaning |
|---|---|
| `DELIVERD_API_KEY_SECRET_ARN` | The Secrets Manager secret holding the agent key (set by the template). `DELIVERD_API_KEY` works too. |
| `DELIVERD_MODE` | `writes` (default: tools whose name starts with a verb such as create, update, delete, send, refund), `all`, or a regular expression over `target___tool` names. |
| `DELIVERD_LOG_ONLY` | `true` records each decision and lets every call through, to try a policy before you enforce it, as AgentCore Policy's log-only mode does. |
| `DELIVERD_GATEWAY_NAME` | How the gateway is named on approvals. |
| `DELIVERD_ENVIRONMENT` | Optional, for rules that tell staging from production. |
| `DELIVERD_ACTION_ID` | Optional, to use an action other than `agentcore.tool_call`. |

## Status

Built against the AgentCore Gateway interceptor documentation (input and
output version 1.0) and tested against a scripted gateway and a fake Deliverd
(`npm test`). It has not yet run on a real AWS account. A short-circuited
answer is sent as HTTP 200 with an MCP tool error, so the model reads why the
call stopped.

MIT licensed.
