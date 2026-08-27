require("dotenv").config();

const express = require("express");
const { Resend } = require("resend");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const ADMIN_TELEGRAM_USER_ID = process.env.ADMIN_TELEGRAM_USER_ID;

if (!BOT_TOKEN || !RESEND_API_KEY || !FROM_EMAIL) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, body = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return response.json();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendTelegramMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text
  });
}

async function sendEmail(to, text) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: "Message from Telegram",
    text
  });
}

/* Health */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Telegram Email Bot",
    email_provider: "Resend"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

/* Manual API */
app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, text } = req.body;

    if (!to || !validEmail(to)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email address"
      });
    }

    if (!text || typeof text !== "string") {
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

    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: subject || "Message from Telegram",
      text
    });

    if (result.error) {
      return res.status(500).json({
        success: false,
        error: "Email sending failed"
      });
    }

    res.json({
      success: true,
      message: "Email sent successfully",
      id: result.data?.id || null
    });

  } catch (error) {
    console.error("Email error:", error.message);

    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

/* Telegram Webhook */
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (!update.message) return;

    const message = update.message;
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = message.text || "";

    /* Optional admin restriction */
    if (
      ADMIN_TELEGRAM_USER_ID &&
      String(userId) !== String(ADMIN_TELEGRAM_USER_ID)
    ) {
      await sendTelegramMessage(
        chatId,
        "❌ You are not authorized to use this bot."
      );
      return;
    }

    /* /start */
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "🤖 Telegram Email Bot\n\n" +
        "Send an email using:\n\n" +
        "/send email@example.com Your message here"
      );
      return;
    }

    /* /help */
    if (text === "/help") {
      await sendTelegramMessage(
        chatId,
        "📖 Commands:\n\n" +
        "/start - Start bot\n" +
        "/help - Show help\n\n" +
        "Send email:\n" +
        "/send email@example.com Hello!"
      );
      return;
    }

    /* /send */
    if (text.startsWith("/send")) {
      const parts = text.split(" ");

      if (parts.length < 3) {
        await sendTelegramMessage(
          chatId,
          "❌ Wrong format.\n\n" +
          "Use:\n" +
          "/send email@example.com Your message"
        );
        return;
      }

      const email = parts[1];
      const emailMessage = parts.slice(2).join(" ");

      if (!validEmail(email)) {
        await sendTelegramMessage(
          chatId,
          "❌ Invalid email address."
        );
        return;
      }

      if (!emailMessage.trim()) {
        await sendTelegramMessage(
          chatId,
          "❌ Message cannot be empty."
        );
        return;
      }

      await sendTelegramMessage(
        chatId,
        "⏳ Sending email..."
      );

      try {
        const result = await sendEmail(
          email,
          emailMessage
        );

        if (result.error) {
          await sendTelegramMessage(
            chatId,
            "❌ Email sending failed."
          );
          return;
        }

        await sendTelegramMessage(
          chatId,
          `✅ Email sent successfully!\n\n` +
          `📧 To: ${email}`
        );

      } catch (error) {
        console.error("Resend error:", error.message);

        await sendTelegramMessage(
          chatId,
          "❌ Failed to send email."
        );
      }

      return;
    }

    await sendTelegramMessage(
      chatId,
      "Unknown command.\nUse /help"
    );

  } catch (error) {
    console.error("Telegram webhook error:", error.message);
  }
});

/* Start server */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
