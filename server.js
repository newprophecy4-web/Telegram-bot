require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { google } = require("googleapis");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const AI_API_KEY = process.env.GEMINI_API_KEY || process.env.AI_API_KEY || "";
const AI_MODEL = process.env.GEMINI_MODEL || process.env.AI_MODEL || "gemini-2.5-flash";
const TIMEZONE = process.env.TIMEZONE || "Asia/Dhaka";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".zip", ".txt", ".csv", ".jpg", ".jpeg", ".png", ".webp"]);
const ALLOWED_MIMES = new Set(["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "text/plain", "text/csv", "image/jpeg", "image/png", "image/webp", "application/octet-stream"]);

if (!BOT_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  throw new Error("Missing required Telegram or Google OAuth environment variables");
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
app.use(["/send-email", "/admin", "/status"], apiLimiter);

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
if (REFRESH_TOKEN) oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oauth2Client });
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const defaultState = { conversations: {}, history: [], schedules: [], templates: [] };
let store = { ...defaultState };
const rateBuckets = new Map();

async function loadStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { store = { ...defaultState, ...JSON.parse(await fsp.readFile(STATE_FILE, "utf8")) }; }
  catch (error) { if (error.code !== "ENOENT") console.error("Persistent store load failed:", error.message); }
}
let saveQueue = Promise.resolve();
function saveStore() {
  saveQueue = saveQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const temp = `${STATE_FILE}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fsp.rename(temp, STATE_FILE);
  }).catch(error => console.error("Persistent store save failed:", error.message));
  return saveQueue;
}

async function telegram(method, body = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data;
}
function sendTelegram(chatId, text, replyMarkup) {
  return telegram("sendMessage", { chat_id: chatId, text: String(text).slice(0, 4096), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
function answerCallback(id) { return telegram("answerCallbackQuery", { callback_query_id: id }).catch(() => {}); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function cleanHeader(value) { return String(value || "").replace(/[\r\n]/g, " ").trim(); }
function base64Url(value) { return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function sanitizeHtml(html) {
  return String(html || "").replace(/<\/?(script|iframe|object|embed|form|style)[^>]*>/gi, "").replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[^"']*\1/gi, "").replace(/javascript\s*:/gi, "");
}
function makeMime({ to, subject, text, html, attachment }) {
  const headers = [`From: me`, `To: ${cleanHeader(to)}`, `Subject: ${cleanHeader(subject || "Message from Telegram")}`, "MIME-Version: 1.0"];
  if (!attachment) {
    headers.push(html ? "Content-Type: text/html; charset=UTF-8" : "Content-Type: text/plain; charset=UTF-8", "", html || text || "");
    return base64Url(headers.join("\r\n"));
  }
  const boundary = `=_telegram_${crypto.randomBytes(12).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, `Content-Type: ${attachment.mime}; name="${cleanHeader(attachment.name)}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${cleanHeader(attachment.name)}"`, "", attachment.data.toString("base64").replace(/(.{76})/g, "$1\r\n"), `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", text || "", `--${boundary}--`);
  return base64Url(headers.join("\r\n"));
}
function errorDetails(error) { return { code: error?.code || error?.response?.status || null, message: error?.message || "Unknown error", api: error?.response?.data || null }; }
function friendlyGmailError(error) { const code = Number(error?.code || error?.response?.status); if (code === 401) return "Gmail authentication failed."; if (code === 403) return "Gmail permission denied."; if (code === 429) return "Gmail rate limit reached."; if (code >= 500) return "Temporary Gmail failure."; return "Gmail could not send the email."; }
function isAdmin(chatId) { return !!ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID); }
function limited(chatId, kind, max) { const key = `${chatId}:${kind}`; const now = Date.now(); const values = (rateBuckets.get(key) || []).filter(time => now - time < 60000); if (values.length >= max) return true; values.push(now); rateBuckets.set(key, values); return false; }
function kb(rows) { return { inline_keyboard: rows.map(row => row.map(([text, data]) => ({ text, callback_data: data }))) }; }
const backRow = [["↩️ Back", "menu"]];
function mainMenu() { return kb([[ ["📧 Email", "email"], ["🤖 AI Assistant", "ai"] ], [["📎 Files", "files"], ["📋 Templates", "templates"]], [["⏰ Schedule", "schedule"], ["📬 History", "history"]], [["⚙️ Settings", "settings"]]]); }
function emailMenu() { return kb([[ ["✍️ Compose", "compose"], ["🤖 AI Compose", "ai"] ], [["📨 HTML Email", "html"], ["📎 Send Attachment", "attachment"]], backRow]); }
function confirmMenu(prefix = "send") { return kb([[ ["📤 Send", `${prefix}:send`], ["✏️ Edit", `${prefix}:edit`] ], [["❌ Cancel", "cancel"]]]); }
function aiConfirmMenu() { return kb([[ ["📤 Send", "ai:send"], ["✏️ Edit", "ai:edit"], ["🔄 Regenerate", "ai:regenerate"] ], [["❌ Cancel", "cancel"]]]); }
function templateMenu() { return kb([[ ["👋 Welcome", "tpl:welcome"], ["🔐 OTP", "tpl:otp"] ], [["🧾 Invoice", "tpl:invoice"], ["💼 Business", "tpl:business"]], [["📢 Announcement", "tpl:announcement"], ["➕ AI Create", "tpl:create"]], backRow]); }
function formatDraft(draft) { return ["📧 Email Composer", "", "To:", draft.to || "—", "", "Subject:", draft.subject || "—", "", "Message:", draft.text || "—"].join("\\n"); }
function clearConversation(chatId) { delete store.conversations[String(chatId)]; saveStore(); }
function setConversation(chatId, data) { store.conversations[String(chatId)] = { ...(store.conversations[String(chatId)] || {}), ...data }; saveStore(); }
function getConversation(chatId) { return store.conversations[String(chatId)] || { state: "IDLE" }; }

async function callAI(prompt, schemaHint = "") {
  if (!AI_API_KEY) throw new Error("AI_NOT_CONFIGURED");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(AI_MODEL)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": AI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "You are a humanistic, empathetic email assistant. Never send email. Prepare clear, warm, respectful drafts and return only useful content." }] },
      contents: [{ role: "user", parts: [{ text: `${prompt}\n${schemaHint}` }] }],
      generationConfig: { temperature: 0.55, responseMimeType: schemaHint.includes("valid JSON") ? "application/json" : "text/plain" }
    })
  });
  if (!response.ok) throw new Error(`Gemini provider returned ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim() || "";
}
async function generateAIResponse(prompt) { return callAI(prompt); }
async function generateStructuredEmail(prompt) {
  const raw = await callAI(`Parse or compose this request: ${prompt}`, `Return valid JSON only with keys intent, to, subject, body, scheduled, scheduleTime, attachmentRequired. Use empty strings/null when unknown. Do not invent an email address.`);
  try { return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")); } catch { return { intent: "compose", to: "", subject: "", body: raw, scheduled: false, scheduleTime: null, attachmentRequired: false }; }
}

async function sendEmail({ to, subject, text, html, attachment, chatId, retries = 3 }) {
  if (!validEmail(to)) throw new Error("Invalid recipient email");
  if (!REFRESH_TOKEN) throw new Error("Gmail OAuth is not configured");
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const token = await oauth2Client.getAccessToken(); if (!token.token) throw new Error("Unable to obtain Gmail access token");
      const response = await gmail.users.messages.send({ userId: "me", requestBody: { raw: makeMime({ to, subject, text, html, attachment }) } });
      store.history.unshift({ status: "sent", to, subject: subject || "Message from Telegram", chatId: String(chatId || ""), id: response.data.id || null, at: new Date().toISOString() }); store.history = store.history.slice(0, 100); await saveStore();
      return response.data;
    } catch (error) { lastError = error; if (attempt < retries) await new Promise(resolve => setTimeout(resolve, attempt * 1000)); }
  }
  store.history.unshift({ status: "failed", to, subject: subject || "Message from Telegram", chatId: String(chatId || ""), error: friendlyGmailError(lastError), at: new Date().toISOString() }); store.history = store.history.slice(0, 100); await saveStore(); throw lastError;
}
function parseSchedule(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
async function runSchedules() {
  const now = Date.now();
  for (const job of store.schedules.filter(item => item.status === "scheduled" && new Date(item.sendAt).getTime() <= now)) {
    job.status = "processing"; await saveStore();
    try { await sendEmail(job); job.status = "sent"; job.sentAt = new Date().toISOString(); await sendTelegram(job.chatId, `✅ Scheduled email sent to ${job.to}.`); }
    catch (error) { job.status = "failed"; await sendTelegram(job.chatId, `❌ Scheduled email failed. ${friendlyGmailError(error)}`); }
    await saveStore();
  }
}

app.get("/", (req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Gmail AI Bot</title><style>body{font-family:system-ui;background:#07111f;color:#eef;padding:32px;max-width:900px;margin:auto}section{background:#122238;border:1px solid #2b4663;border-radius:16px;padding:24px;margin:16px 0}code,pre{background:#07111f;padding:10px;border-radius:8px;display:block;overflow:auto}.ok{color:#86efac}.warn{color:#fbbf24}a{color:#93c5fd}</style></head><body><section><h1>🤖 Telegram Gmail AI Bot</h1><p class="ok">● Server online</p><p>Telegram menu, Gmail API, AI assistant, attachments, templates, scheduling and history.</p></section><section><h2>Google OAuth</h2><p>Scope: <code>gmail.send</code></p><p>Status: <strong>${REFRESH_TOKEN ? "CONNECTED" : "NOT CONFIGURED"}</strong></p><a href="/auth/google">Connect / Re-authorize Gmail</a></section><section><h2>Safe status</h2><pre>GET /status</pre><p class="warn">Secrets are never displayed or returned.</p></section></body></html>`));
app.get("/health", (req, res) => res.json({ status: "ok", service: "Telegram Gmail AI Bot", uptime: process.uptime() }));
app.get("/status", async (req, res) => { const result = { server: true, telegram: false, gmail: false, ai: !!AI_API_KEY, refresh_token: REFRESH_TOKEN ? "configured" : "not_configured", scope: "gmail.send", bot: null }; try { const bot = await telegram("getMe"); result.telegram = !!bot.result; result.bot = bot.result?.username || null; } catch (error) { console.error("Telegram status error:", error.message); } if (REFRESH_TOKEN) { try { result.gmail = !!(await oauth2Client.getAccessToken()).token; } catch (error) { console.error("Gmail status error:", friendlyGmailError(error)); } } res.json(result); });
app.get("/auth/google", (req, res) => res.redirect(oauth2Client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GMAIL_SCOPE], state: crypto.randomBytes(32).toString("hex") })));
app.get("/oauth2/callback", async (req, res) => { try { if (!req.query.code) return res.status(400).send("Missing OAuth authorization code."); const { tokens } = await oauth2Client.getToken(req.query.code); if (!tokens.refresh_token) return res.status(400).send("No refresh token returned. Revoke the app permission and authorize again."); console.log("Google OAuth completed; refresh token received: YES (value withheld)"); res.send("<h2>Gmail OAuth successful</h2><p>Copy the new refresh token from your Google OAuth flow and save it as GOOGLE_REFRESH_TOKEN in Render. This page intentionally does not display secrets.</p><p><a href='/'>Back to dashboard</a></p>"); } catch (error) { console.error("OAuth error:", friendlyGmailError(error)); res.status(500).send("OAuth failed. Check the server logs for a safe diagnostic message."); } });
app.post("/send-email", async (req, res) => { try { const { to, subject, text, html } = req.body || {}; if (!validEmail(to)) return res.status(400).json({ success: false, error: "Invalid recipient email" }); if (!text && !html) return res.status(400).json({ success: false, error: "Message is required" }); const sent = await sendEmail({ to, subject, text, html }); res.json({ success: true, message: "Email sent successfully", id: sent.id || null, threadId: sent.threadId || null, to }); } catch (error) { console.error("REST send error:", errorDetails(error).code, friendlyGmailError(error)); res.status(500).json({ success: false, error: friendlyGmailError(error) }); } });
app.post("/admin/test-email", async (req, res) => { if (!ADMIN_CHAT_ID || String(req.headers["x-admin-chat-id"] || req.body?.adminChatId) !== String(ADMIN_CHAT_ID)) return res.status(403).json({ success: false, error: "Admin authorization required" }); try { const sent = await sendEmail({ to: req.body.to, subject: req.body.subject || "Admin test email", text: req.body.text || "Test email" }); res.json({ success: true, id: sent.id || null }); } catch (error) { res.status(500).json({ success: false, error: friendlyGmailError(error) }); } });

async function handleMenu(chatId, action) {
  if (action === "menu") return sendTelegram(chatId, "🤖 AI Email Assistant\n\nChoose an option:", mainMenu());
  if (action === "email") return sendTelegram(chatId, "📧 Email", emailMenu());
  if (action === "compose") { setConversation(chatId, { state: "WAITING_EMAIL", draft: {} }); return sendTelegram(chatId, "📧 Email Composer\n\nTo:"); }
  if (action === "html") { setConversation(chatId, { state: "WAITING_EMAIL", draft: { htmlMode: true } }); return sendTelegram(chatId, "📨 HTML Email\n\nTo:"); }
  if (action === "ai") { setConversation(chatId, { state: "AI_COMPOSING" }); return sendTelegram(chatId, AI_API_KEY ? "🤖 AI Assistant\nDescribe the email you want me to prepare. It will never send without your confirmation." : "AI is currently unavailable. You can still compose email manually.", AI_API_KEY ? kb([[ ["❌ Cancel", "cancel"] ]]) : emailMenu()); }
  if (action === "files" || action === "attachment") { setConversation(chatId, { state: "WAITING_ATTACHMENT" }); return sendTelegram(chatId, "📎 Send me the file or photo. Maximum size: 10 MB.", kb([[ ["❌ Cancel", "cancel"] ]])); }
  if (action === "templates") return sendTelegram(chatId, "📋 Templates", templateMenu());
  if (action === "schedule") { setConversation(chatId, { state: "SCHEDULING", draft: {} }); return sendTelegram(chatId, "⏰ Send the email details in this format:\n\n/schedule 2026-09-01 14:30 recipient@example.com Message\n\nTimezone: " + TIMEZONE, kb([[ ["❌ Cancel", "cancel"] ]])); }
  if (action === "history") { if (!isAdmin(chatId)) return sendTelegram(chatId, "❌ History is available to the administrator only.", mainMenu()); const recent = store.history.slice(0, 10); return sendTelegram(chatId, recent.length ? "📬 Recent Emails\n\n" + recent.map(item => `${item.status === "sent" ? "✅" : "❌"} ${item.to}\n${item.subject}\n${new Date(item.at).toLocaleString("en-GB", { timeZone: TIMEZONE })}`).join("\n\n") : "📬 No email history yet.", mainMenu()); }
  if (action === "settings") return sendTelegram(chatId, isAdmin(chatId) ? `⚙️ Settings\n\nGmail: ${REFRESH_TOKEN ? "CONNECTED" : "NOT CONFIGURED"}\nAI: ${AI_API_KEY ? "READY" : "NOT CONFIGURED"}\nTimezone: ${TIMEZONE}\nScheduled jobs: ${store.schedules.filter(item => item.status === "scheduled").length}` : "❌ Settings are available to the administrator only.", mainMenu());
  if (action.startsWith("tpl:")) return handleTemplate(chatId, action.slice(4));
  return null;
}
async function handleTemplate(chatId, type) { if (type === "create") { if (!AI_API_KEY) return sendTelegram(chatId, "AI is currently unavailable. You can still use the built-in templates.", templateMenu()); setConversation(chatId, { state: "TEMPLATE_CREATING" }); return sendTelegram(chatId, "Describe the template you want me to create. It will not be sent or saved without confirmation.", kb([[ ["❌ Cancel", "cancel"] ]])); } const templates = { welcome: ["Welcome", "Welcome to our service", "<h1>Welcome</h1><p>We are glad to have you with us.</p>"], otp: ["OTP", "Your verification code", "<p>Your verification code is <strong>{{otp}}</strong>.</p>"], invoice: ["Invoice", "Your invoice", "<p>Please find your invoice details below.</p>"], business: ["Business", "Business update", "<p>Here is an important business update.</p>"], announcement: ["Announcement", "Important announcement", "<p>We are pleased to share an announcement.</p>"] }; const item = templates[type]; if (!item) return sendTelegram(chatId, "Unknown template.", templateMenu()); return sendTelegram(chatId, `📋 ${item[0]}\n\nSubject:\n${item[1]}\n\nHTML:\n${item[2]}`, mainMenu()); }
async function processText(chatId, text) {
  if (limited(chatId, "messages", 30)) return sendTelegram(chatId, "Please slow down and try again in a moment.");
  if (text === "/start") { clearConversation(chatId); return sendTelegram(chatId, "🤖 AI Email Assistant\n\nChoose an option:", mainMenu()); }
  if (text === "/help") return sendTelegram(chatId, "Use the menu buttons or describe an email naturally. Commands: /send email@example.com message, /schedule YYYY-MM-DD HH:mm email@example.com message, /status.", mainMenu());
  if (text === "/status") return sendTelegram(chatId, REFRESH_TOKEN ? "✅ Gmail OAuth is configured. Use the menu to continue." : "❌ Gmail OAuth is not configured.", mainMenu());
  if (text.startsWith("/send ")) { const parts = text.slice(6).trim().split(/\s+/); const to = parts.shift(); const body = parts.join(" "); if (!validEmail(to) || !body) return sendTelegram(chatId, "❌ Format: /send email@example.com Hello"); setConversation(chatId, { state: "WAITING_CONFIRMATION", draft: { to, subject: "Message from Telegram", text: body } }); return sendTelegram(chatId, formatDraft(getConversation(chatId).draft), confirmMenu()); }
  if (text.startsWith("/schedule ")) return scheduleFromText(chatId, text.slice(10).trim());
  const conversation = getConversation(chatId);
  if (conversation.state === "WAITING_EMAIL") { if (!validEmail(text)) return sendTelegram(chatId, "❌ Please provide a valid recipient email address."); setConversation(chatId, { state: "WAITING_SUBJECT", draft: { ...(conversation.draft || {}), to: text } }); return sendTelegram(chatId, "Subject:"); }
  if (conversation.state === "WAITING_SUBJECT") { setConversation(chatId, { state: "WAITING_MESSAGE", draft: { ...conversation.draft, subject: text } }); return sendTelegram(chatId, "Message:"); }
  if (conversation.state === "WAITING_MESSAGE") { const draft = { ...conversation.draft, text }; setConversation(chatId, { state: "WAITING_CONFIRMATION", draft }); return sendTelegram(chatId, formatDraft(draft), confirmMenu()); }
  if (conversation.state === "WAITING_RECIPIENT") { if (!validEmail(text)) return sendTelegram(chatId, "❌ Please provide a valid recipient email address."); setConversation(chatId, { state: "WAITING_ATTACHMENT_MESSAGE", draft: { ...conversation.draft, to: text } }); return sendTelegram(chatId, "Add a message? Reply with text, or type /skip."); }
  if (conversation.state === "WAITING_ATTACHMENT_MESSAGE") { const draft = { ...conversation.draft, text: text === "/skip" ? "" : text }; setConversation(chatId, { state: "WAITING_CONFIRMATION", draft }); return sendTelegram(chatId, formatDraft(draft), confirmMenu("file")); }
  if (conversation.state === "SCHEDULING") return scheduleFromText(chatId, text);
  if (conversation.state === "AI_COMPOSING") { if (!AI_API_KEY) return sendTelegram(chatId, "AI is currently unavailable. You can still compose email manually.", emailMenu()); if (limited(chatId, "ai", 8)) return sendTelegram(chatId, "AI request limit reached. Please wait a minute."); try { const draft = await generateStructuredEmail(text); if (!validEmail(draft.to)) draft.to = ""; setConversation(chatId, { state: "AI_CONFIRMATION", prompt: text, draft: { to: draft.to, subject: draft.subject, text: draft.body } }); return sendTelegram(chatId, formatDraft(getConversation(chatId).draft), aiConfirmMenu()); } catch (error) { return sendTelegram(chatId, "AI is currently unavailable. You can still compose email manually.", emailMenu()); } }
  if (conversation.state === "TEMPLATE_CREATING") { try { const html = sanitizeHtml(await generateAIResponse(`Create a professional email template for: ${text}. Return HTML and plain text.`)); setConversation(chatId, { state: "TEMPLATE_CONFIRMATION", template: { name: "AI Template", subject: text.slice(0, 80), html, text: html.replace(/<[^>]+>/g, " ") } }); return sendTelegram(chatId, `📋 AI Template\n\nSubject: ${text}\n\n${html}`, kb([[ ["💾 Save Template", "template:save"], ["✏️ Edit", "template:edit"] ], [["❌ Cancel", "cancel"] ]])); } catch { return sendTelegram(chatId, "AI is currently unavailable. You can still use the built-in templates.", templateMenu()); } }
  if (/^send\s+an?\s+email/i.test(text) || /email/i.test(text)) { if (!AI_API_KEY) return sendTelegram(chatId, "AI is currently unavailable. You can still compose email manually.", emailMenu()); setConversation(chatId, { state: "AI_COMPOSING" }); return processText(chatId, text); }
  return sendTelegram(chatId, "Use the menu buttons or describe the email you want to prepare.", mainMenu());
}
async function scheduleFromText(chatId, input) { const match = input.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(\S+)\s+([\s\S]+)$/); if (!match || !validEmail(match[3])) return sendTelegram(chatId, "❌ Format: /schedule 2026-09-01 14:30 email@example.com Message"); const sendAt = parseSchedule(`${match[1]}T${match[2]}:00+06:00`); if (!sendAt || sendAt.getTime() <= Date.now()) return sendTelegram(chatId, "❌ Please provide a future date and time."); const job = { id: crypto.randomUUID(), chatId: String(chatId), to: match[3], subject: "Scheduled message from Telegram", text: match[4], sendAt: sendAt.toISOString(), status: "scheduled" }; store.schedules.push(job); await saveStore(); clearConversation(chatId); return sendTelegram(chatId, `⏰ Scheduled for ${sendAt.toLocaleString("en-GB", { timeZone: TIMEZONE })}\nTo: ${job.to}`, mainMenu()); }
async function processFile(chatId, fileInfo) { if (fileInfo.file_size > MAX_ATTACHMENT_BYTES) return sendTelegram(chatId, "❌ File is too large. Maximum size is 10 MB."); const extension = path.extname(fileInfo.file_name || ".bin").toLowerCase(); const mime = fileInfo.mime_type || "application/octet-stream"; if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIMES.has(mime) && mime !== "application/octet-stream") return sendTelegram(chatId, "❌ Unsupported file type."); const meta = await telegram("getFile", { file_id: fileInfo.file_id }); const filePath = path.join(os.tmpdir(), `telegram-${crypto.randomUUID()}-${path.basename(fileInfo.file_name || "upload")}`); try { const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${meta.result.file_path}`); if (!response.ok) throw new Error("Telegram file download failed"); const buffer = Buffer.from(await response.arrayBuffer()); await fsp.writeFile(filePath, buffer, { mode: 0o600 }); setConversation(chatId, { state: "WAITING_RECIPIENT", draft: { attachment: { name: fileInfo.file_name || "photo", mime, data: buffer } } }); return sendTelegram(chatId, `📎 File received\n\nName: ${fileInfo.file_name || "photo"}\nType: ${mime}\n\nWho should receive this file?`, kb([[ ["❌ Cancel", "cancel"] ]])); } catch (error) { return sendTelegram(chatId, "❌ Could not download that file."); } finally { await fsp.rm(filePath, { force: true }).catch(() => {}); } }

app.post("/telegram/webhook", (req, res) => { if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) return res.sendStatus(403); res.sendStatus(200); Promise.resolve(handleUpdate(req.body)).catch(error => console.error("Telegram update error:", friendlyGmailError(error))); });
async function handleUpdate(update) { if (update.callback_query) { const callback = update.callback_query; const chatId = callback.message.chat.id; await answerCallback(callback.id); const action = callback.data; if (action === "cancel") { clearConversation(chatId); return sendTelegram(chatId, "❌ Cancelled.", mainMenu()); } if (action === "send" || action === "send:send" || action === "file:send" || action === "ai:send") { const draft = getConversation(chatId).draft; if (!draft?.to || !validEmail(draft.to)) return sendTelegram(chatId, "❌ A valid recipient is required."); try { await sendEmail({ ...draft, chatId }); clearConversation(chatId); return sendTelegram(chatId, `✅ Email sent successfully\n\nTo: ${draft.to}\nSubject: ${draft.subject || "Message from Telegram"}`, mainMenu()); } catch (error) { return sendTelegram(chatId, `❌ ${friendlyGmailError(error)}`, mainMenu()); } } if (action === "ai:regenerate") { const c = getConversation(chatId); if (!c.prompt) return sendTelegram(chatId, "No AI draft to regenerate.", emailMenu()); return processText(chatId, c.prompt); } if (action.endsWith(":edit")) { setConversation(chatId, { state: "WAITING_MESSAGE" }); return sendTelegram(chatId, "Send the revised message:"); } if (action === "template:save") { if (!isAdmin(chatId)) return sendTelegram(chatId, "❌ Template management is available to the administrator only.", mainMenu()); const template = getConversation(chatId).template; if (template) { store.templates.push({ ...template, createdAt: new Date().toISOString() }); await saveStore(); } clearConversation(chatId); return sendTelegram(chatId, "✅ Template saved.", templateMenu()); } const handled = await handleMenu(chatId, action); if (!handled) await sendTelegram(chatId, "Unknown menu action.", mainMenu()); return; }
  const message = update.message; if (!message) return; const chatId = message.chat.id; if (ADMIN_CHAT_ID && !isAdmin(chatId) && message.text?.startsWith("/admin")) return sendTelegram(chatId, "❌ You are not authorized to use this bot."); if (message.document) return processFile(chatId, { file_id: message.document.file_id, file_name: message.document.file_name, mime_type: message.document.mime_type, file_size: message.document.file_size }); if (message.photo?.length) { const photo = message.photo[message.photo.length - 1]; return processFile(chatId, { file_id: photo.file_id, file_name: "telegram-photo.jpg", mime_type: "image/jpeg", file_size: photo.file_size }); } return processText(chatId, String(message.text || "").trim()); }

(async () => { await loadStore(); setInterval(() => runSchedules().catch(error => console.error("Scheduler error:", error.message)), 15000); const server = app.listen(PORT, "0.0.0.0", () => { console.log("==========================================\n🚀 Telegram Gmail AI Bot\n=========================================="); console.log(`🌐 Port: ${PORT}`); console.log(`🤖 Telegram: READY`); console.log(`📧 Gmail: ${REFRESH_TOKEN ? "READY" : "NOT CONFIGURED"}`); console.log(`🧠 AI: ${AI_API_KEY ? "READY" : "NOT CONFIGURED"}`); console.log("🔐 OAuth: READY"); }); function shutdown(signal) { console.log(`${signal} received.`); server.close(() => process.exit(0)); } process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT")); })();
