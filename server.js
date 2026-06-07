require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const { Telegraf, Markup } = require("telegraf");

// ─── Env ────────────────────────────────────────────────────────────────────
const {
  BOT_TOKEN,
  BOT_ADMIN_ID,
  MONGODB_URI,
  PORT = 3000,
  MINIAPP_URL = "http://localhost:5173",
  MOCK_DATA = "false",
} = process.env;

const IS_MOCK = MOCK_DATA === "true";

if (!BOT_TOKEN) {
  console.error("❌  BOT_TOKEN missing");
  process.exit(1);
}
if (!BOT_ADMIN_ID) {
  console.error("❌  BOT_ADMIN_ID missing");
  process.exit(1);
}
if (!IS_MOCK && !MONGODB_URI) {
  console.error("❌  MONGODB_URI missing");
  process.exit(1);
}

if (IS_MOCK)
  console.log("🎭  MOCK_DATA=true — running with fake data, no DB required");

// ─── Mongoose Models ─────────────────────────────────────────────────────────
let Subscriber, Admin, Channel;

const subscriberSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    username: { type: String, default: null },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    channelId: { type: Number, default: null }, // which channel they joined
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

const adminSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: { type: String, default: null },
  firstName: { type: String, default: "" },
  addedBy: { type: Number, default: null },
  addedAt: { type: Date, default: Date.now },
});

// status: 'pending' | 'active' | 'declined'
const channelSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  title: { type: String, default: "" },
  username: { type: String, default: null }, // @handle if public
  type: { type: String, default: "channel" },
  status: {
    type: String,
    default: "pending",
    enum: ["pending", "active", "declined"],
  },
  addedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: Number, default: null },
});

// ─── Mock Data ───────────────────────────────────────────────────────────────
function generateMockSubscribers(count = 180) {
  const firstNames = [
    "Ahmed",
    "Lena",
    "Carlos",
    "Yuki",
    "Fatima",
    "Arjun",
    "Sofia",
    "Kwame",
    "Mia",
    "Dmitri",
    "Amara",
    "Lucas",
    "Zara",
    "Hiro",
    "Elena",
    "Omar",
    "Priya",
    "Marco",
    "Aisha",
    "Felix",
    "Nadia",
    "Raj",
    "Ingrid",
    "Kofi",
    "Sara",
    "Bruno",
    "Mei",
    "Aleksei",
    "Layla",
    "Tobias",
  ];
  const lastNames = [
    "Hassan",
    "Mueller",
    "Lopez",
    "Tanaka",
    "Al-Rashid",
    "Patel",
    "Rossi",
    "Asante",
    "Chen",
    "Volkov",
    "Diallo",
    "Silva",
    "Ahmed",
    "Nakamura",
    "Popescu",
    "Khalil",
    "Sharma",
    "Bianchi",
    "Ibrahim",
    "Wagner",
  ];
  const usernames = [
    "dev_",
    "code_",
    "tech_",
    "pro_",
    "real_",
    "the_",
    "mr_",
    "mz_",
    "just_",
    "its_",
  ];
  const now = Date.now();
  const yearMs = 365 * 24 * 3600000;
  return Array.from({ length: count }, (_, i) => {
    const fn = firstNames[i % firstNames.length];
    const ln = lastNames[i % lastNames.length];
    return {
      _id: `mock_${i}`,
      telegramId: 100000000 + i * 7 + Math.floor(Math.random() * 100),
      username:
        Math.random() > 0.3
          ? usernames[i % usernames.length] + fn.toLowerCase() + (i % 99)
          : null,
      firstName: fn,
      lastName: ln,
      joinedAt: new Date(now - Math.random() * yearMs * 1.17),
    };
  }).sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
}

function computeMockStats(subs) {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = subs.filter((s) => new Date(s.joinedAt) >= today).length;
  const weekCount = subs.filter(
    (s) => new Date(s.joinedAt) >= new Date(now - 7 * 86400000),
  ).length;
  const monthCount = subs.filter(
    (s) => new Date(s.joinedAt) >= new Date(now - 30 * 86400000),
  ).length;
  const buckets = {};
  subs.forEach((s) => {
    const d = new Date(s.joinedAt);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    if (!buckets[key])
      buckets[key] = {
        _id: { year: d.getFullYear(), month: d.getMonth() + 1 },
        count: 0,
      };
    buckets[key].count++;
  });
  const growth = Object.values(buckets)
    .sort((a, b) =>
      a._id.year !== b._id.year
        ? a._id.year - b._id.year
        : a._id.month - b._id.month,
    )
    .slice(-12);
  return { total: subs.length, todayCount, weekCount, monthCount, growth };
}

// ─── DB Connect ──────────────────────────────────────────────────────────────
async function connectDB() {
  console.log("🔌  Connecting to MongoDB (AffiwiseChannelAnalytics)…");
  await mongoose.connect(MONGODB_URI, { dbName: "AffiwiseChannelAnalytics" });
  Subscriber = mongoose.model("Subscriber", subscriberSchema);
  Admin = mongoose.model("Admin", adminSchema);
  Channel = mongoose.model("Channel", channelSchema);
  console.log("✅  MongoDB connected — db: AffiwiseChannelAnalytics");
}

async function ensureBootstrapAdmin() {
  const id = Number(BOT_ADMIN_ID);
  const exists = await Admin.findOne({ telegramId: id });
  if (!exists) {
    await Admin.create({
      telegramId: id,
      username: "bootstrap",
      firstName: "Owner",
      addedBy: null,
    });
    console.log(`👑  Bootstrap admin seeded: ${id}`);
  }
}

async function isAdmin(telegramId) {
  if (IS_MOCK) return true
  return !!(await Admin.findOne({ telegramId: Number(telegramId) }));
}

// ─── Express + HTTP + WS ─────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on("connection", (ws) => {
  console.log("🔗  WebSocket client connected");
  ws.on("close", () => console.log("🔌  WebSocket client disconnected"));
});

// ─── REST Routes ─────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.json({ message: "hello world" }));

app.get("/api/subscribers", async (_req, res) => {
  try {
    if (IS_MOCK)
      return res.json({
        success: true,
        data: generateMockSubscribers(180),
        mock: true,
      });
    const data = await Subscriber.find().sort({ joinedAt: -1 });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    if (IS_MOCK) {
      const subs = generateMockSubscribers(180);
      return res.json({
        success: true,
        data: computeMockStats(subs),
        mock: true,
      });
    }
    const total = await Subscriber.countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await Subscriber.countDocuments({
      joinedAt: { $gte: today },
    });
    const weekCount = await Subscriber.countDocuments({
      joinedAt: { $gte: new Date(Date.now() - 7 * 86400000) },
    });
    const monthCount = await Subscriber.countDocuments({
      joinedAt: { $gte: new Date(Date.now() - 30 * 86400000) },
    });
    const growth = await Subscriber.aggregate([
      {
        $group: {
          _id: { year: { $year: "$joinedAt" }, month: { $month: "$joinedAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
      { $limit: 12 },
    ]);
    res.json({
      success: true,
      data: { total, todayCount, weekCount, monthCount, growth },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/channels", async (_req, res) => {
  try {
    if (IS_MOCK) return res.json({ success: true, data: [] });
    const data = await Channel.find().sort({ addedAt: -1 });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Bot ─────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ── Admin guard ──
async function adminOnly(ctx, next) {
  if (!(await isAdmin(ctx.from?.id)))
    return ctx.reply("⛔ You are not authorized.");
  return next();
}

// ── Channel name helper ──
function channelLabel(ch) {
  return ch.username
    ? `${ch.title} (@${ch.username})`
    : `${ch.title} [${ch.chatId}]`;
}

// ── Status emoji ──
function statusEmoji(s) {
  return s === "active" ? "✅" : s === "declined" ? "❌" : "⏳";
}

// ── Main menu ──
function mainMenu(name) {
  return {
    text: `📡 *Affiwise Channel Analytics*\n\nHey *${name}*! What would you like to do?`,
    opts: {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("📊 View Analytics Dashboard", MINIAPP_URL)],
        [
          Markup.button.callback("📈 Quick Stats", "stats"),
          Markup.button.callback("📡 Channels", "channels"),
        ],
        [Markup.button.callback("👮 Manage Admins", "admins")],
      ]),
    },
  };
}

function backBtn(label = "← Back to Menu", action = "main") {
  return Markup.button.callback(label, action);
}

// ── /start ──
bot.start(adminOnly, async (ctx) => {
  const { text, opts } = mainMenu(ctx.from.first_name || "there");
  await ctx.reply(text, opts);
});

// ── main menu ──
bot.action("main", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  const { text, opts } = mainMenu(ctx.from.first_name || "there");
  await ctx.editMessageText(text, opts);
});

// ── ping ──
bot.action("ping", adminOnly, async (ctx) => {
  await ctx.answerCbQuery("🏓 pong!");
  await ctx.editMessageText("🏓 *pong!*\n\nServer is alive and well.", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[backBtn()]]),
  });
});

// ── stats ──
bot.action("stats", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  let text;
  if (IS_MOCK) {
    const s = computeMockStats(generateMockSubscribers(180));
    text = `📈 *Channel Stats* _(mock)_\n\n👥 Total: *${s.total}*\n📅 Today: *${s.todayCount}*\n📊 Last 7 days: *${s.weekCount}*\n🗓 Last 30 days: *${s.monthCount}*`;
  } else {
    const total = await Subscriber.countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await Subscriber.countDocuments({
      joinedAt: { $gte: today },
    });
    const weekCount = await Subscriber.countDocuments({
      joinedAt: { $gte: new Date(Date.now() - 7 * 86400000) },
    });
    const monthCount = await Subscriber.countDocuments({
      joinedAt: { $gte: new Date(Date.now() - 30 * 86400000) },
    });
    text = `📈 *Channel Stats*\n\n👥 Total: *${total}*\n📅 Today: *${todayCount}*\n📊 Last 7 days: *${weekCount}*\n🗓 Last 30 days: *${monthCount}*`;
  }
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[backBtn()]]),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── CHANNELS MENU ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

bot.action("channels", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("📡 *Channel Management*\n\nChoose an action:", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📋 List All Channels", "channels_list")],
      [Markup.button.callback("⏳ Pending Approval", "channels_pending")],
      [backBtn()],
    ]),
  });
});

// ── List all channels ──
bot.action("channels_list", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();

  if (IS_MOCK) {
    return ctx.editMessageText(
      "📋 *All Channels*\n\n_Mock mode — no channels in DB._",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[backBtn("← Back", "channels")]]),
      },
    );
  }

  const channels = await Channel.find().sort({ addedAt: -1 });
  if (!channels.length) {
    return ctx.editMessageText(
      "📋 *All Channels*\n\nNo channels yet. Add the bot as admin to a channel to get started.",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[backBtn("← Back", "channels")]]),
      },
    );
  }

  const lines = channels.map(
    (ch) =>
      `${statusEmoji(ch.status)} *${ch.title}*\n   ID: \`${ch.chatId}\`${ch.username ? ` · @${ch.username}` : ""} · _${ch.status}_`,
  );

  // Build action buttons for each channel
  const buttons = channels.map((ch) => [
    Markup.button.callback(
      `${statusEmoji(ch.status)} ${ch.title.slice(0, 28)}`,
      `ch_detail_${ch.chatId}`,
    ),
  ]);
  buttons.push([backBtn("← Back", "channels")]);

  await ctx.editMessageText(
    `📋 *All Channels (${channels.length})*\n\n${lines.join("\n\n")}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
});

// ── Pending channels ──
bot.action("channels_pending", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();

  if (IS_MOCK) {
    return ctx.editMessageText(
      "⏳ *Pending Approval*\n\n_Mock mode — no pending channels._",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[backBtn("← Back", "channels")]]),
      },
    );
  }

  const pending = await Channel.find({ status: "pending" }).sort({
    addedAt: -1,
  });
  if (!pending.length) {
    return ctx.editMessageText(
      "⏳ *Pending Approval*\n\nNo channels waiting for approval.",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[backBtn("← Back", "channels")]]),
      },
    );
  }

  const buttons = pending.map((ch) => [
    Markup.button.callback(
      `⏳ ${ch.title.slice(0, 30)}`,
      `ch_detail_${ch.chatId}`,
    ),
  ]);
  buttons.push([backBtn("← Back", "channels")]);

  const lines = pending.map(
    (ch) =>
      `⏳ *${ch.title}*\n   ID: \`${ch.chatId}\`${ch.username ? ` · @${ch.username}` : ""}`,
  );

  await ctx.editMessageText(
    `⏳ *Pending Approval (${pending.length})*\n\n${lines.join("\n\n")}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
});

// ── Channel detail (dynamic action matching) ──
bot.action(/^ch_detail_(-?\d+)$/, adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const ch = await Channel.findOne({ chatId });

  if (!ch) {
    return ctx.editMessageText("⚠️ Channel not found.", {
      ...Markup.inlineKeyboard([[backBtn("← Back", "channels_list")]]),
    });
  }

  const info = [
    `📡 *${ch.title}*`,
    ``,
    `ID: \`${ch.chatId}\``,
    ch.username ? `Handle: @${ch.username}` : null,
    `Type: ${ch.type}`,
    `Status: ${statusEmoji(ch.status)} *${ch.status}*`,
    `Added: ${new Date(ch.addedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
    ch.resolvedAt
      ? `Resolved: ${new Date(ch.resolvedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const buttons = [];
  if (ch.status !== "active")
    buttons.push(
      Markup.button.callback("✅ Approve", `ch_approve_${ch.chatId}`),
    );
  if (ch.status !== "declined")
    buttons.push(
      Markup.button.callback("❌ Decline", `ch_decline_${ch.chatId}`),
    );

  await ctx.editMessageText(info, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(
      [buttons, [backBtn("← Back to Channels", "channels_list")]].filter(
        (r) => r.length,
      ),
    ),
  });
});

// ── Approve channel ──
bot.action(/^ch_approve_(-?\d+)$/, adminOnly, async (ctx) => {
  await ctx.answerCbQuery("✅ Channel approved!");
  const chatId = Number(ctx.match[1]);
  const ch = await Channel.findOneAndUpdate(
    { chatId },
    { status: "active", resolvedAt: new Date(), resolvedBy: ctx.from.id },
    { new: true },
  );
  if (!ch) return ctx.editMessageText("⚠️ Channel not found.");

  console.log(
    `✅  Channel approved: ${ch.title} (${chatId}) by ${ctx.from.id}`,
  );

  await ctx.editMessageText(
    `✅ *${ch.title}* has been *approved*.\n\nThe bot will now track subscriber joins for this channel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [backBtn("← Back to Channels", "channels_list")],
      ]),
    },
  );
});

// ── Decline channel ──
bot.action(/^ch_decline_(-?\d+)$/, adminOnly, async (ctx) => {
  await ctx.answerCbQuery("❌ Channel declined.");
  const chatId = Number(ctx.match[1]);
  const ch = await Channel.findOneAndUpdate(
    { chatId },
    { status: "declined", resolvedAt: new Date(), resolvedBy: ctx.from.id },
    { new: true },
  );
  if (!ch) return ctx.editMessageText("⚠️ Channel not found.");

  console.log(
    `❌  Channel declined: ${ch.title} (${chatId}) by ${ctx.from.id}`,
  );

  await ctx.editMessageText(
    `❌ *${ch.title}* has been *declined*.\n\nJoin events from this channel will be ignored.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [backBtn("← Back to Channels", "channels_list")],
      ]),
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ── DETECT BOT ADDED TO / REMOVED FROM CHANNEL ───────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

bot.on("my_chat_member", async (ctx) => {
  if (IS_MOCK) return;

  const update = ctx.myChatMember;
  if (!update) return;

  const { chat, new_chat_member, old_chat_member } = update;

  // Only care about channels and supergroups (not DMs)
  if (!["channel", "supergroup", "group"].includes(chat.type)) return;

  const wasAdmin = ["administrator", "creator"].includes(
    old_chat_member?.status,
  );
  const isNowAdmin = ["administrator", "creator"].includes(
    new_chat_member?.status,
  );
  const isNowOut = ["left", "kicked"].includes(new_chat_member?.status);

  // ── Bot was ADDED as admin (or promoted) ──
  if (!wasAdmin && isNowAdmin) {
    console.log(`📡  Bot added to channel: ${chat.title} (${chat.id})`);

    const ch = await Channel.findOneAndUpdate(
      { chatId: chat.id },
      {
        $setOnInsert: {
          chatId: chat.id,
          title: chat.title || "Unnamed",
          username: chat.username || null,
          type: chat.type,
          status: "pending",
          addedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );

    // Only alert if this is a fresh pending entry (not a re-promotion of already-active)
    if (ch.status === "pending") {
      const label = chat.username ? `@${chat.username}` : `ID: \`${chat.id}\``;
      try {
        await bot.telegram.sendMessage(
          Number(BOT_ADMIN_ID),
          `📡 *Bot added to a channel!*\n\n*${chat.title}*\n${label}\n\nApprove this channel to start tracking subscriber joins.`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback("✅ Approve", `ch_approve_${chat.id}`),
                Markup.button.callback("❌ Decline", `ch_decline_${chat.id}`),
              ],
            ]),
          },
        );
        console.log(
          `📨  Notified admin ${BOT_ADMIN_ID} about new channel: ${chat.title}`,
        );
      } catch (err) {
        console.error(
          "⚠️  Could not DM admin for channel approval:",
          err.message,
        );
      }
    }
  }

  // ── Bot was REMOVED from channel ──
  if (isNowOut && !isNowOut === false) {
    console.log(`🔌  Bot removed from channel: ${chat.title} (${chat.id})`);
    // Mark as declined — no longer tracking
    await Channel.findOneAndUpdate(
      { chatId: chat.id },
      { status: "declined", resolvedAt: new Date() },
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── TRACK SUBSCRIBER JOINS (approved channels only) ──────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function isChannelActive(chatId) {
  if (IS_MOCK) return false;
  const ch = await Channel.findOne({ chatId: Number(chatId) });
  return ch?.status === "active";
}

bot.on("chat_member", async (ctx) => {
  if (IS_MOCK) return;
  const update = ctx.chatMember;
  if (!update) return;

  // Gate: only track joins from approved channels
  if (!(await isChannelActive(update.chat.id))) return;

  const { new_chat_member, old_chat_member } = update;
  const isJoin =
    new_chat_member.status === "member" &&
    (old_chat_member.status === "left" || old_chat_member.status === "kicked");
  if (!isJoin) return;

  const user = new_chat_member.user;
  if (user.is_bot) return;

  try {
    // REPLACE the Subscriber.findOneAndUpdate call in bot.on('chat_member') with:
    const existing = await Subscriber.findOne({ telegramId: user.id });
    if (existing) {
      console.log(
        `↩️  Returning subscriber: ${user.first_name} (${user.id}) — skipping`,
      );
      return;
    }
    const doc = await Subscriber.create({
      telegramId: user.id,
      username: user.username || null,
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      channelId: update.chat.id,
      joinedAt: new Date(),
    });
    console.log(
      `➕  New subscriber: ${user.first_name} (${user.id}) via channel ${update.chat.id}`,
    );
    broadcast({ type: "NEW_SUBSCRIBER", data: doc });
  } catch (err) {
    console.error("❌  Error saving subscriber:", err.message);
  }
});

bot.on("new_chat_members", async (ctx) => {
  if (IS_MOCK) return;
  if (!(await isChannelActive(ctx.chat.id))) return;

  for (const user of ctx.message.new_chat_members) {
    if (user.is_bot) continue;
    try {
      const doc = await Subscriber.findOneAndUpdate(
        { telegramId: user.id },
        {
          $setOnInsert: {
            telegramId: user.id,
            username: user.username || null,
            firstName: user.first_name || "",
            lastName: user.last_name || "",
            channelId: ctx.chat.id,
            joinedAt: new Date(),
          },
        },
        { upsert: true, new: true },
      );
      console.log(
        `➕  New member (group event): ${user.first_name} (${user.id})`,
      );
      broadcast({ type: "NEW_SUBSCRIBER", data: doc });
    } catch (err) {
      console.error("❌  Error saving member:", err.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── ADMINS MENU ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

bot.action("admins", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("👮 *Admin Management*\n\nChoose an action:", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📋 List Admins", "list_admins")],
      [Markup.button.callback("➕ Add Admin", "add_admin_prompt")],
      [Markup.button.callback("🗑 Remove Admin", "remove_admin_prompt")],
      [backBtn()],
    ]),
  });
});

bot.action("list_admins", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  let text;
  if (IS_MOCK) {
    text = `📋 *Admins (1):*\n\n1. Owner — \`${BOT_ADMIN_ID}\` 👑\n\n_Mock mode — DB not connected_`;
  } else {
    const admins = await Admin.find();
    const lines = admins.map(
      (a, i) =>
        `${i + 1}. ${a.firstName || "Unknown"} — \`${a.telegramId}\`${a.telegramId === Number(BOT_ADMIN_ID) ? " 👑" : ""}`,
    );
    text = `📋 *Admins (${admins.length}):*\n\n${lines.join("\n")}`;
  }
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[backBtn("← Back to Admins", "admins")]]),
  });
});

const pendingState = new Map();

bot.action("add_admin_prompt", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  pendingState.set(ctx.from.id, { action: "add_admin" });
  await ctx.editMessageText(
    "➕ *Add Admin*\n\nReply with the Telegram user ID.\n\n_Send /cancel to abort._",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✕ Cancel", "admins")],
      ]),
    },
  );
});

bot.action("remove_admin_prompt", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  pendingState.set(ctx.from.id, { action: "remove_admin" });
  await ctx.editMessageText(
    "🗑 *Remove Admin*\n\nReply with the Telegram user ID to remove.\n\n_Cannot remove owner. Send /cancel to abort._",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✕ Cancel", "admins")],
      ]),
    },
  );
});

bot.on("text", adminOnly, async (ctx, next) => {
  const state = pendingState.get(ctx.from.id);
  if (!state) return next();

  const text = ctx.message.text.trim();
  if (text === "/cancel") {
    pendingState.delete(ctx.from.id);
    return ctx.reply("Cancelled.");
  }

  const targetId = Number(text);
  if (!targetId || isNaN(targetId)) {
    return ctx.reply("⚠️ Invalid Telegram ID. Try again or send /cancel.");
  }

  pendingState.delete(ctx.from.id);

  if (state.action === "add_admin") {
    if (IS_MOCK) return ctx.reply("🎭 Mock mode — DB not available.");
    if (await Admin.findOne({ telegramId: targetId })) {
      return ctx.reply(`⚠️ \`${targetId}\` is already an admin.`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[backBtn("← Back to Admins", "admins")]]),
      });
    }
    await Admin.create({
      telegramId: targetId,
      addedBy: ctx.from.id,
      firstName: "",
    });
    return ctx.reply(`✅ Admin *${targetId}* added.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[backBtn("← Back to Admins", "admins")]]),
    });
  }

  if (state.action === "remove_admin") {
    if (IS_MOCK) return ctx.reply("🎭 Mock mode — DB not available.");
    if (targetId === Number(BOT_ADMIN_ID))
      return ctx.reply("⛔ Cannot remove bootstrap admin.");
    const result = await Admin.deleteOne({ telegramId: targetId });
    if (!result.deletedCount) {
      return ctx.reply(`⚠️ \`${targetId}\` not in admin list.`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[backBtn("← Back to Admins", "admins")]]),
      });
    }
    return ctx.reply(`🗑 Admin *${targetId}* removed.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[backBtn("← Back to Admins", "admins")]]),
    });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (!IS_MOCK) {
      await connectDB();
      await ensureBootstrapAdmin();
    }

    const me = await bot.telegram.getMe();
    console.log(`🤖  Bot identity: @${me.username} (id: ${me.id})`);

    await bot.telegram.setMyCommands([
      { command: "start", description: "🏠 Open main menu" },
    ]);
    console.log("📋  Bot commands registered via setMyCommands");

    server.listen(PORT, () => {
      console.log(`🚀  HTTP + WS server on port ${PORT}`);
      console.log(`🌐  Mini App URL: ${MINIAPP_URL}`);
      console.log(`🎭  Mock mode: ${IS_MOCK}`);
    });

    bot.launch({
      allowedUpdates: [
        "message",
        "callback_query",
        "chat_member",
        "my_chat_member",
      ],
    });
    console.log("✅  Telegraf bot launched (long-polling)");

    process.once("SIGINT", () => {
      bot.stop("SIGINT");
      server.close();
    });
    process.once("SIGTERM", () => {
      bot.stop("SIGTERM");
      server.close();
    });
  } catch (err) {
    console.error("💥  Fatal startup error:", err);
    process.exit(1);
  }
})();
