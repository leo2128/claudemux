---
name: configure
description: Configure the Feishu channel plugin so a Claude Code session can receive Feishu messages and document comments. Use when the user wants to set up, install, or connect the Feishu channel, supply Feishu app credentials (app_id / app_secret), wire up the Feishu self-built app, or asks why the channel will not start. Also use for the Chinese phrasings — "配置飞书 / 接入飞书 / 飞书 channel 配置 / 飞书 app_id / 飞书机器人配置".
---

# Configure the Feishu channel

This skill walks an operator through connecting the `feishu-channel` plugin
to a Feishu (Lark) self-built app. The end state: a `.env` file holding the
app credentials and a Claude Code session launched with the channel loaded.

## What you do vs. what the human does

You (the agent) can create the credentials directory, write and protect the
`.env` file, verify it parses, and report the exact launch command. The human
must do everything inside Feishu's web console — creating the app, toggling
capabilities, publishing a release — because those need a Feishu login and
admin rights you do not have.

## Step 1 — the human creates the Feishu self-built app

Ask the human to do this on the Feishu Open Platform (open.feishu.cn;
open.larksuite.com for Lark):

1. Create a **self-built app** (企业自建应用).
2. Enable the **Bot** capability (添加机器人能力).
3. Under **Event & Callback**, set the subscription mode to **long
   connection** (长连接). The channel connects outbound over a WebSocket, so
   no request URL is configured.
4. Subscribe to the events the channel handles:
   - `im.message.receive_v1` — inbound chat messages.
   - `drive.notice.comment_add_v1` — new document comments and replies.
     **Confirm this event appears in the console's event picker.** Its
     identifier is corroborated by third-party integrations but not by
     Feishu's own published event list. If the console does not offer it,
     the channel still runs for chat messages — only document-comment
     delivery is unavailable.
5. Grant the permission scopes the bot needs: read incoming messages, send
   messages as the bot, add message reactions, and — for document comments —
   read document comments and document metadata. The console lists each
   scope by name.
6. **Publish a release** of the app so the bot and its scopes take effect.
7. From the app's credentials page, copy the **App ID** and **App Secret**.

Wait for the human to give you the App ID and App Secret before continuing.

## Step 2 — write the credentials file

The channel server reads credentials from `$HOME/.claude/channels/feishu/.env`.
Create the directory with owner-only permissions, because the file holds a
secret:

```bash
mkdir -p "$HOME/.claude/channels/feishu"
chmod 700 "$HOME/.claude/channels/feishu"
```

Write `$HOME/.claude/channels/feishu/.env` with exactly these two keys:

```
FEISHU_APP_ID=<the App ID>
FEISHU_APP_SECRET=<the App Secret>
```

Then `chmod 600` the file. Do not echo the secret back into the conversation
after writing it.

`FEISHU_APP_ID` / `FEISHU_APP_SECRET` already set in the process environment
are used as a fallback, but the `.env` file is the supported path.

## Step 3 — launch Claude Code with the channel

The channel loads only when the plugin is named on the `claude` command line;
listing it in `.mcp.json` is not enough on its own. A plugin from a
third-party marketplace also needs the development-channels flag. Tell the
human to run:

```
claude --dangerously-load-development-channels plugin:feishu-channel@claudemux
```

This flag does not override an organization `channelsEnabled` policy — if
channels are disabled org-wide, the channel will not load regardless.

## Verify

The server refuses to start unless both credentials are present. If it exits
with a "Feishu credentials missing" error, re-check that `.env` has both keys
and no stray quotes. Once the channel is connected, a Feishu message to the
bot reaches the session as a `<channel source="feishu">` block.

After the channel is running, hand access decisions to the `access` skill —
under the default policy a first-time direct-message sender must be paired
before their messages are delivered.
