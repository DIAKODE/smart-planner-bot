const BOT_COMMANDS = [
  { command: "start", description: "🚀 راه‌اندازی و باز کردن برنامه" },
  { command: "tasks", description: "📋 مشاهده و مدیریت کارهای امروز" },
  { command: "today", description: "📅 لیست کارهای امروز" },
  { command: "tomorrow", description: "🌅 لیست کارهای فردا" },
  { command: "rollover", description: "↩️ انتقال کارهای ناتمام دیروز به امروز" },
  { command: "stats", description: "📊 آمار عملکرد هفتگی و استریک" },
  { command: "web", description: "🔐 لینک و کد ورود نسخه وب و اپ نصبی" },
  { command: "help", description: "📖 راهنمای ثبت دستی و دسته‌بندی" },
  { command: "setup", description: "⚙️ راه‌اندازی خودکار دیتابیس، دستورات و مینی‌اپ" }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const tz = env.TIMEZONE || "Asia/Tehran";
    const isPublic = String(env.PUBLIC_MODE || "false").toLowerCase() === "true";
    const disableWebAuth = String(env.DISABLE_WEB_AUTH || "false").toLowerCase() === "true";

    const adminStr = String(env.ADMIN_CHAT_ID || "");
    const adminIds = adminStr.split(",").map(id => String(id).trim()).filter(Boolean);
    const defaultAdminId = adminIds[0] || "";
    const hasPin = Boolean(env.WEB_PIN && String(env.WEB_PIN).trim().length > 0);

    const path = url.pathname.replace(/\/+/g, "/");

    // --- PWA Manifest ---
    if (path === "/manifest.json") {
      const manifest = {
        name: "Smart Planner",
        short_name: "Planner",
        start_url: "/",
        display: "standalone",
        background_color: "#020617",
        theme_color: "#020617",
        icons: [{ src: "[https://cdn-icons-png.flaticon.com/512/1442/1442912.png](https://cdn-icons-png.flaticon.com/512/1442/1442912.png)", sizes: "512x512", type: "image/png" }]
      };
      return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } });
    }

    // --- One-Click Setup (D1 + Webhook + Commands + Menu Button) ---
    if (path === "/setup" && request.method === "GET") {
      return new Response(getSetupUI(origin), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (path === "/setup" && request.method === "POST") {
      try {
        const { admin_id } = await request.json();
        const inputId = String(admin_id || "").trim();
        if (adminIds.length > 0 && !adminIds.includes(inputId)) {
          return jsonRes({ ok: false, error: "آیدی ادمین با ADMIN_CHAT_ID کلادفلر مطابقت ندارد." }, 403);
        }
        const report = await syncBotConfig(env, origin, true);
        return jsonRes({ ok: true, report });
      } catch (e) {
        return jsonRes({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // --- Main Web / Mini App UI ---
    if (path === "/") {
      return new Response(getHtmlUI(tz, hasPin, disableWebAuth), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // --- Telegram Webhook ---
    if (path === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (headerSecret !== String(env.WEBHOOK_SECRET)) {
          return new Response("Forbidden", { status: 403 });
        }
      }
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env, origin, adminIds, isPublic, tz);
      } catch (e) {
        console.log("Webhook Error:", e);
      }
      return new Response("OK");
    }

    // --- One-Time PWA / Web Login ---
    if (path === "/api/auth/login" && request.method === "POST") {
      try {
        const { credential } = await request.json();
        const cred = String(credential || "").trim();
        if (!cred) return jsonRes({ error: "Empty credential" }, 400);

        if (hasPin && cred === String(env.WEB_PIN).trim() && defaultAdminId) {
          const token = await createSessionToken(defaultAdminId, env.BOT_TOKEN);
          return jsonRes({ ok: true, token });
        }

        const verified = await verifySessionToken(cred, env.BOT_TOKEN);
        if (verified && isAllowedUser(verified.uid, adminIds, isPublic)) {
          const freshToken = await createSessionToken(verified.uid, env.BOT_TOKEN);
          return jsonRes({ ok: true, token: freshToken });
        }

        return jsonRes({ error: "Invalid credentials" }, 401);
      } catch {
        return jsonRes({ error: "Bad request" }, 400);
      }
    }

    // --- Authenticated Task APIs ---
    if (path.startsWith("/api/tasks")) {
      const auth = await authenticateRequest(request, env, adminIds, isPublic, disableWebAuth, defaultAdminId);
      if (!auth) {
        return jsonRes({ error: "Unauthorized" }, 401);
      }
      const authChatId = auth.chatId;
      const extraHeaders = {};
      if (auth.shouldRefresh) {
        extraHeaders["X-Refreshed-Token"] = await createSessionToken(authChatId, env.BOT_TOKEN);
      }

      if (path === "/api/tasks" && request.method === "GET") {
        const targetDate = url.searchParams.get("date") || getDateStrInTZ(tz);
        const todayStr = getDateStrInTZ(tz);
        const yesterdayStr = getDateStrInTZ(tz, -1);

        const { results } = await env.DB.prepare(
          "SELECT * FROM tasks WHERE chat_id = ? AND created_date = ? ORDER BY is_completed ASC, CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id DESC"
        ).bind(authChatId, targetDate).all();

        let yesterdayPending = 0;
        if (targetDate === todayStr) {
          const yRes = await env.DB.prepare(
            "SELECT COUNT(*) as cnt FROM tasks WHERE chat_id = ? AND created_date = ? AND is_completed = 0"
          ).bind(authChatId, yesterdayStr).first();
          yesterdayPending = yRes ? Number(yRes.cnt || 0) : 0;
        }

        return jsonRes({ tasks: results, yesterdayPending }, 200, extraHeaders);
      }

      if (path === "/api/tasks" && request.method === "POST") {
        const { title, reminder_time, date, category, priority, repeat_type } = await request.json();
        const cleanTitle = String(title || "").trim();
        if (!cleanTitle) return jsonRes({ error: "Title required" }, 400);

        const targetDate = date || getDateStrInTZ(tz);
        const finalCat = ["general", "work", "sport", "shop", "learn"].includes(category) ? category : "general";
        const finalPri = ["normal", "medium", "high"].includes(priority) ? priority : "normal";
        const finalRep = ["none", "daily", "weekly"].includes(repeat_type) ? repeat_type : "none";

        await env.DB.prepare(
          "INSERT INTO tasks (chat_id, title, reminder_time, created_date, category, priority, repeat_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(authChatId, cleanTitle, reminder_time || null, targetDate, finalCat, finalPri, finalRep).run();

        return jsonRes({ success: true }, 200, extraHeaders);
      }

      if (path === "/api/tasks/edit" && request.method === "POST") {
        const { id, title, reminder_time, category, priority, repeat_type } = await request.json();
        const cleanTitle = String(title || "").trim();
        if (!id || !cleanTitle) return jsonRes({ error: "Invalid data" }, 400);

        const finalCat = ["general", "work", "sport", "shop", "learn"].includes(category) ? category : "general";
        const finalPri = ["normal", "medium", "high"].includes(priority) ? priority : "normal";
        const finalRep = ["none", "daily", "weekly"].includes(repeat_type) ? repeat_type : "none";

        const existing = await env.DB.prepare("SELECT reminder_time, notified FROM tasks WHERE id = ? AND chat_id = ?").bind(id, authChatId).first();
        if (!existing) return jsonRes({ error: "Not found" }, 404);

        const newTime = reminder_time || null;
        const resetNotified = existing.reminder_time !== newTime ? 0 : existing.notified;

        await env.DB.prepare(
          "UPDATE tasks SET title = ?, reminder_time = ?, category = ?, priority = ?, repeat_type = ?, notified = ? WHERE id = ? AND chat_id = ?"
        ).bind(cleanTitle, newTime, finalCat, finalPri, finalRep, resetNotified, id, authChatId).run();

        return jsonRes({ success: true }, 200, extraHeaders);
      }

      if (path === "/api/tasks/toggle" && request.method === "POST") {
        const { id, is_completed, date } = await request.json();
        await env.DB.prepare(
          "UPDATE tasks SET is_completed = ? WHERE id = ? AND chat_id = ?"
        ).bind(is_completed ? 1 : 0, id, authChatId).run();

        let allCompleted = false;
        if (is_completed && date) {
          const { results } = await env.DB.prepare(
            "SELECT is_completed FROM tasks WHERE chat_id = ? AND created_date = ?"
          ).bind(authChatId, date).all();

          if (results.length > 0 && results.every(task => task.is_completed === 1)) {
            allCompleted = true;
            const faDate = formatDisplayDate(date, "fa");
            const msg = `🎉 <b>تبریک می‌گویم!</b> 🎉\n\nشما تمام کارهای روز <b>${faDate}</b> را با موفقیت انجام دادید! به خودتان افتخار کنید و استراحت خوبی داشته باشید. ☕️🏆`;
            await sendMessage(env, authChatId, msg);
          }
        }
        return jsonRes({ success: true, allCompleted }, 200, extraHeaders);
      }

      if (path === "/api/tasks/delete" && request.method === "POST") {
        const { id } = await request.json();
        await env.DB.prepare("DELETE FROM tasks WHERE id = ? AND chat_id = ?").bind(id, authChatId).run();
        return jsonRes({ success: true }, 200, extraHeaders);
      }

      if (path === "/api/tasks/rollover" && request.method === "POST") {
        const todayStr = getDateStrInTZ(tz);
        const yesterdayStr = getDateStrInTZ(tz, -1);
        const res = await env.DB.prepare(
          "UPDATE tasks SET created_date = ?, notified = 0 WHERE chat_id = ? AND created_date = ? AND is_completed = 0"
        ).bind(todayStr, authChatId, yesterdayStr).run();
        return jsonRes({ success: true, moved: res.meta?.changes || 0 }, 200, extraHeaders);
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  // --- Cron Trigger: Reminders, Recurring Tasks & Auto-Cleanup ---
  async scheduled(event, env, ctx) {
    const tz = env.TIMEZONE || "Asia/Tehran";
    const today = getDateStrInTZ(tz);
    const nowHourMin = getTimeStrInTZ(tz);

    const { results } = await env.DB.prepare(
      "SELECT * FROM tasks WHERE reminder_time IS NOT NULL AND reminder_time != '' AND reminder_time <= ? AND created_date = ? AND is_completed = 0 AND notified = 0"
    ).bind(nowHourMin, today).all();

    for (const task of results) {
      try {
        const catIcons = { work: "💻", sport: "🏋️‍♂️", shop: "🛒", learn: "📚", general: "📌" };
        const priBadge = task.priority === "high" ? "🔴 فوری" : (task.priority === "medium" ? "🟡 مهم" : "");
        const icon = catIcons[task.category] || "📌";
        const msg = `🔔 <b>یادآوری کار</b> ${priBadge ? `(${priBadge})` : ""}\n\n${icon} <b>${escapeHTML(task.title)}</b>\n⏰ <i>ساعت: ${task.reminder_time}</i>`;

        const response = await sendMessage(env, String(task.chat_id), msg, getReminderKeyboard(task.id));
        if (response.ok) {
          await env.DB.prepare("UPDATE tasks SET notified = 1 WHERE id = ?").bind(task.id).run();
        }
      } catch (err) {
        console.log("Reminder Error:", task.id, err);
      }
    }

    if (nowHourMin === "00:05") {
      const yesterday = getDateStrInTZ(tz, -1);
      const weekAgo = getDateStrInTZ(tz, -7);

      const { results: recTasks } = await env.DB.prepare(
        "SELECT * FROM tasks WHERE (repeat_type = 'daily' AND created_date = ?) OR (repeat_type = 'weekly' AND created_date = ?)"
      ).bind(yesterday, weekAgo).all();

      for (const t of recTasks) {
        const dup = await env.DB.prepare(
          "SELECT id FROM tasks WHERE chat_id = ? AND title = ? AND created_date = ?"
        ).bind(String(t.chat_id), t.title, today).first();

        if (!dup) {
          await env.DB.prepare(
            "INSERT INTO tasks (chat_id, title, reminder_time, created_date, category, priority, repeat_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(String(t.chat_id), t.title, t.reminder_time, today, t.category || "general", t.priority || "normal", t.repeat_type).run();
        }
      }
    }

    if (nowHourMin === "03:00") {
      const thirtyDaysAgo = getDateStrInTZ(tz, -30);
      const deleteQuery = await env.DB.prepare("DELETE FROM tasks WHERE created_date < ?").bind(thirtyDaysAgo).run();
      const adminStr = String(env.ADMIN_CHAT_ID || "");
      const defaultAdminId = adminStr.split(",")[0].trim();
      if (deleteQuery.success && defaultAdminId && (deleteQuery.meta?.changes || 0) > 0) {
        await sendMessage(env, defaultAdminId, `🧹 <b>نظافت خودکار دیتابیس</b>\n\n${deleteQuery.meta.changes} تسک قدیمی‌تر از ۳۰ روز پاکسازی شدند. 🚀`);
      }
    }
  }
};

// --- Auto D1 Init & Migration ---
async function initDatabase(env) {
  if (!env.DB) {
    return { ok: false, description: "دیتابیس D1 با نام DB به ورکر متصل (Bind) نشده است." };
  }
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        reminder_time TEXT,
        is_completed BOOLEAN DEFAULT 0,
        created_date TEXT NOT NULL,
        notified BOOLEAN DEFAULT 0,
        category TEXT DEFAULT 'general',
        priority TEXT DEFAULT 'normal',
        repeat_type TEXT DEFAULT 'none'
      )
    `).run();

    const { results: cols } = await env.DB.prepare("PRAGMA table_info(tasks)").all();
    const colNames = new Set(cols.map(c => c.name));
    const migrated = [];

    if (!colNames.has("category")) {
      await env.DB.prepare("ALTER TABLE tasks ADD COLUMN category TEXT DEFAULT 'general'").run();
      migrated.push("category");
    }
    if (!colNames.has("priority")) {
      await env.DB.prepare("ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'normal'").run();
      migrated.push("priority");
    }
    if (!colNames.has("repeat_type")) {
      await env.DB.prepare("ALTER TABLE tasks ADD COLUMN repeat_type TEXT DEFAULT 'none'").run();
      migrated.push("repeat_type");
    }

    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_chat_date ON tasks (chat_id, created_date)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks (created_date, is_completed, notified, reminder_time)").run();

    const details = migrated.length > 0
      ? `جدول و ایندکس‌ها آماده شدند (ستون‌های جدید اضافه شد: ${migrated.join(", ")})`
      : "جدول، ستون‌ها و ایندکس‌ها کامل و آماده هستند";

    return { ok: true, description: details };
  } catch (err) {
    return { ok: false, description: String(err.message || err) };
  }
}

// --- Auto Sync Bot & Database ---
async function syncBotConfig(env, origin, includeWebhook = false) {
  const report = {};
  report.database = await initDatabase(env);

  if (includeWebhook) {
    const whPayload = { url: `${origin}/webhook` };
    if (env.WEBHOOK_SECRET) whPayload.secret_token = String(env.WEBHOOK_SECRET);
    const whRes = await sendTelegramRequest(env, "setWebhook", whPayload);
    report.webhook = await whRes.json();
  }

  const cmdRes = await sendTelegramRequest(env, "setMyCommands", { commands: BOT_COMMANDS });
  report.commands = await cmdRes.json();

  const menuRes = await sendTelegramRequest(env, "setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "🚀 برنامه‌ها",
      web_app: { url: origin }
    }
  });
  report.menuButton = await menuRes.json();

  return report;
}

// --- Crypto & Hybrid Auth (HMAC-SHA256) ---
async function hmacSha256(keyData, msg) {
  const rawKey = typeof keyData === "string" ? new TextEncoder().encode(keyData) : keyData;
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyTelegramInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const authDate = Number(params.get("auth_date") || 0);
    if (authDate && Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = await hmacSha256("WebAppData", botToken);
    const computedHash = bufToHex(await hmacSha256(secretKey, dataCheckString));
    if (!safeEqual(computedHash, hash)) return null;

    const userStr = params.get("user");
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    return user && user.id ? String(user.id) : null;
  } catch {
    return null;
  }
}

async function createSessionToken(chatId, botToken) {
  const now = Date.now();
  const payloadObj = { uid: String(chatId), iat: now, exp: now + 365 * 86400 * 1000 };
  const payload = btoa(JSON.stringify(payloadObj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = bufToHex(await hmacSha256("PWA_SESSION_" + botToken, payload));
  return `${payload}.${sig}`;
}

async function verifySessionToken(token, botToken) {
  try {
    if (!token || !botToken) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expectedSig = bufToHex(await hmacSha256("PWA_SESSION_" + botToken, payload));
    if (!safeEqual(sig, expectedSig)) return null;

    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const data = JSON.parse(atob(b64 + pad));
    if (!data.uid || !data.exp || data.exp < Date.now()) return null;
    const shouldRefresh = !data.iat || (Date.now() - data.iat > 7 * 86400 * 1000);
    return { uid: String(data.uid), shouldRefresh };
  } catch {
    return null;
  }
}

function isAllowedUser(chatId, adminIds, isPublic) {
  return isPublic || adminIds.includes(String(chatId));
}

async function authenticateRequest(request, env, adminIds, isPublic, disableWebAuth, defaultAdminId) {
  const tgInitData = request.headers.get("X-Telegram-Init-Data");
  if (tgInitData) {
    const uid = await verifyTelegramInitData(tgInitData, env.BOT_TOKEN);
    if (uid && isAllowedUser(uid, adminIds, isPublic)) return { chatId: uid, shouldRefresh: false };
  }

  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const verified = await verifySessionToken(token, env.BOT_TOKEN);
    if (verified && isAllowedUser(verified.uid, adminIds, isPublic)) {
      return { chatId: verified.uid, shouldRefresh: verified.shouldRefresh };
    }
  }

  if (disableWebAuth && defaultAdminId) {
    return { chatId: defaultAdminId, shouldRefresh: false };
  }

  return null;
}

function jsonRes(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      ...extraHeaders
    }
  });
}

// --- Telegram Bot Handlers ---
function escapeHTML(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleTelegramUpdate(update, env, origin, adminIds, isPublic, tz) {
  let rawChatId = null;
  if (update.message && update.message.chat) rawChatId = update.message.chat.id;
  else if (update.callback_query && update.callback_query.message) rawChatId = update.callback_query.message.chat.id;
  if (!rawChatId) return;

  const chatIdStr = String(rawChatId);
  if (!isAllowedUser(chatIdStr, adminIds, isPublic)) {
    if (update.message) await sendMessage(env, chatIdStr, "⛔ <i>دسترسی شما غیرمجاز است.</i>");
    return;
  }

  if (update.callback_query) {
    const data = update.callback_query.data;
    const messageId = update.callback_query.message.message_id;
    const cbId = update.callback_query.id;

    if (data.startsWith("toggle_")) {
      const taskId = data.split("_")[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND chat_id = ?").bind(taskId, chatIdStr).first();
      if (task) {
        const newStatus = task.is_completed ? 0 : 1;
        await env.DB.prepare("UPDATE tasks SET is_completed = ? WHERE id = ? AND chat_id = ?").bind(newStatus, taskId, chatIdStr).run();
        await sendTelegramRequest(env, "editMessageReplyMarkup", {
          chat_id: chatIdStr,
          message_id: messageId,
          reply_markup: getTaskKeyboard(taskId, newStatus)
        });
        await sendTelegramRequest(env, "answerCallbackQuery", { callback_query_id: cbId, text: newStatus ? "✅ انجام شد!" : "⏳ برگشت به در حال انجام" });

        if (newStatus === 1) {
          const { results: allTasks } = await env.DB.prepare(
            "SELECT is_completed FROM tasks WHERE chat_id = ? AND created_date = ?"
          ).bind(chatIdStr, task.created_date).all();
          if (allTasks.length > 0 && allTasks.every(t => t.is_completed === 1)) {
            const faDate = formatDisplayDate(task.created_date, "fa");
            await sendMessage(env, chatIdStr, `🎉 <b>تبریک می‌گویم!</b> 🎉\n\nشما تمام کارهای روز <b>${faDate}</b> را با موفقیت انجام دادید! ☕️🏆`);
          }
        }
      }
    } else if (data.startsWith("snooze_")) {
      const parts = data.split("_");
      const mins = Number(parts[1]) || 15;
      const taskId = parts[2];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND chat_id = ?").bind(taskId, chatIdStr).first();
      if (task) {
        const futureDateObj = new Date(Date.now() + mins * 60000);
        const newTime = getTimeStrInTZ(tz, futureDateObj);
        const newDate = getDateStrInTZ(tz, 0, futureDateObj);
        await env.DB.prepare(
          "UPDATE tasks SET reminder_time = ?, created_date = ?, notified = 0 WHERE id = ? AND chat_id = ?"
        ).bind(newTime, newDate, taskId, chatIdStr).run();

        await sendTelegramRequest(env, "editMessageText", {
          chat_id: chatIdStr,
          message_id: messageId,
          parse_mode: "HTML",
          text: `⏰ <b>یادآوری به تعویق افتاد</b>\n\n📌 <b>${escapeHTML(task.title)}</b>\n🕒 زمان جدید: <b>${newTime}</b>`,
          reply_markup: getTaskKeyboard(taskId, 0)
        });
        await sendTelegramRequest(env, "answerCallbackQuery", { callback_query_id: cbId, text: `⏰ ${mins} دقیقه به تعویق افتاد` });
      }
    } else if (data.startsWith("del_")) {
      const taskId = data.split("_")[1];
      await env.DB.prepare("DELETE FROM tasks WHERE id = ? AND chat_id = ?").bind(taskId, chatIdStr).run();
      await sendTelegramRequest(env, "deleteMessage", { chat_id: chatIdStr, message_id: messageId });
      await sendTelegramRequest(env, "answerCallbackQuery", { callback_query_id: cbId, text: "🗑 تسک حذف شد!" });
    }
    return;
  }

  if (update.message && update.message.text) {
    const text = update.message.text.trim();

    if (text === "/start") {
      const keyboard = { inline_keyboard: [[{ text: "🚀 باز کردن اپلیکیشن", web_app: { url: origin } }]] };
      await sendMessage(env, chatIdStr, "✨ <b>به دستیار هوشمند برنامه‌ریزی خوش آمدید!</b>\n\nبرای مدیریت حرفه‌ای کارها دکمه زیر را بزنید.\n\n🔐 اتصال یک‌باره نسخه وب و اپ نصبی: /web\n📊 گزارش عملکرد: /stats\n⚙️ تنظیم خودکار دیتابیس و دستورات: /setup\n📖 راهنمای ثبت سریع: /help", keyboard);
    } else if (text === "/setup") {
      if (adminIds.length > 0 && !adminIds.includes(chatIdStr)) {
        await sendMessage(env, chatIdStr, "⛔ <i>این دستور فقط برای ادمین ربات است.</i>");
        return;
      }
      const report = await syncBotConfig(env, origin, false);
      const dbOk = report.database?.ok ? "✅" : "❌";
      const cmdOk = report.commands?.ok ? "✅" : "❌";
      const menuOk = report.menuButton?.ok ? "✅" : "❌";
      await sendMessage(env, chatIdStr, `⚙️ <b>راه‌اندازی خودکار انجام شد!</b>\n\n${dbOk} <b>دیتابیس D1:</b> ${escapeHTML(report.database?.description || "")}\n${cmdOk} <b>منوی دستورات:</b> ثبت ${BOT_COMMANDS.length} دستور\n${menuOk} <b>دکمه مینی‌اپ:</b> تنظیم کنار چت`);
    } else if (text === "/web") {
      const token = await createSessionToken(chatIdStr, env.BOT_TOKEN);
      const magicLink = `${origin}/?token=${encodeURIComponent(token)}`;
      const msg = `🔐 <b>ورود یک‌باره به نسخه وب و اپ نصبی (PWA)</b>\n\n۱️⃣ برای مرورگر، روی دکمه زیر بزنید تا بدون رمز وارد شوید.\n۲️⃣ برای اپ نصب‌شده روی گوشی، کد زیر را لمس کنید تا کپی شود و فقط <b>یک بار</b> وارد کنید (بعد از آن خودکار تمدید می‌شود):\n\n<code>${token}</code>`;
      const kb = { inline_keyboard: [[{ text: "🌐 ورود مستقیم به نسخه وب", url: magicLink }]] };
      await sendMessage(env, chatIdStr, msg, kb);
    } else if (text === "/rollover") {
      const todayStr = getDateStrInTZ(tz);
      const yesterdayStr = getDateStrInTZ(tz, -1);
      const res = await env.DB.prepare(
        "UPDATE tasks SET created_date = ?, notified = 0 WHERE chat_id = ? AND created_date = ? AND is_completed = 0"
      ).bind(todayStr, chatIdStr, yesterdayStr).run();
      const moved = res.meta?.changes || 0;
      if (moved > 0) {
        await sendMessage(env, chatIdStr, `↩️ <b>${moved} کار ناتمام</b> از دیروز به لیست امروز منتقل شد.`);
      } else {
        await sendMessage(env, chatIdStr, "✨ <i>دیروز هیچ کار ناتمامی نداشتید!</i>");
      }
    } else if (text === "/stats") {
      const weekAgo = getDateStrInTZ(tz, -6);
      const todayStr = getDateStrInTZ(tz);
      const { results: weekTasks } = await env.DB.prepare(
        "SELECT is_completed, category FROM tasks WHERE chat_id = ? AND created_date >= ? AND created_date <= ?"
      ).bind(chatIdStr, weekAgo, todayStr).all();

      const total = weekTasks.length;
      const done = weekTasks.filter(t => t.is_completed === 1).length;
      const pct = total ? Math.round((done / total) * 100) : 0;

      const cats = { work: 0, sport: 0, shop: 0, learn: 0, general: 0 };
      weekTasks.filter(t => t.is_completed === 1).forEach(t => {
        const k = cats[t.category] !== undefined ? t.category : "general";
        cats[k]++;
      });

      const { results: days } = await env.DB.prepare(
        "SELECT created_date, COUNT(*) as total, SUM(is_completed) as done FROM tasks WHERE chat_id = ? AND created_date <= ? GROUP BY created_date ORDER BY created_date DESC LIMIT 30"
      ).bind(chatIdStr, todayStr).all();

      let streak = 0;
      for (const d of days) {
        if (Number(d.total) > 0 && Number(d.total) === Number(d.done)) streak++;
        else if (d.created_date === todayStr) continue;
        else break;
      }

      const msg = `📊 <b>آمار ۷ روز اخیر شما</b>\n\n✅ انجام‌شده: <b>${done}</b> از <b>${total}</b> (${pct}%)\n🔥 استریک تکمیل کامل: <b>${streak} روز</b>\n\n🏷 <b>تفکیک کارهای انجام‌شده:</b>\n💻 کاری: ${cats.work} | 🏋️‍♂️ ورزشی: ${cats.sport}\n🛒 خرید: ${cats.shop} | 📚 یادگیری: ${cats.learn}\n📌 عمومی: ${cats.general}`;
      await sendMessage(env, chatIdStr, msg);
    } else if (text === "/help") {
      const helpMsg = `📖 <b>راهنمای ثبت سریع کارها:</b>\n\n📝 <b>فرمت:</b>\n<code>[عنوان] [ساعت] [دسته‌بندی]</code>\n\n<b>مثال‌ها:</b>\n✅ <code>جلسه با تیم 10:00 work</code>\n✅ <code>خرید شیر shop</code> (بدون ساعت)\n✅ <code>مطالعه 21:30 learn</code>\n\n🏷 <b>دسته‌ها:</b>\n<code>work</code> 💻 | <code>sport</code> 🏋️‍♂️ | <code>shop</code> 🛒 | <code>learn</code> 📚 | <code>general</code> 📌\n\n⚡ <b>دستورات مفید:</b>\n/tasks یا /today — کارهای امروز\n/tomorrow — کارهای فردا\n/rollover — انتقال ناتمام‌های دیروز به امروز\n/stats — گزارش هفتگی\n/web — ورود یک‌باره به نسخه وب و اپ نصبی\n/setup — تنظیم خودکار دیتابیس و دستورات ربات`;
      await sendMessage(env, chatIdStr, helpMsg);
    } else if (text === "/today" || text === "/tomorrow" || text === "/tasks" || text === "/list") {
      const isTomorrow = text === "/tomorrow";
      const targetDate = isTomorrow ? getDateStrInTZ(tz, 1) : getDateStrInTZ(tz);
      const dayName = isTomorrow ? "فردا" : "امروز";
      const faDate = formatDisplayDate(targetDate, "fa");

      const { results } = await env.DB.prepare(
        "SELECT * FROM tasks WHERE chat_id = ? AND created_date = ? ORDER BY is_completed ASC, id DESC"
      ).bind(chatIdStr, targetDate).all();

      if (results.length === 0) {
        await sendMessage(env, chatIdStr, `✨ <i>هیچ کاری برای ${dayName} (${faDate}) ثبت نشده.</i>`);
        return;
      }

      await sendMessage(env, chatIdStr, `📅 <b>کارهای ${dayName} (${faDate}):</b>`);
      for (const task of results) {
        const catIcons = { work: "💻", sport: "🏋️‍♂️", shop: "🛒", learn: "📚", general: "📌" };
        const icon = catIcons[task.category] || "📌";
        const pri = task.priority === "high" ? " 🔴" : (task.priority === "medium" ? " 🟡" : "");
        const rep = task.repeat_type && task.repeat_type !== "none" ? " 🔁" : "";
        const timeStr = task.reminder_time ? ` (⏰ ${task.reminder_time})` : "";
        await sendMessage(env, chatIdStr, `${icon} <b>${escapeHTML(task.title)}</b>${pri}${rep}${timeStr}`, getTaskKeyboard(task.id, task.is_completed));
      }
    } else if (!text.startsWith("/")) {
      const timeMatch = text.match(/\b([01]?[0-9]|2[0-3]):([0-5][0-9])\b/);
      let reminderTime = null;
      let cleanText = text;
      if (timeMatch) {
        reminderTime = timeMatch[0].padStart(5, "0");
        cleanText = cleanText.replace(timeMatch[0], "").trim();
      }

      let category = "general";
      const catKeywords = ["work", "sport", "shop", "learn", "general"];
      const words = cleanText.split(/\s+/);
      const lastWord = (words[words.length - 1] || "").toLowerCase();

      if (catKeywords.includes(lastWord)) {
        category = lastWord;
        words.pop();
        cleanText = words.join(" ").trim();
      }

      if (!cleanText) {
        await sendMessage(env, chatIdStr, "⚠️ <i>عنوان کار نمی‌تواند خالی باشد! (/help را بزنید)</i>");
        return;
      }

      const targetDate = getDateStrInTZ(tz);
      await env.DB.prepare(
        "INSERT INTO tasks (chat_id, title, reminder_time, created_date, category, priority, repeat_type) VALUES (?, ?, ?, ?, ?, 'normal', 'none')"
      ).bind(chatIdStr, cleanText, reminderTime, targetDate, category).run();

      const catIcons = { work: "💻 کاری", sport: "🏋️‍♂️ ورزشی", shop: "🛒 خرید", learn: "📚 یادگیری", general: "📌 عمومی" };
      await sendMessage(env, chatIdStr, `✅ <b>ثبت شد:</b>\n📝 <b>${escapeHTML(cleanText)}</b>\n${reminderTime ? `⏰ ساعت: ${reminderTime}\n` : ""}🏷 دسته: ${catIcons[category]}`);
    }
  }
}

function getTaskKeyboard(taskId, isCompleted) {
  return {
    inline_keyboard: [[
      { text: isCompleted ? "✅ انجام شد" : "⏳ در حال انجام", callback_data: `toggle_${taskId}` },
      { text: "🗑 حذف", callback_data: `del_${taskId}` }
    ]]
  };
}

function getReminderKeyboard(taskId) {
  return {
    inline_keyboard: [
      [{ text: "✅ انجام شد", callback_data: `toggle_${taskId}` }],
      [
        { text: "⏰ ۱۵ دقیقه بعد", callback_data: `snooze_15_${taskId}` },
        { text: "⏳ ۱ ساعت بعد", callback_data: `snooze_60_${taskId}` }
      ]
    ]
  };
}

function getDateStrInTZ(tz, addDays = 0, baseDate = null) {
  const d = baseDate ? new Date(baseDate.getTime()) : new Date();
  if (addDays !== 0) d.setDate(d.getDate() + addDays);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = formatter.formatToParts(d);
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
}

function getTimeStrInTZ(tz, dateObj = null) {
  const d = dateObj || new Date();
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false });
  const parts = formatter.formatToParts(d);
  let h = parts.find(p => p.type === "hour").value;
  let m = parts.find(p => p.type === "minute").value;
  if (h === "24") h = "00";
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

function formatDisplayDate(isoDate, lang = "fa") {
  try {
    const d = new Date(isoDate + "T12:00:00Z");
    return new Intl.DateTimeFormat(lang === "fa" ? "fa-IR" : "en-US", { year: "numeric", month: "long", day: "numeric" }).format(d);
  } catch {
    return isoDate;
  }
}

async function sendMessage(env, chat_id, text, reply_markup = null) {
  const payload = { chat_id: String(chat_id), text, parse_mode: "HTML" };
  if (reply_markup) payload.reply_markup = reply_markup;
  return sendTelegramRequest(env, "sendMessage", payload);
}

async function sendTelegramRequest(env, method, payload) {
  return fetch(`[https://api.telegram.org/bot$](https://api.telegram.org/bot$){env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// --- Auto Setup Page (/setup) ---
function getSetupUI(origin) {
  return `<!DOCTYPE html>
  <html lang="fa" dir="rtl">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>راه‌اندازی خودکار ربات</title>
      <script src="[https://cdn.tailwindcss.com](https://cdn.tailwindcss.com)"></script>
      <style>
          @import url('[https://cdn.fontcdn.ir/Font/Persian/Vazir/Vazir.css](https://cdn.fontcdn.ir/Font/Persian/Vazir/Vazir.css)');
          body { font-family: 'Vazir', sans-serif; background: #020617; color: #fff; }
          .panel { background: rgba(255,255,255,0.04); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); }
          .btn { background: linear-gradient(135deg, #06b6d4, #3b82f6); }
      </style>
  </head>
  <body class="min-h-screen flex items-center justify-center p-5">
      <div class="panel p-7 rounded-[28px] w-full max-w-md flex flex-col gap-4 text-center shadow-2xl">
          <div class="text-5xl">⚙️</div>
          <h1 class="text-2xl font-black">راه‌اندازی یک‌کلیکه</h1>
          <p class="text-xs text-slate-400 leading-relaxed">این صفحه به صورت خودکار <b>جداول دیتابیس D1</b>، <b>Webhook</b>، <b>منوی دستورات</b> و <b>دکمه مینی‌اپ</b> را تنظیم می‌کند (بدون نیاز به ترمینال یا BotFather).</p>
          <div class="text-xs text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-xl p-2.5 break-all" dir="ltr">${origin}/webhook</div>
          <input type="text" id="adminId" placeholder="آیدی عددی ادمین (ADMIN_CHAT_ID)..." class="bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-sm text-center focus:outline-none focus:border-cyan-400">
          <button onclick="runSetup()" id="setupBtn" class="btn py-3.5 rounded-2xl font-bold text-sm transition active:scale-95">🚀 اجرای راه‌اندازی کامل</button>
          <div id="resultBox" class="hidden text-right text-xs bg-black/40 border border-white/10 rounded-2xl p-4 space-y-2 leading-relaxed"></div>
      </div>
      <script>
          async function runSetup() {
              const btn = document.getElementById("setupBtn");
              const box = document.getElementById("resultBox");
              const admin_id = document.getElementById("adminId").value.trim();
              btn.disabled = true; btn.innerText = "⏳ در حال ساخت دیتابیس و اتصال به تلگرام...";
              box.classList.add("hidden");
              try {
                  const res = await fetch("/setup", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ admin_id })
                  });
                  const data = await res.json();
                  box.classList.remove("hidden");
                  if (!res.ok || !data.ok) {
                      box.innerHTML = '<div class="text-rose-400 font-bold">❌ خطا: ' + (data.error || "نامشخص") + '</div>';
                  } else {
                      const r = data.report;
                      box.innerHTML =
                          '<div>' + (r.database?.ok ? "✅" : "❌") + ' <b>دیتابیس D1:</b> ' + (r.database?.description || "") + '</div>' +
                          '<div>' + (r.webhook?.ok ? "✅" : "❌") + ' <b>Webhook:</b> ' + (r.webhook?.description || "تنظیم شد") + '</div>' +
                          '<div>' + (r.commands?.ok ? "✅" : "❌") + ' <b>منوی دستورات:</b> ' + (r.commands?.ok ? "با موفقیت ثبت شد" : r.commands?.description) + '</div>' +
                          '<div>' + (r.menuButton?.ok ? "✅" : "❌") + ' <b>دکمه مینی‌اپ:</b> ' + (r.menuButton?.ok ? "فعال شد" : r.menuButton?.description) + '</div>' +
                          '<div class="pt-2 text-cyan-300 font-bold">🎉 همه چیز آماده است! به تلگرام برگردید.</div>';
                  }
              } catch (e) {
                  box.classList.remove("hidden");
                  box.innerHTML = '<div class="text-rose-400">❌ خطای شبکه</div>';
              }
              btn.disabled = false; btn.innerText = "🚀 اجرای راه‌اندازی کامل";
          }
      </script>
  </body>
  </html>`;
}

// --- Web & Mini App UI ---
function getHtmlUI(tz, hasPin, disableWebAuth) {
  return `<!DOCTYPE html>
  <html lang="fa" dir="rtl">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="theme-color" id="meta-theme-color" content="#020617">
      <link rel="icon" href="[https://cdn-icons-png.flaticon.com/512/1442/1442912.png](https://cdn-icons-png.flaticon.com/512/1442/1442912.png)" type="image/png">
      <link rel="manifest" href="/manifest.json">
      <title>Smart Planner</title>
      <script src="[https://cdn.tailwindcss.com](https://cdn.tailwindcss.com)"></script>
      <script src="[https://telegram.org/js/telegram-web-app.js](https://telegram.org/js/telegram-web-app.js)"></script>
      <link href="[https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap](https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap)" rel="stylesheet">
      <script src="[https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js](https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js)"></script>
      <style>
          @import url('[https://cdn.fontcdn.ir/Font/Persian/Vazir/Vazir.css](https://cdn.fontcdn.ir/Font/Persian/Vazir/Vazir.css)');

          body[data-theme="aurora"] {
              color-scheme: dark;
              --bg: #020617;
              --blob1: rgba(139, 92, 246, 0.25);
              --blob2: rgba(6, 182, 212, 0.22);
              --panel: rgba(255, 255, 255, 0.035);
              --panel-border: rgba(255, 255, 255, 0.09);
              --card: rgba(255, 255, 255, 0.045);
              --card-border: rgba(255, 255, 255, 0.07);
              --input-bg: rgba(0, 0, 0, 0.35);
              --text: #ffffff;
              --text-muted: rgba(255, 255, 255, 0.55);
              --text-done: rgba(255, 255, 255, 0.3);
              --accent: #06b6d4;
              --accent-2: #3b82f6;
              --accent-soft: rgba(6, 182, 212, 0.2);
              --accent-text: #67e8f9;
              --header-hex: #020617;
              --modal-bg: rgba(10, 15, 35, 0.92);
          }

          body[data-theme="day"] {
              color-scheme: light;
              --bg: #eef2f7;
              --blob1: rgba(56, 189, 248, 0.28);
              --blob2: rgba(99, 102, 241, 0.22);
              --panel: rgba(255, 255, 255, 0.78);
              --panel-border: rgba(15, 23, 42, 0.08);
              --card: rgba(255, 255, 255, 0.85);
              --card-border: rgba(15, 23, 42, 0.08);
              --input-bg: rgba(241, 245, 249, 0.95);
              --text: #0f172a;
              --text-muted: #64748b;
              --text-done: #94a3b8;
              --accent: #0284c7;
              --accent-2: #4f46e5;
              --accent-soft: rgba(2, 132, 199, 0.14);
              --accent-text: #0369a1;
              --header-hex: #eef2f7;
              --modal-bg: rgba(255, 255, 255, 0.96);
          }

          body[data-theme="midnight"] {
              color-scheme: dark;
              --bg: #000000;
              --blob1: rgba(168, 85, 247, 0.26);
              --blob2: rgba(236, 72, 153, 0.2);
              --panel: rgba(18, 18, 24, 0.72);
              --panel-border: rgba(192, 132, 252, 0.16);
              --card: rgba(255, 255, 255, 0.04);
              --card-border: rgba(192, 132, 252, 0.1);
              --input-bg: rgba(0, 0, 0, 0.65);
              --text: #fafafa;
              --text-muted: rgba(255, 255, 255, 0.5);
              --text-done: rgba(255, 255, 255, 0.28);
              --accent: #a855f7;
              --accent-2: #ec4899;
              --accent-soft: rgba(168, 85, 247, 0.22);
              --accent-text: #e879f9;
              --header-hex: #000000;
              --modal-bg: rgba(12, 8, 20, 0.95);
          }

          body {
              background-color: var(--bg);
              color: var(--text);
              overflow-x: hidden;
              -webkit-tap-highlight-color: transparent;
              transition: background-color 0.3s ease, color 0.3s ease;
          }

          .aurora-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
          .blob1 { position: absolute; top: -15%; left: -20%; width: 65vw; height: 65vw; background: radial-gradient(circle, var(--blob1) 0%, transparent 62%); filter: blur(55px); animation: float 12s infinite alternate ease-in-out; }
          .blob2 { position: absolute; bottom: -10%; right: -15%; width: 70vw; height: 70vw; background: radial-gradient(circle, var(--blob2) 0%, transparent 65%); filter: blur(60px); animation: float 15s infinite alternate-reverse ease-in-out; }
          @keyframes float { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(35px, 55px) scale(1.1); } }

          body.lang-en { font-family: 'Inter', sans-serif; direction: ltr; }
          body.lang-fa { font-family: 'Vazir', sans-serif; direction: rtl; }
          .hide-scrollbar::-webkit-scrollbar { display: none; }
          .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

          .glass-panel { background: var(--panel); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid var(--panel-border); box-shadow: 0 24px 50px -12px rgba(0,0,0,0.28); }
          .glass-input { background: var(--input-bg); border: 1px solid var(--panel-border); transition: all 0.25s ease; }
          .glass-input:focus-within { border-color: var(--accent); box-shadow: 0 0 18px var(--accent-soft); }
          .btn-glow { background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 22px var(--accent-soft); transition: transform 0.2s; color: #fff; }
          .btn-glow:active { transform: scale(0.92); }
          .icon-btn { background: var(--card); border: 1px solid var(--card-border); color: var(--text); transition: all 0.2s; }
          .icon-btn:active { transform: scale(0.92); }

          .task-card { background: var(--card); border: 1px solid var(--card-border); transition: all 0.25s; position: relative; overflow: hidden; }
          .pri-bar { position: absolute; top: 8px; bottom: 8px; width: 3.5px; border-radius: 99px; }
          [dir="rtl"] .pri-bar { right: 5px; }
          [dir="ltr"] .pri-bar { left: 5px; }

          .custom-check input:checked + div { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent; }
          .custom-check input:checked + div svg { opacity: 1; transform: scale(1); }

          .cat-btn { background: var(--card); border: 1px solid var(--card-border); color: var(--text-muted); transition: all 0.2s; white-space: nowrap; }
          .cat-btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-text); box-shadow: 0 0 14px var(--accent-soft); transform: scale(1.04); }

          .filter-pill { background: transparent; color: var(--text-muted); transition: all 0.2s; }
          .filter-pill.active { background: var(--accent-soft); color: var(--accent-text); }

          .date-btn { background: var(--card); border: 1px solid var(--card-border); color: var(--text-muted); }
          .date-btn.selected { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; border-color: transparent; box-shadow: 0 10px 22px var(--accent-soft); transform: scale(1.05); }

          input[type="time"]::-webkit-calendar-picker-indicator { opacity: 0; position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; }
          .time-wrapper { position: relative; display: flex; align-items: center; justify-content: center; min-width: 72px; }
          .time-empty { color: transparent !important; }

          .modal-box { background: var(--modal-bg); border: 1px solid var(--panel-border); backdrop-filter: blur(24px); }
          #celebration-popup { transition: opacity 0.45s, transform 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275); pointer-events: none; }
      </style>
  </head>
  <body data-theme="aurora" class="lang-fa min-h-screen flex flex-col items-center justify-start pt-5 pb-20">

      <div class="aurora-bg"><div class="blob1"></div><div class="blob2"></div></div>

      <div id="auth-screen" class="hidden fixed inset-0 z-50 flex items-center justify-center p-5" style="background: var(--bg);">
          <div class="aurora-bg"><div class="blob1"></div><div class="blob2"></div></div>
          <div class="glass-panel p-7 rounded-[30px] w-full max-w-sm flex flex-col gap-5 text-center">
              <div class="text-5xl">🔐</div>
              <div>
                  <h2 id="auth-title" class="text-2xl font-black mb-1">ورود به برنامه‌ریز</h2>
                  <p id="auth-desc" class="text-xs leading-relaxed" style="color: var(--text-muted);"></p>
              </div>
              <input type="password" id="authInput" class="glass-input w-full px-4 py-3.5 rounded-2xl text-sm text-center focus:outline-none" style="color: var(--text);" placeholder="پین یا کد /web...">
              <button onclick="submitLogin()" id="authBtn" class="btn-glow w-full py-3.5 rounded-2xl font-bold text-sm">ورود و ذخیره روی این دستگاه</button>
              <p id="authError" class="hidden text-xs text-rose-400 font-medium"></p>
          </div>
      </div>

      <div id="celebration-popup" class="fixed inset-0 flex items-center justify-center z-50 opacity-0 scale-90" style="backdrop-filter: blur(5px);">
          <div class="modal-box p-8 rounded-[32px] text-center max-w-[82%] shadow-2xl">
              <div class="text-6xl mb-4">🏆</div>
              <h2 id="cel-title" class="text-2xl font-black mb-2" style="color: var(--accent-text);">عالی بود!</h2>
              <p id="cel-desc" class="text-sm font-medium" style="color: var(--text-muted);">تمام کارهای این روز رو با موفقیت تموم کردی.</p>
          </div>
      </div>

      <div id="edit-modal" class="hidden fixed inset-0 z-40 flex items-center justify-center p-4" style="background: rgba(0,0,0,0.55); backdrop-filter: blur(6px);">
          <div class="modal-box p-6 rounded-[28px] w-full max-w-sm flex flex-col gap-4 shadow-2xl">
              <div class="flex justify-between items-center">
                  <h3 id="edit-modal-title" class="text-lg font-black">ویرایش کار</h3>
                  <button onclick="closeEditModal()" class="icon-btn px-2.5 py-1 rounded-xl text-xs font-bold">✕</button>
              </div>
              <input type="hidden" id="editId">
              <input type="text" id="editTitle" class="glass-input w-full px-4 py-3 rounded-2xl text-sm focus:outline-none" style="color: var(--text);">
              <div class="grid grid-cols-2 gap-2.5">
                  <div class="glass-input rounded-2xl px-3 py-2.5 flex items-center justify-between">
                      <span class="text-xs" style="color: var(--text-muted);">⏰</span>
                      <input type="time" id="editTime" class="bg-transparent text-sm focus:outline-none w-full text-center" style="color: var(--accent-text);">
                  </div>
                  <select id="editCategory" class="glass-input rounded-2xl px-3 py-2.5 text-xs font-bold focus:outline-none" style="color: var(--text);">
                      <option value="general">📌 عمومی</option>
                      <option value="work">💻 کاری</option>
                      <option value="sport">🏋️‍♂️ ورزشی</option>
                      <option value="shop">🛒 خرید</option>
                      <option value="learn">📚 یادگیری</option>
                  </select>
              </div>
              <div class="grid grid-cols-2 gap-2.5">
                  <select id="editPriority" class="glass-input rounded-2xl px-3 py-2.5 text-xs font-bold focus:outline-none" style="color: var(--text);">
                      <option value="normal">⚪ اولویت معمولی</option>
                      <option value="medium">🟡 مهم</option>
                      <option value="high">🔴 فوری</option>
                  </select>
                  <select id="editRepeat" class="glass-input rounded-2xl px-3 py-2.5 text-xs font-bold focus:outline-none" style="color: var(--text);">
                      <option value="none">بدون تکرار</option>
                      <option value="daily">🔁 هر روز</option>
                      <option value="weekly">🔁 هر هفته</option>
                  </select>
              </div>
              <button onclick="saveEdit()" id="saveEditBtn" class="btn-glow w-full py-3 rounded-2xl font-bold text-sm mt-1">ذخیره تغییرات</button>
          </div>
      </div>

      <div id="app-main" class="glass-panel p-5 rounded-[32px] w-[92%] max-w-md mx-auto relative z-10 flex flex-col gap-4">

          <div class="flex justify-between items-center gap-2">
              <h1 id="ui-title" class="text-2xl sm:text-3xl font-black tracking-tight">برنامه‌ها</h1>
              <div class="flex items-center gap-1.5">
                  <button onclick="installPWA()" id="install-btn" class="hidden btn-glow px-2.5 py-2 rounded-xl text-xs font-bold">📱</button>
                  <button onclick="cycleTheme()" id="theme-btn" class="icon-btn px-3 py-2 rounded-xl text-sm font-bold" title="Theme">🌌</button>
                  <button onclick="toggleLang()" id="lang-btn" class="icon-btn px-3 py-2 rounded-xl text-xs font-bold">🇬🇧 EN</button>
                  <button onclick="logoutWeb()" id="logout-btn" class="hidden icon-btn px-2.5 py-2 rounded-xl text-xs font-bold" title="Logout">🚪</button>
              </div>
          </div>

          <div>
              <div class="flex justify-between items-center mb-1.5 px-1">
                  <span id="ui-month" class="font-bold text-xs tracking-widest uppercase" style="color: var(--accent-text);"></span>
                  <div class="relative">
                      <input type="date" id="native-date" onchange="pickNativeDate(this.value)" class="opacity-0 absolute inset-0 w-full h-full cursor-pointer z-10">
                      <button class="icon-btn p-2 rounded-xl">
                          <svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5zM1 4v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4H1z"/></svg>
                      </button>
                  </div>
              </div>
              <div id="date-slider" class="flex gap-2.5 overflow-x-auto pb-5 pt-2 px-2 -mx-2 snap-x hide-scrollbar relative"></div>
          </div>

          <div id="rollover-banner" class="hidden flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-xs font-medium" style="background: var(--accent-soft); border: 1px solid var(--accent);">
              <span id="rollover-text"></span>
              <button onclick="doRollover()" id="rollover-btn" class="btn-glow px-3 py-1.5 rounded-xl text-xs font-bold">انتقال ↩️</button>
          </div>

          <div class="flex flex-col gap-2">
              <div class="flex gap-2 overflow-x-auto hide-scrollbar pb-3 pt-1 px-2 -mx-2" id="cat-selector">
                  <button onclick="selectCategory('general')" class="cat-btn active px-3 py-1.5 rounded-xl text-xs font-bold" id="cat-general">📌 عمومی</button>
                  <button onclick="selectCategory('work')" class="cat-btn px-3 py-1.5 rounded-xl text-xs font-bold" id="cat-work">💻 کاری</button>
                  <button onclick="selectCategory('sport')" class="cat-btn px-3 py-1.5 rounded-xl text-xs font-bold" id="cat-sport">🏋️‍♂️ ورزشی</button>
                  <button onclick="selectCategory('shop')" class="cat-btn px-3 py-1.5 rounded-xl text-xs font-bold" id="cat-shop">🛒 خرید</button>
                  <button onclick="selectCategory('learn')" class="cat-btn px-3 py-1.5 rounded-xl text-xs font-bold" id="cat-learn">📚 یادگیری</button>
              </div>

              <div class="flex gap-2">
                  <div class="flex flex-1 glass-input rounded-[20px] overflow-hidden p-1 items-center">
                      <input type="text" id="taskInput" class="w-full px-3.5 py-3 bg-transparent border-none text-sm font-medium focus:outline-none" style="color: var(--text);" placeholder="کار جدید...">
                      <div class="w-px h-6 mx-1" style="background: var(--panel-border);"></div>
                      <div class="time-wrapper px-2 py-2">
                          <svg id="timePlaceholderIcon" class="pointer-events-none absolute" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-text);">
                              <circle cx="12" cy="12" r="10"></circle>
                              <polyline points="12 6 12 12 16 14"></polyline>
                          </svg>
                          <input type="time" id="timeInput" oninput="syncTimeVisual()" onchange="syncTimeVisual()" class="time-empty bg-transparent border-none text-xs font-bold focus:outline-none w-[54px] text-center cursor-pointer" style="color: var(--accent-text);">
                      </div>
                  </div>
                  <button id="addBtn" onclick="addTask()" class="btn-glow w-[56px] rounded-[20px] font-black text-2xl flex items-center justify-center">+</button>
              </div>
          </div>

          <div id="progress-box" class="hidden flex flex-col gap-2.5 px-1">
              <div class="flex justify-between items-center text-xs font-bold">
                  <div class="flex gap-1">
                      <button onclick="setFilter('all')" id="flt-all" class="filter-pill active px-2.5 py-1 rounded-lg">همه</button>
                      <button onclick="setFilter('pending')" id="flt-pending" class="filter-pill px-2.5 py-1 rounded-lg">مانده</button>
                      <button onclick="setFilter('done')" id="flt-done" class="filter-pill px-2.5 py-1 rounded-lg">انجام‌شده</button>
                  </div>
                  <span id="progress-label" style="color: var(--accent-text);">0%</span>
              </div>
              <div class="w-full h-1.5 rounded-full overflow-hidden" style="background: var(--card-border);">
                  <div id="progress-fill" class="h-full rounded-full transition-all duration-500" style="width: 0%; background: linear-gradient(90deg, var(--accent), var(--accent-2));"></div>
              </div>
          </div>

          <div id="empty-state" class="hidden flex flex-col items-center justify-center py-7 opacity-70">
              <span class="text-5xl block mb-3">✨</span>
              <p id="ui-empty" class="font-medium text-sm" style="color: var(--text-muted);"></p>
          </div>

          <ul id="taskList" class="space-y-2.5 pb-2"></ul>
      </div>

      <script>
          const APP_TZ = "${tz}";
          const HAS_PIN = ${hasPin ? "true" : "false"};
          const DISABLE_WEB_AUTH = ${disableWebAuth ? "true" : "false"};
          const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
          const isTelegramApp = Boolean(tg && tg.initData && tg.initData.length > 0);

          if (tg) { tg.expand(); tg.ready(); }

          const urlParams = new URLSearchParams(window.location.search);
          if (urlParams.has("token")) {
              localStorage.setItem("planner_token", urlParams.get("token"));
              window.history.replaceState({}, "", "/");
          }

          let selectedCategory = "general";
          let currentFilter = "all";
          let allDayTasks = [];
          let deferredPrompt = null;
          let selectedDate = new Date();

          const themes = ["aurora", "day", "midnight"];
          const themeIcons = { aurora: "🌌", day: "☀️", midnight: "🔮" };
          let currentTheme = localStorage.getItem("appTheme") || "aurora";
          if (!themes.includes(currentTheme)) currentTheme = "aurora";

          let currentLang = localStorage.getItem("appLang") || "fa";

          const i18n = {
              en: {
                  title: "Dashboard", placeholder: "New task...", empty: "Clear schedule! ✨", langBtn: "🇮🇷 FA",
                  locale: "en-US", dir: "ltr", celTitle: "Awesome!", celDesc: "All tasks for this day are completed!",
                  fltAll: "All", fltPending: "Todo", fltDone: "Done", editTitle: "Edit Task", saveEdit: "Save Changes",
                  rolloverText: n => n + " unfinished from yesterday", rolloverBtn: "Move ↩️",
                  authTitle: "One-Time Sign In", authBtn: "Sign In & Remember Device",
                  authDesc: HAS_PIN ? "Enter your Web PIN or token from /web once. You stay signed in automatically." : "Send /web in Telegram and paste the token once. You stay signed in automatically.",
                  authErr: "Invalid PIN or expired token.",
                  cats: { general: "📌 Gen", work: "💻 Work", sport: "🏋️‍♂️ Sport", shop: "🛒 Shop", learn: "📚 Learn" }
              },
              fa: {
                  title: "برنامه‌ها", placeholder: "کار جدید...", empty: "هیچ کاری برای این روز نیست ✨", langBtn: "🇬🇧 EN",
                  locale: "fa-IR", dir: "rtl", celTitle: "عالی بود!", celDesc: "تمام کارهای این روز رو با موفقیت تموم کردی.",
                  fltAll: "همه", fltPending: "مانده", fltDone: "انجام‌شده", editTitle: "ویرایش کار", saveEdit: "ذخیره تغییرات",
                  rolloverText: n => n + " کار ناتمام از دیروز مونده", rolloverBtn: "انتقال به امروز ↩️",
                  authTitle: "ورود یک‌باره به برنامه‌ریز", authBtn: "ورود و ذخیره روی این دستگاه",
                  authDesc: HAS_PIN ? "فقط همین یک بار پین یا کد /web را وارد کنید؛ بعد از آن بدون رمز باز می‌شود." : "در ربات تلگرام دستور /web را بزنید و کد را فقط یک بار وارد کنید؛ بعد از آن بدون رمز باز می‌شود.",
                  authErr: "رمز یا توکن نامعتبر است.",
                  cats: { general: "📌 عمومی", work: "💻 کاری", sport: "🏋️‍♂️ ورزشی", shop: "🛒 خرید", learn: "📚 یادگیری" }
              }
          };

          function getAuthHeaders() {
              const h = { "Content-Type": "application/json" };
              if (isTelegramApp) {
                  h["X-Telegram-Init-Data"] = tg.initData;
              } else {
                  const tk = localStorage.getItem("planner_token");
                  if (tk) h["Authorization"] = "Bearer " + tk;
              }
              return h;
          }

          function handleTokenRefresh(res) {
              const fresh = res.headers.get("X-Refreshed-Token");
              if (fresh) localStorage.setItem("planner_token", fresh);
          }

          function showAuthScreen(show) {
              document.getElementById("auth-screen").classList.toggle("hidden", !show);
              document.getElementById("app-main").classList.toggle("hidden", show);
              if (!isTelegramApp && !DISABLE_WEB_AUTH && !show) {
                  document.getElementById("logout-btn").classList.remove("hidden");
              } else {
                  document.getElementById("logout-btn").classList.add("hidden");
              }
          }

          async function submitLogin() {
              const cred = document.getElementById("authInput").value.trim();
              const errEl = document.getElementById("authError");
              errEl.classList.add("hidden");
              if (!cred) return;

              const res = await fetch("/api/auth/login", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ credential: cred })
              });
              if (!res.ok) {
                  errEl.innerText = i18n[currentLang].authErr;
                  errEl.classList.remove("hidden");
                  return;
              }
              const data = await res.json();
              localStorage.setItem("planner_token", data.token);
              document.getElementById("authInput").value = "";
              showAuthScreen(false);
              loadTasks();
          }

          function logoutWeb() {
              localStorage.removeItem("planner_token");
              showAuthScreen(true);
          }

          function applyTheme() {
              document.body.setAttribute("data-theme", currentTheme);
              document.getElementById("theme-btn").innerText = themeIcons[currentTheme];
              const hex = getComputedStyle(document.body).getPropertyValue("--header-hex").trim() || "#020617";
              document.getElementById("meta-theme-color").setAttribute("content", hex);
              if (tg && tg.setHeaderColor) {
                  try { tg.setHeaderColor(hex); tg.setBackgroundColor(hex); } catch {}
              }
          }

          function cycleTheme() {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
              const idx = (themes.indexOf(currentTheme) + 1) % themes.length;
              currentTheme = themes[idx];
              localStorage.setItem("appTheme", currentTheme);
              applyTheme();
          }

          function syncTimeVisual() {
              const inp = document.getElementById("timeInput");
              const icon = document.getElementById("timePlaceholderIcon");
              if (inp.value) {
                  inp.classList.remove("time-empty");
                  icon.classList.add("hidden");
              } else {
                  inp.classList.add("time-empty");
                  icon.classList.remove("hidden");
              }
          }

          window.addEventListener("beforeinstallprompt", e => {
              e.preventDefault();
              deferredPrompt = e;
              document.getElementById("install-btn").classList.remove("hidden");
          });

          async function installPWA() {
              if (!deferredPrompt) return;
              deferredPrompt.prompt();
              const { outcome } = await deferredPrompt.userChoice;
              if (outcome === "accepted") document.getElementById("install-btn").classList.add("hidden");
              deferredPrompt = null;
          }

          function selectCategory(cat) {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
              selectedCategory = cat;
              document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
              document.getElementById("cat-" + cat).classList.add("active");
          }

          function setFilter(f) {
              currentFilter = f;
              document.querySelectorAll(".filter-pill").forEach(b => b.classList.remove("active"));
              document.getElementById("flt-" + f).classList.add("active");
              renderTaskList();
          }

          function applyLanguage() {
              const d = i18n[currentLang];
              document.documentElement.lang = currentLang;
              document.documentElement.dir = d.dir;
              document.body.className = "lang-" + currentLang + " min-h-screen flex flex-col items-center justify-start pt-5 pb-20";
              document.getElementById("ui-title").innerText = d.title;
              document.getElementById("taskInput").placeholder = d.placeholder;
              document.getElementById("ui-empty").innerText = d.empty;
              document.getElementById("lang-btn").innerText = d.langBtn;
              document.getElementById("cel-title").innerText = d.celTitle;
              document.getElementById("cel-desc").innerText = d.celDesc;
              document.getElementById("flt-all").innerText = d.fltAll;
              document.getElementById("flt-pending").innerText = d.fltPending;
              document.getElementById("flt-done").innerText = d.fltDone;
              document.getElementById("edit-modal-title").innerText = d.editTitle;
              document.getElementById("saveEditBtn").innerText = d.saveEdit;
              document.getElementById("rollover-btn").innerText = d.rolloverBtn;
              document.getElementById("auth-title").innerText = d.authTitle;
              document.getElementById("auth-desc").innerText = d.authDesc;
              document.getElementById("authBtn").innerText = d.authBtn;

              for (const k in d.cats) {
                  const btn = document.getElementById("cat-" + k);
                  if (btn) btn.innerText = d.cats[k];
              }
              applyTheme();
              renderDateSlider();
          }

          function toggleLang() {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
              currentLang = currentLang === "en" ? "fa" : "en";
              localStorage.setItem("appLang", currentLang);
              applyLanguage();
              renderTaskList();
          }

          function getDbDateString(dObj) {
              const fmt = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
              const p = fmt.formatToParts(dObj);
              return p.find(x => x.type === "year").value + "-" + p.find(x => x.type === "month").value + "-" + p.find(x => x.type === "day").value;
          }

          function renderDateSlider() {
              const slider = document.getElementById("date-slider");
              slider.innerHTML = "";
              document.getElementById("ui-month").innerText = new Intl.DateTimeFormat(i18n[currentLang].locale, { month: "long", year: "numeric" }).format(selectedDate);
              const selStr = getDbDateString(selectedDate);
              const today = new Date();

              for (let i = -2; i <= 14; i++) {
                  const d = new Date(today);
                  d.setDate(today.getDate() + i);
                  const dStr = getDbDateString(d);
                  const isSel = dStr === selStr;
                  const dayNum = new Intl.DateTimeFormat(i18n[currentLang].locale, { day: "numeric" }).format(d);
                  const weekday = new Intl.DateTimeFormat(i18n[currentLang].locale, { weekday: "short" }).format(d);

                  const btn = document.createElement("button");
                  btn.className = "date-btn flex flex-col items-center justify-center min-w-[60px] h-[76px] rounded-[20px] snap-center transition-all duration-300 " + (isSel ? "selected" : "");
                  btn.onclick = () => {
                      if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
                      selectedDate = d;
                      renderDateSlider();
                      loadTasks();
                      btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                  };
                  btn.innerHTML = '<span class="text-[11px] font-medium uppercase mb-1 opacity-80">' + weekday + '</span><span class="text-xl font-black">' + dayNum + '</span>';
                  slider.appendChild(btn);
                  if (isSel) setTimeout(() => btn.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" }), 80);
              }
          }

          function pickNativeDate(val) {
              if (!val) return;
              selectedDate = new Date(val + "T12:00:00");
              renderDateSlider();
              loadTasks();
          }

          function escapeHTML(str) {
              return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          }

          async function loadTasks() {
              if (!isTelegramApp && !DISABLE_WEB_AUTH && !localStorage.getItem("planner_token")) {
                  showAuthScreen(true);
                  return;
              }
              const targetDateStr = getDbDateString(selectedDate);
              const res = await fetch("/api/tasks?date=" + targetDateStr + "&t=" + Date.now(), { headers: getAuthHeaders() });
              handleTokenRefresh(res);

              if (res.status === 401) {
                  localStorage.removeItem("planner_token");
                  showAuthScreen(true);
                  return;
              }
              if (!res.ok) return;

              showAuthScreen(false);
              const data = await res.json();
              allDayTasks = data.tasks || [];

              const rBanner = document.getElementById("rollover-banner");
              if (data.yesterdayPending > 0) {
                  document.getElementById("rollover-text").innerText = i18n[currentLang].rolloverText(data.yesterdayPending);
                  rBanner.classList.remove("hidden");
              } else {
                  rBanner.classList.add("hidden");
              }

              renderTaskList();
          }

          function renderTaskList() {
              const list = document.getElementById("taskList");
              const emptyState = document.getElementById("empty-state");
              const progBox = document.getElementById("progress-box");
              list.innerHTML = "";

              const total = allDayTasks.length;
              const doneCount = allDayTasks.filter(t => t.is_completed).length;

              if (total > 0) {
                  progBox.classList.remove("hidden");
                  const pct = Math.round((doneCount / total) * 100);
                  document.getElementById("progress-label").innerText = doneCount + "/" + total + " • " + pct + "%";
                  document.getElementById("progress-fill").style.width = pct + "%";
              } else {
                  progBox.classList.add("hidden");
              }

              const filtered = allDayTasks.filter(t => {
                  if (currentFilter === "pending") return !t.is_completed;
                  if (currentFilter === "done") return !!t.is_completed;
                  return true;
              });

              if (filtered.length === 0) {
                  emptyState.classList.remove("hidden");
                  return;
              }
              emptyState.classList.add("hidden");

              const marginClass = currentLang === "fa" ? "mr-3" : "ml-3";
              filtered.forEach(task => {
                  const li = document.createElement("li");
                  li.className = "task-card flex items-center justify-between p-3.5 rounded-[18px]";
                  const catText = i18n[currentLang].cats[task.category] || i18n[currentLang].cats.general;
                  const catEmoji = catText.split(" ")[0];
                  const priColor = task.priority === "high" ? "#f43f5e" : (task.priority === "medium" ? "#f59e0b" : "transparent");
                  const repBadge = task.repeat_type && task.repeat_type !== "none" ? '<span class="text-xs opacity-75">🔁</span>' : "";
                  const timeBadge = task.reminder_time ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-md" style="background:var(--accent-soft);color:var(--accent-text);">' + task.reminder_time + '</span>' : "";

                  li.innerHTML =
                      '<div class="pri-bar" style="background:' + priColor + '"></div>' +
                      '<label class="custom-check relative flex items-center cursor-pointer flex-1 min-w-0 px-1">' +
                          '<input type="checkbox" ' + (task.is_completed ? "checked" : "") + ' onchange="toggleTask(' + task.id + ', this.checked)" class="peer sr-only">' +
                          '<div class="w-[22px] h-[22px] shrink-0 rounded-lg border-2 flex items-center justify-center transition-all duration-300" style="border-color:var(--panel-border);">' +
                              '<svg class="w-3.5 h-3.5 text-white opacity-0 scale-50 transition-all duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' +
                          '</div>' +
                          '<span class="' + marginClass + ' font-medium text-[14px] truncate ' + (task.is_completed ? "line-through" : "") + '" style="color:' + (task.is_completed ? "var(--text-done)" : "var(--text)") + ';">' + escapeHTML(task.title) + '</span>' +
                      '</label>' +
                      '<div class="flex items-center gap-1.5 shrink-0">' +
                          repBadge +
                          '<span class="text-sm opacity-85">' + catEmoji + '</span>' +
                          timeBadge +
                          '<button onclick="openEditModal(' + task.id + ')" class="icon-btn p-1.5 rounded-lg opacity-70 hover:opacity-100">' +
                              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
                          '</button>' +
                          '<button onclick="deleteTask(' + task.id + ')" class="icon-btn p-1.5 rounded-lg opacity-60 hover:text-rose-400 hover:opacity-100">' +
                              '<svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6Z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1ZM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118ZM2.5 3h11V2h-11v1Z"/></svg>' +
                          '</button>' +
                      '</div>';
                  list.appendChild(li);
              });
          }

          async function addTask() {
              const titleInput = document.getElementById("taskInput");
              const timeInput = document.getElementById("timeInput");
              const btn = document.getElementById("addBtn");
              const title = titleInput.value.trim();
              if (!title) return;

              if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");
              btn.innerText = "⏳";
              btn.style.opacity = "0.7";

              const res = await fetch("/api/tasks", {
                  method: "POST",
                  headers: getAuthHeaders(),
                  body: JSON.stringify({
                      title,
                      reminder_time: timeInput.value || null,
                      date: getDbDateString(selectedDate),
                      category: selectedCategory,
                      priority: "normal",
                      repeat_type: "none"
                  })
              });
              handleTokenRefresh(res);

              btn.innerText = "+";
              btn.style.opacity = "1";
              if (res.status === 401) { showAuthScreen(true); return; }
              if (res.ok) {
                  titleInput.value = "";
                  timeInput.value = "";
                  syncTimeVisual();
                  loadTasks();
              }
          }

          function openEditModal(id) {
              const task = allDayTasks.find(t => t.id === id);
              if (!task) return;
              document.getElementById("editId").value = task.id;
              document.getElementById("editTitle").value = task.title;
              document.getElementById("editTime").value = task.reminder_time || "";
              document.getElementById("editCategory").value = task.category || "general";
              document.getElementById("editPriority").value = task.priority || "normal";
              document.getElementById("editRepeat").value = task.repeat_type || "none";
              document.getElementById("edit-modal").classList.remove("hidden");
          }

          function closeEditModal() {
              document.getElementById("edit-modal").classList.add("hidden");
          }

          async function saveEdit() {
              const id = Number(document.getElementById("editId").value);
              const title = document.getElementById("editTitle").value.trim();
              if (!title) return;

              const res = await fetch("/api/tasks/edit", {
                  method: "POST",
                  headers: getAuthHeaders(),
                  body: JSON.stringify({
                      id,
                      title,
                      reminder_time: document.getElementById("editTime").value || null,
                      category: document.getElementById("editCategory").value,
                      priority: document.getElementById("editPriority").value,
                      repeat_type: document.getElementById("editRepeat").value
                  })
              });
              handleTokenRefresh(res);
              closeEditModal();
              loadTasks();
          }

          async function doRollover() {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");
              const res = await fetch("/api/tasks/rollover", { method: "POST", headers: getAuthHeaders() });
              handleTokenRefresh(res);
              loadTasks();
          }

          function triggerCelebration() {
              const popup = document.getElementById("celebration-popup");
              popup.classList.remove("opacity-0", "scale-90");
              popup.classList.add("opacity-100", "scale-100");
              const end = Date.now() + 2800;
              (function frame() {
                  confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 }, colors: ["#06b6d4", "#3b82f6", "#a855f7"] });
                  confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 }, colors: ["#06b6d4", "#3b82f6", "#ec4899"] });
                  if (Date.now() < end) requestAnimationFrame(frame);
              })();
              setTimeout(() => {
                  popup.classList.remove("opacity-100", "scale-100");
                  popup.classList.add("opacity-0", "scale-90");
              }, 3200);
          }

          async function toggleTask(id, is_completed) {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
              const res = await fetch("/api/tasks/toggle", {
                  method: "POST",
                  headers: getAuthHeaders(),
                  body: JSON.stringify({ id, is_completed, date: getDbDateString(selectedDate) })
              });
              handleTokenRefresh(res);
              if (res.ok) {
                  const data = await res.json();
                  if (data.allCompleted) {
                      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
                      triggerCelebration();
                  }
                  loadTasks();
              }
          }

          async function deleteTask(id) {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("warning");
              const res = await fetch("/api/tasks/delete", {
                  method: "POST",
                  headers: getAuthHeaders(),
                  body: JSON.stringify({ id })
              });
              handleTokenRefresh(res);
              loadTasks();
          }

          document.getElementById("taskInput").addEventListener("keydown", e => { if (e.key === "Enter") addTask(); });
          document.getElementById("authInput").addEventListener("keydown", e => { if (e.key === "Enter") submitLogin(); });

          applyLanguage();
          syncTimeVisual();
          loadTasks();
      </script>
  </body>
  </html>`;
}
