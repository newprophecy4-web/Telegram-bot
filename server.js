require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("❌ GOOGLE_CLIENT_ID missing");
  process.exit(1);
}

if (!CLIENT_SECRET) {
  console.error("❌ GOOGLE_CLIENT_SECRET missing");
  process.exit(1);
}

if (!REDIRECT_URI) {
  console.error("❌ GOOGLE_REDIRECT_URI missing");
  process.exit(1);
}

// ======================================
// Google OAuth
// ======================================

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

// ======================================
// Gmail API
// ======================================

const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client
});

// ======================================
// Telegram API
// ======================================

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, data = {}) {

  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  return response.json();
}

async function sendTelegramMessage(
  chatId,
  text
) {

  return telegram("sendMessage", {
    chat_id: chatId,
    text
  });
}

// ======================================
// Email Validation
// ======================================

function isValidEmail(email) {

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    .test(email);
}

// ======================================
// Base64 URL encoding
// ======================================

function base64UrlEncode(str) {

  return Buffer
    .from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ======================================
// Create Gmail RAW message
// ======================================

function createRawEmail({
  from,
  to,
  subject,
  text
}) {

  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text
  ].join("\r\n");

  return base64UrlEncode(message);
}

// ======================================
// Send Gmail
// ======================================

async function sendGmail({
  to,
  subject,
  text
}) {

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
    sender
  };
}

// ======================================
// Home
// ======================================

app.get("/", (req, res) => {

  res.json({
    status: "ok",
    service: "Telegram Gmail Email Bot",
    email_provider: "Gmail API",
    oauth:
      Boolean(REFRESH_TOKEN)
        ? "connected"
        : "not_connected"
  });
});

// ======================================
// Health
// ======================================

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    service: "telegram-gmail-email-bot"
  });
});

// ======================================
// OAuth Login
// ======================================

app.get("/auth/google", (req, res) => {

  const authUrl =
    oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/gmail.send"
      ]
    });

  res.redirect(authUrl);
});

// ======================================
// OAuth Callback
// ======================================

app.get(
  "/oauth2/callback",
  async (req, res) => {

    try {

      const code = req.query.code;

      if (!code) {

        return res.status(400).send(
          "Missing OAuth authorization code."
        );
      }

      const {
        tokens
      } =
        await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {

        return res.status(400).send(
          "No refresh token received. " +
          "Try authorization again with consent."
        );
      }

      console.log(
        "===================================="
      );

      console.log(
        "GOOGLE_REFRESH_TOKEN:"
      );

      console.log(
        tokens.refresh_token
      );

      console.log(
        "===================================="
      );

      res.send(`
        <html>
          <body style="font-family:Arial;padding:30px">
            <h2>✅ Gmail connected successfully</h2>

            <p>
              Copy the
              <b>GOOGLE_REFRESH_TOKEN</b>
              from the Render logs and add it
              to Render Environment Variables.
            </p>

            <p>
              Then redeploy the service.
            </p>
          </body>
        </html>
      `);

    } catch (error) {

      console.error(
        "OAuth callback error:",
        error.message
      );

      res.status(500).send(
        "Google OAuth failed."
      );
    }
  }
);

// ======================================
// Manual Email API
// ======================================

app.post("/send-email", async (req, res) => {

  try {

    const {
      to,
      subject,
      text
    } = req.body;

    if (!REFRESH_TOKEN) {

      return res.status(503).json({
        success: false,
        error:
          "Gmail is not connected. " +
          "Open /auth/google first."
      });
    }

    if (
      !to ||
      !isValidEmail(to)
    ) {

      return res.status(400).json({
        success: false,
        error: "Invalid email address"
      });
    }

    if (
      !text ||
      typeof text !== "string"
    ) {

      return res.status(400).json({
        success: false,
        error: "Message is required"
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

    res.status(500).json({
      success: false,
      error:
        "Failed to send email"
    });
  }
});

// ======================================
// Telegram Webhook
// ======================================

app.post(
  "/telegram/webhook",
  async (req, res) => {

    // Respond immediately
    res.sendStatus(200);

    try {

      const update = req.body;

      if (!update?.message) {
        return;
      }

      const message =
        update.message;

      const chatId =
        message.chat.id;

      const text =
        message.text || "";

      // ================================
      // START
      // ================================

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

      // ================================
      // HELP
      // ================================

      if (text === "/help") {

        await sendTelegramMessage(
          chatId,
          "📖 Commands\n\n" +
          "📧 Send Email:\n" +
          "/send email@example.com Your message\n\n" +
          "Example:\n" +
          "/send test@example.com Hello from Telegram"
        );

        return;
      }

      // ================================
      // SEND
      // ================================

      if (
        text === "/send" ||
        text.startsWith("/send ")
      ) {

        if (!REFRESH_TOKEN) {

          await sendTelegramMessage(
            chatId,
            "❌ Gmail is not connected yet.\n\n" +
            "Open the Google authorization URL first."
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
            .substring(firstSpace + 1)
            .trim();

        const secondSpace =
          remaining.indexOf(" ");

        if (secondSpace === -1) {

          await sendTelegramMessage(
            chatId,
            "❌ Message is missing."
          );

          return;
        }

        const email =
          remaining
            .substring(0, secondSpace)
            .trim();

        const emailMessage =
          remaining
            .substring(secondSpace + 1)
            .trim();

        if (!isValidEmail(email)) {

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

        if (emailMessage.length > 10000) {

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
              text: emailMessage
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

      // ================================
      // UNKNOWN
      // ================================

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

// ======================================
// 404
// ======================================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
});

// ======================================
// Start
// ======================================

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
  }
);
