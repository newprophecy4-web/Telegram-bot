require("dotenv").config();

const express = require("express");
const { Resend } = require("resend");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// FROM_EMAIL optional
const FROM_EMAIL =
  process.env.FROM_EMAIL || "onboarding@resend.dev";

// ===============================
// Environment Check
// ===============================

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is missing");
  process.exit(1);
}

if (!RESEND_API_KEY) {
  console.error("❌ RESEND_API_KEY is missing");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

// ===============================
// Telegram API Helper
// ===============================

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

  return await response.json();
}

// ===============================
// Send Telegram Message
// ===============================

async function sendTelegramMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text
  });
}

// ===============================
// Email Validation
// ===============================

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ===============================
// Send Email
// ===============================

async function sendEmail({
  to,
  subject,
  text
}) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject,
    text
  });
}

// ===============================
// Home
// ===============================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Telegram Email Bot",
    email_provider: "Resend"
  });
});

// ===============================
// Health
// ===============================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "telegram-email-bot"
  });
});

// ===============================
// Email API
// ===============================

app.post("/send-email", async (req, res) => {
  try {
    const {
      to,
      subject,
      text
    } = req.body;

    if (!to || !isValidEmail(to)) {
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

    if (text.length > 10000) {
      return res.status(400).json({
        success: false,
        error: "Message is too long"
      });
    }

    const result = await sendEmail({
      to,
      subject:
        subject || "Message from Telegram",
      text
    });

    if (result.error) {
      console.error(
        "Resend error:",
        result.error.message || "Unknown error"
      );

      return res.status(500).json({
        success: false,
        error: "Email sending failed"
      });
    }

    return res.json({
      success: true,
      message: "Email sent successfully",
      id: result.data?.id || null
    });

  } catch (error) {
    console.error(
      "Email API error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

// ===============================
// Telegram Webhook
// ===============================

app.post(
  "/telegram/webhook",
  async (req, res) => {

    // Respond immediately to Telegram
    res.sendStatus(200);

    try {

      const update = req.body;

      if (!update?.message) {
        return;
      }

      const message = update.message;

      const chatId =
        message.chat.id;

      const text =
        message.text || "";

      // ==========================
      // /start
      // ==========================

      if (text === "/start") {

        await sendTelegramMessage(
          chatId,
          "🤖 Telegram Email Bot\n\n" +
          "📧 Send an email using:\n\n" +
          "/send email@example.com Hello\n\n" +
          "Commands:\n" +
          "/start\n" +
          "/help"
        );

        return;
      }

      // ==========================
      // /help
      // ==========================

      if (text === "/help") {

        await sendTelegramMessage(
          chatId,
          "📖 Help\n\n" +
          "📧 Send Email:\n" +
          "/send email@example.com Your message\n\n" +
          "Example:\n" +
          "/send test@example.com Hello from Telegram"
        );

        return;
      }

      // ==========================
      // /send
      // ==========================

      if (
        text === "/send" ||
        text.startsWith("/send ")
      ) {

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
            "❌ Message is missing.\n\n" +
            "Use:\n" +
            "/send email@example.com Hello"
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

        // Validate email

        if (!isValidEmail(email)) {

          await sendTelegramMessage(
            chatId,
            "❌ Invalid email address."
          );

          return;
        }

        // Validate message

        if (!emailMessage) {

          await sendTelegramMessage(
            chatId,
            "❌ Message cannot be empty."
          );

          return;
        }

        // Message limit

        if (emailMessage.length > 10000) {

          await sendTelegramMessage(
            chatId,
            "❌ Message is too long."
          );

          return;
        }

        // Sending message

        await sendTelegramMessage(
          chatId,
          "⏳ Sending email..."
        );

        try {

          const result =
            await sendEmail({
              to: email,
              subject:
                "Message from Telegram",
              text: emailMessage
            });

          if (result.error) {

            console.error(
              "Resend error:",
              result.error.message ||
              "Unknown error"
            );

            await sendTelegramMessage(
              chatId,
              "❌ Email sending failed."
            );

            return;
          }

          await sendTelegramMessage(
            chatId,
            "✅ Email sent successfully!\n\n" +
            `📧 To: ${email}`
          );

        } catch (error) {

          console.error(
            "Email error:",
            error.message
          );

          await sendTelegramMessage(
            chatId,
            "❌ Failed to send email."
          );
        }

        return;
      }

      // ==========================
      // Unknown command
      // ==========================

      await sendTelegramMessage(
        chatId,
        "❓ Unknown command.\n\n" +
        "Use /help"
      );

    } catch (error) {

      console.error(
        "Webhook error:",
        error.message
      );
    }
  }
);

// ===============================
// 404
// ===============================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
});

// ===============================
// Start Server
// ===============================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Telegram Email Bot running on port ${PORT}`
    );

    console.log(
      `📧 From: ${FROM_EMAIL}`
    );
  }
);
