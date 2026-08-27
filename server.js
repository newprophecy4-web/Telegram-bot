require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "";

const GMAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.send";

if (!BOT_TOKEN)
  throw new Error("Missing TELEGRAM_BOT_TOKEN");

if (!CLIENT_ID)
  throw new Error("Missing GOOGLE_CLIENT_ID");

if (!CLIENT_SECRET)
  throw new Error("Missing GOOGLE_CLIENT_SECRET");

if (!REDIRECT_URI)
  throw new Error("Missing GOOGLE_REDIRECT_URI");

app.use(express.json({ limit: "1mb" }));

// ============================================================
// GOOGLE OAUTH
// ============================================================

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: REFRESH_TOKEN
  });
}

const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client
});

// ============================================================
// TELEGRAM
// ============================================================

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, body = {}) {
  const r = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await r.json();

  if (!data.ok) {
    throw new Error(
      data.description || "Telegram API error"
    );
  }

  return data;
}

async function sendTelegram(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text
  });
}

// ============================================================
// HELPERS
// ============================================================

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(email)
  );
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeEmail({
  from,
  to,
  subject,
  text
}) {
  const cleanHeader = value =>
    String(value)
      .replace(/\r/g, "")
      .replace(/\n/g, "");

  const mime = [
    `From: ${cleanHeader(from)}`,
    `To: ${cleanHeader(to)}`,
    `Subject: ${cleanHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text
  ].join("\r\n");

  return base64Url(mime);
}

function maskToken(token) {
  if (!token) return "NOT CONFIGURED";

  if (token.length <= 12)
    return "••••••••";

  return (
    token.slice(0, 6) +
    "••••••••••••••••" +
    token.slice(-6)
  );
}

function errorDetails(error) {
  return {
    code: error?.code || null,
    message: error?.message || "Unknown error",
    api:
      error?.response?.data ||
      null
  };
}

// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Telegram Gmail Bot</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter,
    system-ui,
    Arial,
    sans-serif;

  background:
    linear-gradient(
      135deg,
      #0f172a,
      #111827,
      #020617
    );

  color: white;
  min-height: 100vh;
  padding: 30px;
}

.container {
  max-width: 900px;
  margin: auto;
}

.card {
  background:
    rgba(255,255,255,.07);

  border:
    1px solid rgba(255,255,255,.12);

  backdrop-filter:
    blur(18px);

  border-radius: 24px;

  padding: 28px;

  margin-bottom: 20px;

  box-shadow:
    0 20px 70px
    rgba(0,0,0,.35);
}

h1 {
  margin-top: 0;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  padding: 8px 14px;

  border-radius: 999px;

  background:
    rgba(34,197,94,.15);

  color:
    #86efac;
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;

  gap: 20px;

  padding: 15px 0;

  border-bottom:
    1px solid rgba(255,255,255,.08);
}

.row:last-child {
  border-bottom: 0;
}

.label {
  color: #94a3b8;
}

.value {
  font-family: monospace;
  word-break: break-all;
}

button,
a.button {
  border: 0;

  padding: 12px 18px;

  border-radius: 12px;

  cursor: pointer;

  color: white;

  background:
    #2563eb;

  text-decoration: none;

  display: inline-block;
}

button:hover,
a.button:hover {
  opacity: .9;
}

.danger {
  background: #dc2626;
}

.warning {
  color: #fbbf24;
}

.success {
  color: #86efac;
}

.small {
  font-size: 13px;
  color: #94a3b8;
  line-height: 1.6;
}

code {
  background: rgba(0,0,0,.35);
  padding: 3px 6px;
  border-radius: 6px;
}

</style>
</head>

<body>

<div class="container">

<div class="card">

<h1>🚀 Telegram Gmail Bot</h1>

<div class="status">
● Server Online
</div>

<p class="small">
Telegram → Gmail API
</p>

</div>

<div class="card">

<h2>🔐 Google OAuth</h2>

<div class="row">

<div class="label">
Refresh Token
</div>

<div class="value">
${maskToken(REFRESH_TOKEN)}
</div>

</div>

<div class="row">

<div class="label">
OAuth Scope
</div>

<div class="value">
gmail.send
</div>

</div>

<div class="row">

<div class="label">
OAuth Status
</div>

<div class="value success">
${
  REFRESH_TOKEN
    ? "CONNECTED"
    : "NOT CONNECTED"
}
</div>

</div>

<br>

<a
class="button"
href="/auth/google">
🔑 Connect / Re-authorize Gmail
</a>

</div>

<div class="card">

<h2>📧 Gmail</h2>

<p class="small">
This server uses the Gmail API send endpoint.
The Gmail profile endpoint is intentionally not used,
so the previous profile-scope 403 is avoided.
</p>

<button onclick="checkStatus()">
Check Gmail Status
</button>

<pre id="result"></pre>

</div>

<div class="card">

<h2>🤖 Telegram</h2>

<p class="small">
Send:
</p>

<code>
/send recipient@example.com Hello
</code>

</div>

<div class="card">

<h2>⚠️ Security</h2>

<p class="warning">
Never expose GOOGLE_REFRESH_TOKEN publicly.
Anyone with the token may be able to access
the authorized Gmail API capabilities.
</p>

<p class="small">
The dashboard only shows a masked token.
The actual secret is never printed in Render logs.
</p>

</div>

</div>

<script>

async function checkStatus() {

  const box =
    document.getElementById("result");

  box.textContent =
    "Checking...";

  try {

    const response =
      await fetch("/status");

    const data =
      await response.json();

    box.textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch (e) {

    box.textContent =
      "Status check failed.";

  }

}

</script>

</body>
</html>
  `);
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Telegram Gmail Bot",
    uptime: process.uptime()
  });
});

// ============================================================
// STATUS
// ============================================================

app.get("/status", async (req, res) => {

  const result = {
    server: true,
    telegram: false,
    gmail: false,
    refresh_token: !!REFRESH_TOKEN,
    scope: "gmail.send"
  };

  try {

    const bot =
      await telegram("getMe");

    result.telegram =
      !!bot.result;

    result.bot =
      bot.result?.username || null;

  } catch (error) {

    result.telegram_error =
      error.message;

  }

  /*
   * Do NOT call gmail.users.getProfile().
   *
   * It caused:
   * 403 Insufficient Permission
   *
   * We only verify OAuth by obtaining
   * an access token.
   */

  if (REFRESH_TOKEN) {

    try {

      const token =
        await oauth2Client.getAccessToken();

      result.gmail =
        !!token.token;

    } catch (error) {

      result.gmail_error =
        errorDetails(error);

    }

  }

  res.json(result);
});

// ============================================================
// GOOGLE AUTH
// ============================================================

app.get(
  "/auth/google",
  (req, res) => {

    const state =
      crypto
        .randomBytes(32)
        .toString("hex");

    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type: "offline",

        prompt: "consent",

        scope: [
          GMAIL_SCOPE
        ],

        state
      });

    res.redirect(authUrl);
  }
);

// ============================================================
// OAUTH CALLBACK — MODIFIED TO SHOW TOKEN + COPY BUTTON
// ============================================================

app.get(
  "/oauth2/callback",
  async (req, res) => {

    try {

      if (!req.query.code) {

        return res
          .status(400)
          .send(
            "❌ Missing OAuth authorization code."
          );

      }

      const {
        tokens
      } =
        await oauth2Client.getToken(
          req.query.code
        );

      if (!tokens.refresh_token) {

        return res.send(`
          <h2>⚠️ No refresh token returned</h2>
          <p>
          Google did not return a new refresh token.
          </p>
          <p>
          Revoke the app permission and authorize again.
          </p>
        `);

      }

      // Log that we got a token (but don't log the token itself)
      console.log(
        "✅ Google OAuth completed."
      );

      console.log(
        "🔐 New refresh token received: YES"
      );

      // Extract the refresh token for display
      const newRefreshToken = tokens.refresh_token;

      // Build HTML response that shows the token and includes a copy button
      res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gmail Connected</title>
<style>
  body {
    margin: 0;
    padding: 30px;
    background: #020617;
    color: white;
    font-family: system-ui, sans-serif;
  }
  .box {
    max-width: 650px;
    margin: 50px auto;
    padding: 30px;
    border-radius: 22px;
    background: #111827;
  }
  .success { color: #86efac; }
  .warning { color: #fbbf24; }
  .token-box {
    background: #020617;
    padding: 18px;
    border-radius: 12px;
    word-break: break-all;
    font-family: monospace;
    font-size: 14px;
    margin: 15px 0;
    border: 1px solid #334155;
    position: relative;
  }
  .copy-btn {
    background: #2563eb;
    border: none;
    color: white;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
  }
  .copy-btn:hover {
    opacity: 0.9;
  }
  .copy-btn:active {
    transform: scale(0.97);
  }
  .note {
    color: #94a3b8;
    font-size: 14px;
    margin-top: 10px;
  }
  .danger {
    color: #f87171;
  }
</style>
</head>
<body>
<div class="box">
  <h1 class="success">✅ Gmail OAuth Successful</h1>
  <p>Google authorization completed successfully.</p>
  <p>A new refresh token was received.</p>

  <h3>🔑 Your Refresh Token</h3>
  <div class="token-box" id="tokenDisplay">${newRefreshToken}</div>
  <button class="copy-btn" onclick="copyToken()">📋 Copy Token</button>

  <h3>Next Step</h3>
  <p>Set this token in your Render environment variable:</p>
  <code style="display:block;background:#020617;padding:12px;border-radius:8px;margin:10px 0;">
    GOOGLE_REFRESH_TOKEN
  </code>
  <p class="note">
    After updating the environment variable, redeploy your service.
  </p>
  <p class="danger">
    ⚠️ Keep this token secret. Anyone with it can send email from your account.
  </p>
  <p><a href="/" style="color:#60a5fa;">← Back to Dashboard</a></p>
</div>

<script>
  function copyToken() {
    const token = document.getElementById('tokenDisplay').textContent;
    navigator.clipboard.writeText(token).then(() => {
      const btn = document.querySelector('.copy-btn');
      const original = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }).catch(() => {
      // fallback
      const range = document.createRange();
      range.selectNode(document.getElementById('tokenDisplay'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      const btn = document.querySelector('.copy-btn');
      const original = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = original; }, 2000);
    });
  }
</script>
</div>
</body>
</html>
      `);

    } catch (error) {

      console.error(
        "OAuth error:",
        error.message
      );

      res
        .status(500)
        .send(`
          <h2>❌ OAuth failed</h2>
          <p>
          ${String(
            error.message
          )}
          </p>
        `);

    }

  }
);

// ============================================================
// SEND EMAIL API
// ============================================================

app.post(
  "/send-email",
  async (req, res) => {

    try {

      const {
        to,
        subject,
        text
      } = req.body;

      if (!validEmail(to)) {

        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid recipient email"
          });

      }

      if (!text) {

        return res
          .status(400)
          .json({
            success: false,
            error:
              "Message is required"
          });

      }

      if (!REFRESH_TOKEN) {

        return res
          .status(500)
          .json({
            success: false,
            error:
              "Gmail OAuth is not configured"
          });

      }

      const token =
        await oauth2Client.getAccessToken();

      if (!token.token) {

        throw new Error(
          "Unable to obtain Gmail access token"
        );

      }

      const raw =
        makeEmail({
          from: "me",
          to,
          subject:
            subject ||
            "Message from Telegram",
          text
        });

      const response =
        await gmail.users.messages.send({
          userId: "me",

          requestBody: {
            raw
          }
        });

      res.json({
        success: true,
        message:
          "Email sent successfully",
        id:
          response.data.id,
        threadId:
          response.data.threadId,
        to
      });

    } catch (error) {

      const details =
        errorDetails(error);

      console.error(
        "========== GMAIL SEND ERROR =========="
      );

      console.error(
        "Code:",
        details.code
      );

      console.error(
        "Message:",
        details.message
      );

      if (details.api) {
        console.error(
          "API:",
          JSON.stringify(
            details.api
          )
        );
      }

      console.error(
        "======================================"
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            details.message,
          code:
            details.code
        });

    }

  }
);

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post(
  "/telegram/webhook",
  async (req, res) => {

    res.sendStatus(200);

    try {

      if (WEBHOOK_SECRET) {

        const received =
          req.headers[
            "x-telegram-bot-api-secret-token"
          ];

        if (
          received !==
          WEBHOOK_SECRET
        ) {
          console.warn(
            "⚠️ Invalid Telegram webhook secret"
          );

          return;
        }

      }

      const message =
        req.body?.message;

      if (!message)
        return;

      const chatId =
        message.chat.id;

      const text =
        String(
          message.text || ""
        ).trim();

      if (
        ADMIN_CHAT_ID &&
        String(chatId) !==
        String(ADMIN_CHAT_ID)
      ) {

        await sendTelegram(
          chatId,
          "❌ You are not authorized to use this bot."
        );

        return;
      }

      // --------------------------------------------------------
      // START
      // --------------------------------------------------------

      if (
        text === "/start"
      ) {

        await sendTelegram(
          chatId,

          "🤖 Gmail Telegram Bot\n\n" +

          "/send email@example.com message\n\n" +

          "/status\n" +

          "/help"
        );

        return;
      }

      // --------------------------------------------------------
      // STATUS
      // --------------------------------------------------------

      if (
        text === "/status"
      ) {

        if (!REFRESH_TOKEN) {

          await sendTelegram(
            chatId,
            "❌ Gmail OAuth is not configured."
          );

          return;
        }

        try {

          const token =
            await oauth2Client
              .getAccessToken();

          await sendTelegram(
            chatId,

            token.token
              ? "✅ Gmail OAuth is connected."
              : "❌ Gmail OAuth failed."
          );

        } catch (error) {

          await sendTelegram(
            chatId,

            "❌ Gmail OAuth error:\n\n" +
            error.message
          );

        }

        return;
      }

      // --------------------------------------------------------
      // SEND
      // --------------------------------------------------------

      if (
        text === "/send" ||
        text.startsWith("/send ")
      ) {

        const args =
          text
            .substring(5)
            .trim();

        const space =
          args.indexOf(" ");

        if (space === -1) {

          await sendTelegram(
            chatId,

            "❌ Format:\n\n" +

            "/send email@example.com Hello"
          );

          return;
        }

        const to =
          args
            .substring(
              0,
              space
            )
            .trim();

        const body =
          args
            .substring(
              space + 1
            )
            .trim();

        if (!validEmail(to)) {

          await sendTelegram(
            chatId,
            "❌ Invalid email address."
          );

          return;
        }

        if (!body) {

          await sendTelegram(
            chatId,
            "❌ Message is empty."
          );

          return;
        }

        await sendTelegram(
          chatId,
          "⏳ Sending..."
        );

        try {

          const token =
            await oauth2Client
              .getAccessToken();

          if (!token.token) {
            throw new Error(
              "Could not obtain Gmail access token"
            );
          }

          const raw =
            makeEmail({
              from: "me",
              to,
              subject:
                "Message from Telegram",
              text: body
            });

          const response =
            await gmail.users.messages.send({
              userId: "me",

              requestBody: {
                raw
              }
            });

          await sendTelegram(
            chatId,

            "✅ Email sent successfully!\n\n" +

            `📧 To: ${to}\n` +

            `🆔 ${response.data.id}`
          );

        } catch (error) {

          const details =
            errorDetails(error);

          console.error(
            "========== TELEGRAM → GMAIL =========="
          );

          console.error(
            JSON.stringify(
              details,
              null,
              2
            )
          );

          console.error(
            "======================================"
          );

          await sendTelegram(
            chatId,

            "❌ Gmail failed.\n\n" +

            `Code: ${
              details.code ||
              "UNKNOWN"
            }\n\n` +

            details.message
          );

        }

        return;
      }

      // --------------------------------------------------------
      // UNKNOWN
      // --------------------------------------------------------

      await sendTelegram(
        chatId,
        "❓ Unknown command.\nUse /help"
      );

    } catch (error) {

      console.error(
        "Telegram webhook error:",
        error.message
      );

    }

  }
);

// ============================================================
// SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        "=========================================="
      );

      console.log(
        "🚀 Telegram Gmail Bot"
      );

      console.log(
        "=========================================="
      );

      console.log(
        `🌐 Port: ${PORT}`
      );

      console.log(
        "📧 Gmail API:",
        REFRESH_TOKEN
          ? "READY"
          : "NOT CONFIGURED"
      );

      console.log(
        "🤖 Telegram: READY"
      );

      console.log(
        "🔐 OAuth: /auth/google"
      );

      console.log(
        "=========================================="
      );

    }
  );

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown(signal) {

  console.log(
    `${signal} received.`
  );

  server.close(() => {

    console.log(
      "Server closed."
    );

    process.exit(0);

  });

}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
