---
description: Save your Feishu app credentials and verify them against Feishu before launching the channel.
argument-hint: "[app_id] [app_secret]"
---

You are running the Feishu channel's setup command. Your job: collect the
user's Feishu app credentials, hand them to the factory script that writes and
verifies them, and report the result with the exact next step.

The user must already have created a Feishu self-built app — Bot capability
enabled, the channel's events subscribed, and a release published — and have
its **App ID** and **App Secret** in hand. Those steps happen in the Feishu
Open Platform console and are covered in the plugin README's "Configure your
Feishu app" section. If the user has no credentials yet, point them there and
stop — there is nothing to save until they do.

## Step 1 — collect the credentials

`$ARGUMENTS` may already carry them, in order: `<app_id> <app_secret>` (and an
optional third value, a base URL — see Step 2).

- If `$ARGUMENTS` holds both an App ID and an App Secret, use them.
- If either is missing, ask the user for it. Use `AskUserQuestion` when it is
  available; otherwise ask in normal chat. The App ID looks like `cli_`
  followed by a hex string; the App Secret is an opaque token. Both are
  free-text values the user pastes from the app's credentials page.

Do not echo the App Secret back into the conversation after you have it.

## Step 2 — run the factory script

Run the script with the two values quoted:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/configure.ts" "<app_id>" "<app_secret>"
```

It writes `~/.claude/channels/feishu/.env` (owner-only) and then verifies the
credentials against Feishu. For an international **Lark** app, pass the Lark
base URL as a third argument: `"https://open.larksuite.com"`.

Read the exit code:

| Exit | Meaning | What to tell the user |
|---|---|---|
| `0` | Written and verified — Feishu accepted the credentials. | Configuration is done; give the launch command in Step 3. |
| `1` | Written, but Feishu **rejected** the credentials. | Show the script's reason. Have them re-check the App ID and App Secret, confirm the app's release is published, then run this command again. |
| `2` | Written, but **could not be verified** (Feishu was unreachable). | The `.env` is saved. They may proceed, but the credentials were not confirmed — a network issue, not necessarily wrong credentials. |

## Step 3 — report

Keep it short. State what happened — written and verified, rejected, or
unverified — without printing the App Secret. On a written outcome (exit `0`
or `2`), give the exact launch command:

```
claude --dangerously-load-development-channels plugin:feishu-channel@claudemux
```

Note that channels need Claude Code v2.1.80 or later, and that the channel
loads only when the plugin is named on the `claude` command line — listing it
in `.mcp.json` is not enough. After the channel is running, a first-time
direct-message sender must be approved with the `access` skill.

Re-running this command at any time overwrites the credentials with new ones.
