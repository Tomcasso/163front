import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

// ✅ 引入 MCP 邮箱工具（你当前是本地 tools 方式）
import { tools as mailTools } from "./mcp/mail-server.js";

// ✅ 引入本地数据库（SQLite）封装
import { listChats, getChat, createChat, updateChat, deleteChat } from "./db.js";

dotenv.config();

// ✅ 在这里加（立刻验证）
// ⚠️ 生产环境建议不要打印 EMAIL_PASS
console.log("EMAIL_USER =", process.env.EMAIL_USER);
console.log("EMAIL_PASS =", process.env.EMAIL_PASS);

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   通义（OpenAI 兼容）
========================= */
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

/* =========================
   Health Check
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =====================================================
   ✅ 会话数据库接口（刷新不丢历史）
===================================================== */

// 获取会话列表（左侧）
app.get("/api/chats", (req, res) => {
  try {
    res.json({ chats: listChats() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "读取会话列表失败" });
  }
});

// 获取单个会话（右侧 messages）
app.get("/api/chats/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const chat = getChat(id);
    if (!chat) return res.status(404).json({ error: "chat not found" });
    res.json(chat);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "读取会话失败" });
  }
});

// 新建会话（保存 messages）
app.post("/api/chats", (req, res) => {
  try {
    const { title, messages } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });

    const chatId = createChat({
      title: String(title),
      messages: Array.isArray(messages) ? messages : [],
    });

    res.json({ id: chatId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "创建会话失败" });
  }
});

// 更新会话（保存 messages）
app.put("/api/chats/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title, messages } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });

    updateChat(id, {
      title: String(title),
      messages: Array.isArray(messages) ? messages : [],
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "更新会话失败" });
  }
});

// 可选：删除会话
app.delete("/api/chats/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    deleteChat(id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "删除会话失败" });
  }
});

/* =====================================================
   MCP Client（当前：本地 tools 调用）：统一调用工具
===================================================== */
async function callMcpTool(toolName, params = {}) {
  const tool = mailTools[toolName];
  if (!tool) throw new Error(`MCP 工具不存在：${toolName}`);
  return await tool.execute(params);
}

/* =========================
   轻量校验：避免模型乱输出
========================= */
function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function clampLimit(x, dft = 20, min = 1, max = 200) {
  const n = Number(x);
  if (!Number.isFinite(n)) return dft;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/* =====================================================
   普通对话接口（不走工具，保留你原来的）
===================================================== */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    const chatMessages = [
      { role: "system", content: "你是一个专业、简洁的邮箱秘书助手。中文回答。" },
      ...messages.map((m) => ({
        role: m.from === "user" ? "user" : "assistant",
        content: String(m.text ?? ""),
      })),
    ];

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: chatMessages,
      temperature: 0.7,
    });

    const reply = r.choices?.[0]?.message?.content ?? "（无回复）";
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "调用通义失败" });
  }
});

/* =====================================================
   标题生成接口（你已经验证 OK 的）
===================================================== */
app.post("/api/title", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ title: "新会话" });
    }

    const transcript = messages
      .map((m) => {
        const role = m.from === "user" ? "用户" : "助手";
        const text = String(m.text ?? "").trim();
        return text ? `${role}：${text}` : "";
      })
      .filter(Boolean)
      .join("\n");

    const prompt = `
你是“对话标题生成器”。请阅读下面的对话记录，生成一个中文短标题。

要求：
- 6~10 个字
- 不使用问候语（你好、您好等）
- 不要引号、不要句号、不要换行
- 只输出标题本身

对话记录：
${transcript}
`.trim();

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "严格遵守格式要求。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 32,
    });

    let title = (r.choices?.[0]?.message?.content || "")
      .replace(/[\r\n]/g, " ")
      .replace(/^标题[:：]\s*/g, "")
      .trim();

    if (!title || title.length < 2) title = "新会话";
    if (title.length > 12) title = title.slice(0, 12) + "…";

    res.json({ title });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "生成标题失败" });
  }
});

/* =====================================================
   ✅ Agent 核心接口（邮箱智能体）
===================================================== */
app.post("/api/agent", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    // ✅ 给模型一个“真实今天日期”的锚点（避免它不知道今天几号）
    // 用你服务器本机时间；如果你机器不是 +08:00，也能通过 toLocaleString 固定到上海时区
    const nowCN = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
    );
    const y = nowCN.getFullYear();
    const m = String(nowCN.getMonth() + 1).padStart(2, "0");
    const d = String(nowCN.getDate()).padStart(2, "0");
    const todayYmd = `${y}-${m}-${d}`;

    const systemPrompt = `
你是一个“邮箱 MCP 智能体”（中文回答）。
重要：今天的日期是 ${todayYmd}（Asia/Shanghai 时区）。当用户说“今天/昨天/前天/本周/上周/这个月”等，相对时间都以这个日期为准来换算。

你可以使用以下 MCP 工具：
1) mail.listInbox(since, before, limit, unreadOnly, from)
   - 用于查询收件箱邮件摘要
   - since / before 必须输出为 yyyy-mm-dd（字符串）
   - 语义：since 含当天；before 不含当天（即 [since, before) 区间）
   - 例：查“昨天” => since=2025-12-18, before=2025-12-19
   - 例：查“2025-04-05 到 2025-07-06” => since=2025-04-05, before=2025-07-07（若用户说“到7/6”一般理解包含7/6）
   - 例：查“4/5-7/6”同上；若用户没说年份，用“当前年份”
   - 例：查“从12/1到现在” => since=2025-12-01，不传 before
   - 支持 unreadOnly=true（只查未读）
   - 支持 limit（默认 20；用户没说就 20）
   - 支持 from（发件人过滤）：
     - 用户说“查某个人/某个邮箱发来的邮件”，就传 from
     - from 传邮箱地址（如 alice@example.com）优先；也可传姓名关键字（如 张三）
     - 若能识别出邮箱地址（如 xxx@xxx.com），务必输出邮箱地址格式；
     - 若只提到姓名，则直接输出姓名字符串。

2) mail.send(to, subject, text)
   - 发送邮件（参数必须齐全）

规则（必须遵守）：
- 如果需要用工具，请只输出 JSON：
{
  "action": "工具名",
  "params": { ... },
  "reply": "给用户的说明"
}
- 如果不需要工具：
{
  "action": "none",
  "reply": "直接回复用户"
}
只输出 JSON，不要多余文字。
`.trim();

    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.from === "user" ? "user" : "assistant",
        content: String(m.text ?? ""),
      })),
    ];

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: chatMessages,
      temperature: 0.3,
    });

    const raw = r.choices?.[0]?.message?.content ?? "";

    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      // 模型没按 JSON 输出：直接当普通回复
      return res.json({ reply: raw });
    }

    // 不用工具
    if (!decision.action || decision.action === "none") {
      return res.json({ reply: decision.reply ?? "（无回复）" });
    }

    // ✅ 用工具：这里做一次轻量参数修正/保护
    const toolName = String(decision.action);
    const params = { ...(decision.params || {}) };

    // 只对 listInbox 做一点兜底（避免模型把日期写歪）
    if (toolName === "mail.listInbox") {
      if (params.since != null && !isYmd(params.since)) delete params.since;
      if (params.before != null && !isYmd(params.before)) delete params.before;

      params.unreadOnly = Boolean(params.unreadOnly);
      params.limit = clampLimit(params.limit, 20, 1, 200);

      // from 清洗（空就删，过长截断）
      if (params.from != null) {
        const s = String(params.from).trim();
        if (!s) delete params.from;
        else params.from = s.slice(0, 120);
      }

      // scan 兜底（如果你 mail-server.js 支持 scan）
      if (params.scan != null) {
        const n = Number(params.scan);
        if (Number.isFinite(n)) params.scan = Math.max(0, Math.min(20000, Math.trunc(n)));
        else delete params.scan;
      }
    }

    const data = await callMcpTool(toolName, params);

    return res.json({
      reply: decision.reply ?? "已执行查询。",
      tool: toolName,
      params, // ✅ 返回 params 便于你前端/日志调试
      data,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   启动服务
========================= */
const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Backend running: http://localhost:${port}`);
});
