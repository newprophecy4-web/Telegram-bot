require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "1mb",
  })
);

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET;

const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI;

const GOOGLE_REFRESH_TOKEN =
  process.env.GOOGLE_REFRESH_TOKEN || "";

const ADMIN_CHAT_ID =
  process.env.ADMIN_CHAT_ID || "";

const WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "";

const APP_NAME =
  process.env.APP_NAME ||
  "Telegram Gmail Bot";

// Gmail send scope
const GMAIL_SEND_SCOPE =
  "https://www.googleapis.com/auth/gmail.send";

// ============================================================
// STARTUP VALIDATION
// ============================================================

const required = [
  ["TELEGRAM_BOT_TOKEN", BOT_TOKEN],
  ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
  ["GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET],
  ["GOOGLE_REDIRECT_URI", GOOGLE_REDIRECT_URI],
];

for (const [name, value] of required) {
  if (!value) {
    console.error(`❌ Missing environment variable: ${name}`);
    process.exit(1);
  }
}

console.log("==========================================");
console.log(`🚀 ${APP_NAME}`);
console.log("==========================================");
console.log(`🌐 Port: ${PORT}`);
console.log(`🔐 OAuth: /auth/google`);
console.log(
  `📧 Gmail token: ${
    GOOGLE_REFRESH_TOKEN ? "CONFIGURED" : "NOT CONFIGURED"
  }`
);
console.log(
  `👤 Admin: ${
    ADMIN_CHAT_ID ? "CONFIGURED" : "NOT CONFIGURED"
  }`
);
console.log("==========================================");

// ============================================================
// GOOGLE OAUTH
// ============================================================

const oauth2Client =
  new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });
}

// ============================================================
// GMAIL
// ============================================================

const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client,
});

// ============================================================
// TELEGRAM
// ============================================================

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, body = {}) {
  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    const error = new Error(
      data.description ||
        "Telegram API request failed"
    );

    error.telegram = data;

    throw error;
  }

  return data;
}

async function sendTelegram(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
  });
}

// ============================================================
// AUTHORIZATION
// ============================================================

function isAuthorized(chatId) {
  if (!ADMIN_CHAT_ID) {
    return true;
  }

  return String(chatId) ===
    String(ADMIN_CHAT_ID);
}

// ============================================================
// EMAIL VALIDATION
// ============================================================

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(email)
  );
}

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// BASE64URL
// ============================================================

function base64UrlEncode(value) {
  return Buffer.from(
    value,
    "utf8"
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// ============================================================
// MIME EMAIL
// ============================================================

function createRawEmail({
  from,
  to,
  subject,
  text,
}) {
  const clean = (value) =>
    String(value)
      .replace(/\r/g, "")
      .replace(/\n/g, "");

  const message = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    `Subject: ${clean(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(text),
  ].join("\r\n");

  return base64UrlEncode(message);
}

// ============================================================
// GET GMAIL PROFILE
// ============================================================

async function getGmailProfile() {
  try {
    const response =
      await gmail.users.getProfile({
        userId: "me",
      });

    return response.data;
  } catch (error) {
    throw createGmailError(
      "Gmail profile request failed",
      error
    );
  }
}

// ============================================================
// GMAIL ERROR NORMALIZATION
// ============================================================

function createGmailError(prefix, error) {
  const normalized =
    new Error(
      `${prefix}: ${
        error?.message ||
        "Unknown Gmail error"
      }`
    );

  normalized.code =
    error?.code;

  normalized.responseData =
    error?.response?.data;

  normalized.original =
    error;

  return normalized;
}

// ============================================================
// SEND GMAIL
// ============================================================

async function sendGmail({
  to,
  subject,
  text,
}) {
  if (!GOOGLE_REFRESH_TOKEN) {
    const error =
      new Error(
        "GOOGLE_REFRESH_TOKEN is not configured"
      );

    error.code =
      "NO_REFRESH_TOKEN";

    throw error;
  }

  if (!isValidEmail(to)) {
    const error =
      new Error(
        "Invalid recipient email"
      );

    error.code =
      "INVALID_EMAIL";

    throw error;
  }

  // Check Gmail account
  const profile =
    await getGmailProfile();

  const sender =
    profile.emailAddress;

  const raw =
    createRawEmail({
      from: sender,
      to,
      subject:
        subject ||
        "Message from Telegram",
      text,
    });

  try {
    const response =
      await gmail.users.messages.send({
        userId: "me",

        requestBody: {
          raw,
        },
      });

    return {
      id:
        response.data.id,

      threadId:
        response.data.threadId,

      sender,
      to,
    };
  } catch (error) {
    throw createGmailError(
      "Gmail send request failed",
      error
    );
  }
}

// ============================================================
// GMAIL DIAGNOSTICS
// ============================================================

function formatGmailError(error) {
  const code =
    error?.code || "unknown";

  const message =
    error?.message ||
    "Unknown error";

  const apiData =
    error?.responseData;

  let output =
    `Code: ${code}\n` +
    `Message: ${message}`;

  if (apiData) {
    try {
      output +=
        `\nAPI: ${JSON.stringify(
          apiData
        )}`;
    } catch {}
  }

  return output;
}

// ============================================================
// RATE LIMIT
// ============================================================

const rateMap = new Map();

function rateLimit(chatId) {
  const now = Date.now();

  const previous =
    rateMap.get(
      String(chatId)
    );

  if (
    previous &&
    now - previous < 5000
  ) {
    return false;
  }

  rateMap.set(
    String(chatId),
    now
  );

  return true;
}

// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: APP_NAME,
    provider: "Gmail API",
    oauth:
      GOOGLE_REFRESH_TOKEN
        ? "connected"
        : "not_connected",
    telegram:
      BOT_TOKEN
        ? "configured"
        : "not_configured",
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime:
      Math.round(
        process.uptime()
      ),
  });
});

// ============================================================
// STATUS
// ============================================================

app.get("/status", async (req, res) => {
  const result = {
    server: "ok",
    gmail: false,
    telegram: false,
  };

  // Gmail
  if (GOOGLE_REFRESH_TOKEN) {
    try {
      await getGmailProfile();

      result.gmail = true;
    } catch (error) {
      result.gmail = false;

      result.gmail_error =
        error.message;
    }
  }

  // Telegram
  try {
    const bot =
      await telegram(
        "getMe"
      );

    result.telegram =
      !!bot.ok;

    if (bot.result) {
      result.bot_username =
        bot.result.username;
    }
  } catch (error) {
    result.telegram = false;

    result.telegram_error =
      error.message;
  }

  res.json(result);
});

// ============================================================
// GOOGLE AUTH
// ============================================================

app.get(
  "/auth/google",
  (req, res) => {
    try {
      const state =
        crypto.randomBytes(32)
          .toString("hex");

      // For a production multi-user
      // application, persist and validate state.
      // This simple deployment uses
      // a one-time authorization flow.

      const url =
        oauth2Client.generateAuthUrl({
          access_type: "offline",

          prompt: "consent",

          scope: [
            GMAIL_SEND_SCOPE,
          ],

          state,
        });

      res.redirect(url);
    } catch (error) {
      console.error(
        "OAuth start error:",
        error.message
      );

      res
        .status(500)
        .send(
          "Failed to start Google OAuth."
        );
    }
  }
);

// ============================================================
// OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth2/callback",
  async (req, res) => {
    try {
      const code =
        req.query.code;

      if (!code) {
        return res
          .status(400)
          .send(`
            <h2>❌ OAuth Failed</h2>
            <p>Missing authorization code.</p>
          `);
      }

      const {
        tokens,
      } =
        await oauth2Client.getToken(
          code
        );

      if (!tokens.refresh_token) {
        return res
          .status(400)
          .send(`
            <h2>⚠️ No Refresh Token</h2>

            <p>
              Google did not return a refresh token.
            </p>

            <p>
              Revoke the existing application
              permission and authorize again.
            </p>
          `);
      }

      /*
       * SECURITY:
       *
       * Do NOT print the refresh token.
       * Do NOT put it in Render logs.
       * Do NOT put it on GitHub.
       *
       * The recommended approach is to securely
       * store it as GOOGLE_REFRESH_TOKEN.
       */

      res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>Gmail Connected</title>

<style>
body {
  font-family: Arial, sans-serif;
  background: #f5f5f5;
  padding: 30px;
}

.box {
  max-width: 600px;
  margin: auto;
  background: white;
  padding: 30px;
  border-radius: 14px;
}

.success {
  color: green;
}

.warning {
  color: #b00020;
}
</style>

</head>

<body>

<div class="box">

<h2 class="success">
✅ Gmail OAuth Successful
</h2>

<p>
Google authorization completed successfully.
</p>

<p>
The Gmail connection was authorized.
</p>

<p>
Now make sure your Render environment contains:
</p>

<pre>GOOGLE_REFRESH_TOKEN</pre>

<p class="warning">
⚠️ For security, this page does not display
the refresh token.
</p>

</div>

</body>
</html>
      `);
    } catch (error) {
      console.error(
        "OAuth callback error:",
        error.message
      );

      res
        .status(500)
        .send(`
          <h2>❌ Google OAuth Failed</h2>
          <p>
            ${escapeHtml(
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
        text,
      } = req.body;

      if (!to) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Recipient is required",
          });
      }

      if (!isValidEmail(to)) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid recipient email",
          });
      }

      if (!text) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Message is required",
          });
      }

      const result =
        await sendGmail({
          to,
          subject:
            subject ||
            "Message from Telegram",
          text,
        });

      res.json({
        success: true,
        message:
          "Email sent successfully",
        message_id:
          result.id,
        thread_id:
          result.threadId,
        from:
          result.sender,
        to:
          result.to,
      });
    } catch (error) {
      console.error(
        "========== GMAIL API ERROR =========="
      );

      console.error(
        formatGmailError(
          error
        )
      );

      console.error(
        "======================================"
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message,
          code:
            error.code ||
            "UNKNOWN",
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

    // Telegram gets immediate response.
    res.sendStatus(200);

    try {
      // Optional secret header validation
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

      const update =
        req.body;

      const message =
        update?.message;

      if (!message) {
        return;
      }

      const chatId =
        message.chat.id;

      const text =
        String(
          message.text || ""
        ).trim();

      // Authorization
      if (
        !isAuthorized(
          chatId
        )
      ) {
        await sendTelegram(
          chatId,
          "❌ You are not authorized to use this bot."
        );

        return;
      }

      // Rate limit
      if (
        !rateLimit(
          chatId
        )
      ) {
        await sendTelegram(
          chatId,
          "⏳ Please wait a few seconds before sending another request."
        );

        return;
      }

      // ========================================================
      // START
      // ========================================================

      if (
        text === "/start"
      ) {
        await sendTelegram(
          chatId,

          "🤖 Gmail Telegram Bot\n\n" +

          "Commands:\n\n" +

          "/start\n" +
          "/help\n" +
          "/status\n\n" +

          "Send email:\n" +

          "/send email@example.com Hello from Telegram"
        );

        return;
      }

      // ========================================================
      // HELP
      // ========================================================

      if (
        text === "/help"
      ) {
        await sendTelegram(
          chatId,

          "📖 Help\n\n" +

          "Send an email:\n\n" +

          "/send email@example.com Your message\n\n" +

          "Example:\n" +

          "/send test@gmail.com Hello!"
        );

        return;
      }

      // ========================================================
      // STATUS
      // ========================================================

      if (
        text === "/status"
      ) {
        try {
          const profile =
            await getGmailProfile();

          await sendTelegram(
            chatId,

            "✅ Gmail connected\n\n" +

            `📧 Account: ${profile.emailAddress}`
          );
        } catch (error) {
          await sendTelegram(
            chatId,

            "❌ Gmail connection failed.\n\n" +
            error.message
          );
        }

        return;
      }

      // ========================================================
      // SEND
      // ========================================================

      if (
        text === "/send" ||
        text.startsWith("/send ")
      ) {
        const args =
          text
            .substring(
              5
            )
            .trim();

        const space =
          args.indexOf(" ");

        if (space === -1) {
          await sendTelegram(
            chatId,

            "❌ Invalid format.\n\n" +

            "Use:\n" +

            "/send email@example.com Your message"
          );

          return;
        }

        const email =
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

        if (
          !isValidEmail(
            email
          )
        ) {
          await sendTelegram(
            chatId,
            "❌ Invalid email address."
          );

          return;
        }

        if (!body) {
          await sendTelegram(
            chatId,
            "❌ Message cannot be empty."
          );

          return;
        }

        if (
          body.length > 10000
        ) {
          await sendTelegram(
            chatId,
            "❌ Message is too long."
          );

          return;
        }

        await sendTelegram(
          chatId,
          "⏳ Sending email..."
        );

        try {
          const result =
            await sendGmail({
              to: email,

              subject:
                "Message from Telegram",

              text:
                body,
            });

          await sendTelegram(
            chatId,

            "✅ Email sent successfully!\n\n" +

            `📧 To: ${result.to}\n` +

            `📤 From: ${result.sender}\n\n` +

            `🆔 ${result.id}`
          );
        } catch (error) {

          console.error(
            "========== TELEGRAM → GMAIL ERROR =========="
          );

          console.error(
            formatGmailError(
              error
            )
          );

          console.error(
            "============================================="
          );

          await sendTelegram(
            chatId,

            "❌ Gmail failed to send the email.\n\n" +

            `Code: ${
              error.code ||
              "UNKNOWN"
            }\n\n` +

            `${error.message}`
          );
        }

        return;
      }

      // ========================================================
      // UNKNOWN
      // ========================================================

      await sendTelegram(
        chatId,

        "❓ Unknown command.\n\n" +
        "Use /help"
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
// TELEGRAM WEBHOOK SETUP
// ============================================================

app.post(
  "/telegram/setup-webhook",
  async (req, res) => {
    try {

      const webhookUrl =
        `${GOOGLE_REDIRECT_URI
          .replace(
            "/oauth2/callback",
            ""
          )}` +
        `/telegram/webhook`;

      const body = {
        url:
          webhookUrl,
      };

      if (WEBHOOK_SECRET) {
        body.secret_token =
          WEBHOOK_SECRET;
      }

      const result =
        await telegram(
          "setWebhook",
          body
        );

      res.json({
        success: true,
        webhook:
          webhookUrl,
        telegram:
          result,
      });

    } catch (error) {
      res
        .status(500)
        .json({
          success: false,
          error:
            error.message,
        });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        success: false,
        error:
          "Endpoint not found",
      });
  }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled server error:",
      error.message
    );

    res
      .status(500)
      .json({
        success: false,
        error:
          "Internal server error",
      });
  }
);

// ============================================================
// START
// ============================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `🚀 Server running on port ${PORT}`
      );

      console.log(
        `📧 Gmail API: ${
          GOOGLE_REFRESH_TOKEN
            ? "READY"
            : "NOT CONNECTED"
        }`
      );

      console.log(
        `🤖 Telegram: READY`
      );
    }
  );

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(signal) {
  console.log(
    `${signal} received. Shutting down...`
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
