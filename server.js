require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");

const app = express();

app.use(express.json({ limit: "1mb" }));

// =====================================================
// CONFIG
// =====================================================

const PORT = process.env.PORT || 10000;

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

// =====================================================
// ENVIRONMENT CHECK
// =====================================================

if (!BOT_TOKEN) {
  console.error(
    "❌ TELEGRAM_BOT_TOKEN is missing"
  );
  process.exit(1);
}

if (!GOOGLE_CLIENT_ID) {
  console.error(
    "❌ GOOGLE_CLIENT_ID is missing"
  );
  process.exit(1);
}

if (!GOOGLE_CLIENT_SECRET) {
  console.error(
    "❌ GOOGLE_CLIENT_SECRET is missing"
  );
  process.exit(1);
}

if (!GOOGLE_REDIRECT_URI) {
  console.error(
    "❌ GOOGLE_REDIRECT_URI is missing"
  );
  process.exit(1);
}

// =====================================================
// GOOGLE OAUTH CLIENT
// =====================================================

const oauth2Client =
  new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

// Existing refresh token
if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token:
      GOOGLE_REFRESH_TOKEN
  });
}

// =====================================================
// GMAIL API
// =====================================================

const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client
});

// =====================================================
// TELEGRAM API
// =====================================================

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(
  method,
  data = {}
) {
  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  return response.json();
}

// =====================================================
// SEND TELEGRAM MESSAGE
// =====================================================

async function sendTelegramMessage(
  chatId,
  text
) {
  return telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text
    }
  );
}

// =====================================================
// EMAIL VALIDATION
// =====================================================

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    .test(email);
}

// =====================================================
// BASE64 URL ENCODE
// =====================================================

function base64UrlEncode(text) {
  return Buffer
    .from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// =====================================================
// CREATE RAW GMAIL EMAIL
// =====================================================

function createRawEmail({
  from,
  to,
  subject,
  text
}) {

  const safeSubject =
    String(subject)
      .replace(/\r/g, "")
      .replace(/\n/g, "");

  const safeTo =
    String(to)
      .replace(/\r/g, "")
      .replace(/\n/g, "");

  const safeFrom =
    String(from)
      .replace(/\r/g, "")
      .replace(/\n/g, "");

  const message = [
    `From: ${safeFrom}`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text
  ].join("\r\n");

  return base64UrlEncode(
    message
  );
}

// =====================================================
// SEND EMAIL THROUGH GMAIL
// =====================================================

async function sendGmail({
  to,
  subject,
  text
}) {

  // Get Gmail account
  const profile =
    await gmail.users.getProfile({
      userId: "me"
    });

  const sender =
    profile.data.emailAddress;

  const raw =
    createRawEmail({
      from: sender,
      to,
      subject,
      text
    });

  const result =
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw
      }
    });

  return {
    id: result.data.id,
    threadId:
      result.data.threadId,
    sender
  };
}

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {

  res.json({
    status: "ok",
    service:
      "Telegram Gmail Email Bot",
    email_provider:
      "Gmail API",
    oauth:
      GOOGLE_REFRESH_TOKEN
        ? "connected"
        : "not_connected"
  });
});

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      status: "ok",
      service:
        "telegram-gmail-email-bot"
    });
  }
);

// =====================================================
// GOOGLE AUTH START
// =====================================================

app.get(
  "/auth/google",
  (req, res) => {

    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type: "offline",

        // Forces Google to return
        // a refresh token during
        // the initial authorization.
        prompt: "consent",

        scope: [
          "https://www.googleapis.com/auth/gmail.send"
        ]
      });

    res.redirect(authUrl);
  }
);

// =====================================================
// GOOGLE OAUTH CALLBACK
// =====================================================

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
            <h2>❌ Authorization failed</h2>
            <p>Missing authorization code.</p>
          `);
      }

      const {
        tokens
      } =
        await oauth2Client.getToken(
          code
        );

      // IMPORTANT:
      // Don't print token in Render logs.
      // Show it only in this browser page.

      if (!tokens.refresh_token) {

        return res
          .status(400)
          .send(`
            <h2>❌ No refresh token received</h2>

            <p>
              Google did not return a refresh token.
            </p>

            <p>
              Revoke this app from your Google
              account and authorize again.
            </p>
          `);
      }

      const token =
        tokens.refresh_token;

      res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>Gmail Connected</title>

  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 25px;
      background: #f5f5f5;
    }

    .box {
      max-width: 700px;
      margin: auto;
      background: white;
      padding: 25px;
      border-radius: 12px;
    }

    textarea {
      width: 100%;
      height: 140px;
      box-sizing: border-box;
      padding: 12px;
      font-family: monospace;
    }

    button {
      margin-top: 10px;
      padding: 12px 20px;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
    }

    .warning {
      color: #b00020;
      font-weight: bold;
    }
  </style>
</head>

<body>

<div class="box">

  <h2>✅ Gmail Connected</h2>

  <p>
    Google OAuth authorization was successful.
  </p>

  <p>
    Copy the refresh token below.
  </p>

  <textarea
    id="token"
    readonly
  >${token}</textarea>

  <br>

  <button
    onclick="copyToken()"
  >
    📋 Copy Token
  </button>

  <p>
    Render → Environment
  </p>

  <p>
    Variable name:
  </p>

  <pre>GOOGLE_REFRESH_TOKEN</pre>

  <p class="warning">
    ⚠️ Do NOT share this token.
    Do NOT put it on GitHub.
  </p>

</div>

<script>
function copyToken() {
  const token =
    document.getElementById("token");

  token.select();

  navigator.clipboard.writeText(
    token.value
  );

  alert("Token copied!");
}
</script>

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
          <h2>❌ Google OAuth failed</h2>
          <p>
            ${escapeHtml(
              error.message
            )}
          </p>
        `);
    }
  }
);

// =====================================================
// HTML ESCAPE
// =====================================================

function escapeHtml(value) {

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// =====================================================
// MANUAL EMAIL API
// =====================================================

app.post(
  "/send-email",
  async (req, res) => {

    try {

      if (!GOOGLE_REFRESH_TOKEN) {

        return res
          .status(503)
          .json({
            success: false,
            error:
              "Gmail is not connected"
          });
      }

      const {
        to,
        subject,
        text
      } = req.body;

      if (
        !to ||
        !isValidEmail(to)
      ) {

        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid email address"
          });
      }

      if (
        !text ||
        typeof text !== "string"
      ) {

        return res
          .status(400)
          .json({
            success: false,
            error:
              "Message is required"
          });
      }

      if (text.length > 10000) {

        return res
          .status(400)
          .json({
            success: false,
            error:
              "Message is too long"
          });
      }

      const result =
        await sendGmail({
          to,
          subject:
            subject ||
            "Message from Telegram",
          text
        });

      res.json({
        success: true,
        message:
          "Email sent successfully",
        id: result.id,
        from: result.sender,
        to
      });

    } catch (error) {

      console.error(
        "Gmail API error:",
        error.message
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            "Failed to send email"
        });
    }
  }
);

// =====================================================
// TELEGRAM WEBHOOK
// =====================================================

app.post(
  "/telegram/webhook",
  async (req, res) => {

    // Telegram requires a quick response.
    res.sendStatus(200);

    try {

      const update =
        req.body;

      if (
        !update ||
        !update.message
      ) {
        return;
      }

      const message =
        update.message;

      const chatId =
        message.chat.id;

      const text =
        message.text || "";

      // =================================================
      // /start
      // =================================================

      if (text === "/start") {

        await sendTelegramMessage(
          chatId,

          "🤖 Telegram Gmail Bot\n\n" +

          "📧 Send an email:\n\n" +

          "/send email@example.com Hello\n\n" +

          "Commands:\n" +
          "/start\n" +
          "/help"
        );

        return;
      }

      // =================================================
      // /help
      // =================================================

      if (text === "/help") {

        await sendTelegramMessage(
          chatId,

          "📖 Telegram Gmail Bot\n\n" +

          "📧 Send email:\n" +
          "/send email@example.com Your message\n\n" +

          "Example:\n" +
          "/send test@gmail.com Hello from Telegram"
        );

        return;
      }

      // =================================================
      // /send
      // =================================================

      if (
        text === "/send" ||
        text.startsWith("/send ")
      ) {

        if (!GOOGLE_REFRESH_TOKEN) {

          await sendTelegramMessage(
            chatId,

            "❌ Gmail is not connected.\n\n" +
            "Connect Gmail using:\n" +
            "/auth"
          );

          return;
        }

        const command =
          text.trim();

        const firstSpace =
          command.indexOf(" ");

        if (firstSpace === -1) {

          await sendTelegramMessage(
            chatId,

            "❌ Invalid format.\n\n" +

            "Use:\n" +

            "/send email@example.com Your message"
          );

          return;
        }

        const remaining =
          command
            .substring(
              firstSpace + 1
            )
            .trim();

        const secondSpace =
          remaining.indexOf(" ");

        if (secondSpace === -1) {

          await sendTelegramMessage(
            chatId,

            "❌ Message is missing.\n\n" +

            "Use:\n" +

            "/send email@example.com Hello"
          );

          return;
        }

        const email =
          remaining
            .substring(
              0,
              secondSpace
            )
            .trim();

        const emailMessage =
          remaining
            .substring(
              secondSpace + 1
            )
            .trim();

        if (
          !isValidEmail(email)
        ) {

          await sendTelegramMessage(
            chatId,

            "❌ Invalid email address."
          );

          return;
        }

        if (!emailMessage) {

          await sendTelegramMessage(
            chatId,

            "❌ Message cannot be empty."
          );

          return;
        }

        if (
          emailMessage.length >
          10000
        ) {

          await sendTelegramMessage(
            chatId,

            "❌ Message is too long."
          );

          return;
        }

        await sendTelegramMessage(
          chatId,
          "⏳ Sending email through Gmail..."
        );

        try {

          const result =
            await sendGmail({
              to: email,

              subject:
                "Message from Telegram",

              text:
                emailMessage
            });

          await sendTelegramMessage(
            chatId,

            "✅ Email sent successfully!\n\n" +

            `📧 To: ${email}\n` +

            `📤 From: ${result.sender}`
          );

        } catch (error) {

          console.error(
            "Send Gmail error:",
            error.message
          );

          await sendTelegramMessage(
            chatId,

            "❌ Gmail failed to send the email."
          );
        }

        return;
      }

      // =================================================
      // UNKNOWN COMMAND
      // =================================================

      await sendTelegramMessage(
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

// =====================================================
// 404
// =====================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        success: false,
        error:
          "Endpoint not found"
      });
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Gmail Telegram Bot running on port ${PORT}`
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🔐 OAuth: /auth/google`
    );

    console.log(
      `📧 Gmail API ready`
    );

    console.log(
      GOOGLE_REFRESH_TOKEN
        ? "✅ Gmail OAuth token configured"
        : "⚠️ Gmail OAuth token not configured"
    );
  }
);
