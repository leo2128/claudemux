---
description: Save your Feishu app credentials, choose the group-message policy, and verify the credentials against Feishu before launching the channel.
argument-hint: "[app_id] [app_secret] [group_policy]"
---

You are running the Feishu channel's setup command. Your job: collect the
user's Feishu app credentials and their group-message policy, hand them to the
factory script that writes and verifies them, and report the result with the
exact next step.

The user must already have created a Feishu self-built app — Bot capability
enabled, the channel's events subscribed, and a release published — and have
its **App ID** and **App Secret** in hand. Those steps happen in the Feishu
Open Platform console and are covered in the plugin README's "Configure your
Feishu app" section. If the user has no credentials yet, point them there and
stop — there is nothing to save until they do.

## Step 1 — collect the credentials

`$ARGUMENTS` may already carry the inputs, in order:
`<app_id> <app_secret> <group_policy>` (and an optional fourth value, a base
URL — see Step 3).

- If `$ARGUMENTS` holds both an App ID and an App Secret, use them.
- If either is missing, ask the user for it. Use `AskUserQuestion` when it is
  available; otherwise ask in normal chat. The App ID looks like `cli_`
  followed by a hex string; the App Secret is an opaque token. Both are
  free-text values the user pastes from the app's credentials page.

Do not echo the App Secret back into the conversation after you have it.

## Step 2 — choose the group-message policy

The channel gates group messages by a `groupPolicy` setting with three modes.
If `$ARGUMENTS` already carries a third value, use it; otherwise ask the user
to pick one (use `AskUserQuestion` when available, otherwise ask in chat):

- **`block`** — the bot ignores all group messages; it answers only direct
  messages.
- **`allowlist`** — each group is authorized individually. The first @-mention
  of the bot in a new group posts a one-time pairing code; the operator
  approves it with the `access` skill to bring that group in.
- **`follow-user`** — no group needs authorizing. The bot answers an @-mention
  from anyone already on the allowlist, in any group it is a member of.

`allowlist` is the safe default if the user is unsure — it keeps every group
behind an explicit approval. Pass the chosen value verbatim as the third
script argument.

## Step 3 — run the factory script

Install the channel's dependencies (which include its `tsx` TypeScript
runner), then run the factory script with the three values quoted:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent --no-audit --no-fund && node_modules/.bin/tsx scripts/configure.ts "<app_id>" "<app_secret>" "<group_policy>"
```

It writes `~/.claude/channels/feishu/.env` (owner-only), records the group
policy in `~/.claude/channels/feishu/access.json`, and then verifies the
credentials against Feishu. For an international **Lark** app, pass the Lark
base URL as a fourth argument: `"https://open.larksuite.com"`.

Read the exit code:

| Exit | Meaning | What to tell the user |
|---|---|---|
| `0` | Written and verified — Feishu accepted the credentials. | Configuration is done; give the launch command in Step 4. |
| `1` | A bad input, or Feishu **rejected** the credentials. | Show the script's reason. For a rejected credential, have them re-check the App ID and App Secret, confirm the app's release is published, then run this command again. |
| `2` | Written, but **could not be verified** (Feishu was unreachable). | The `.env` is saved. They may proceed, but the credentials were not confirmed — a network issue, not necessarily wrong credentials. |

## Step 4 — report

Keep it short. State what happened — written and verified, rejected, or
unverified — and which group policy was set, without printing the App Secret.
On a written outcome (exit `0` or `2`), give the exact launch command:

```
claude --dangerously-load-development-channels plugin:feishu-channel@claudemux
```

Note that channels need Claude Code v2.1.80 or later, and that the channel
loads only when the plugin is named on the `claude` command line — listing it
in `.mcp.json` is not enough. After the channel is running, a first-time
direct-message sender must be approved with the `access` skill.

Re-running this command at any time overwrites the credentials and the group
policy with new ones; it leaves the allowlist and any pending pairings intact.
