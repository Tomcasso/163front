import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const IMAP_HOST = "imap.163.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.163.com";
const SMTP_PORT = 465;

/**
 * ✅ 只做“格式校验 + 转换”，不做“理解”
 * - 输入必须 yyyy-mm-dd
 * - 按中国时区 +08:00 的 00:00 构造 Date，避免你机器时区导致偏移
 */
function ymdToDateCN(ymd) {
  if (!ymd) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function pickBestDate(parsed, envelope) {
  const d = parsed?.date || envelope?.date || null;
  return d ? new Date(d) : null;
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function includesNorm(hay, needle) {
  const h = norm(hay);
  const n = norm(needle);
  return n ? h.includes(n) : true;
}

// 从解析结果里尽可能提取“可能的发件人线索”用于本地匹配
function extractFromCandidates(parsed) {
  const candidates = [];

  // 1) from.text（最常见：显示名 <邮箱>）
  if (parsed?.from?.text) candidates.push(parsed.from.text);

  // 2) from.value[].address / name
  if (Array.isArray(parsed?.from?.value)) {
    for (const v of parsed.from.value) {
      if (v?.address) candidates.push(v.address);
      if (v?.name) candidates.push(v.name);
    }
  }

  // 3) reply-to（有些邮件 From 是系统，Reply-To 才是人）
  if (parsed?.replyTo?.text) candidates.push(parsed.replyTo.text);
  if (Array.isArray(parsed?.replyTo?.value)) {
    for (const v of parsed.replyTo.value) {
      if (v?.address) candidates.push(v.address);
      if (v?.name) candidates.push(v.name);
    }
  }

  // 4) sender（代发/群发时可能有）
  if (parsed?.sender?.text) candidates.push(parsed.sender.text);
  if (Array.isArray(parsed?.sender?.value)) {
    for (const v of parsed.sender.value) {
      if (v?.address) candidates.push(v.address);
      if (v?.name) candidates.push(v.name);
    }
  }

  // 去重
  return Array.from(new Set(candidates.map((x) => String(x).trim()).filter(Boolean)));
}

async function connectAndOpenInbox() {
  const EMAIL_USER = process.env.EMAIL_USER;
  const EMAIL_PASS = process.env.EMAIL_PASS;

  if (!EMAIL_USER || !EMAIL_PASS) {
    throw new Error("邮箱环境变量缺失：请检查 EMAIL_USER / EMAIL_PASS 是否在 backend/.env 中");
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    authTimeout: 10000,
  });

  await client.connect();
  await client.mailboxOpen("INBOX");
  return client;
}

export const tools = {
  /**
   * ✅ 支持：
   * - since / before：yyyy-mm-dd 时间范围
   * - unreadOnly：只看未读
   * - limit：最终返回条数（不是扫描条数）
   * - from：发件人过滤（邮箱/中文名/关键字）
   * - scan：兜底扫描最多扫描多少封（默认 2000，越大越慢，但更“全”）
   */
  "mail.listInbox": {
    description:
      "按时间范围列出收件箱邮件摘要（since/before 为 yyyy-mm-dd，可选；before 不包含当天；支持 from 发件人过滤；自动兜底扫描支持中文名）",
    parameters: {
      since: { type: "string", optional: true },
      before: { type: "string", optional: true },
      limit: { type: "number", default: 10 },
      unreadOnly: { type: "boolean", default: false },
      from: { type: "string", optional: true },
      scan: { type: "number", default: 2000 }, // ✅ 新增：兜底扫描上限
    },

    async execute({ since, before, limit = 10, unreadOnly = false, from, scan = 2000 }) {
      // ✅ 不理解日期，只校验格式
      const sinceDate = since ? ymdToDateCN(since) : null;
      const beforeDate = before ? ymdToDateCN(before) : null;

      if (since && !sinceDate) throw new Error("参数错误：since 必须为 yyyy-mm-dd");
      if (before && !beforeDate) throw new Error("参数错误：before 必须为 yyyy-mm-dd");
      if (sinceDate && beforeDate && sinceDate >= beforeDate) {
        throw new Error("参数错误：since 必须早于 before（before 不包含当天）");
      }

      const fromStr = typeof from === "string" && from.trim() ? from.trim() : null;

      // scan 兜底：避免太夸张
      const scanN = Math.max(0, Math.min(20000, Math.trunc(Number(scan) || 0))) || 2000;

      const client = await connectAndOpenInbox();

      try {
        // 1) 先尝试 IMAP 原生搜索（快）
        const query = {};
        if (sinceDate) query.since = sinceDate;
        if (beforeDate) query.before = beforeDate;
        if (unreadOnly) query.seen = false;
        if (fromStr) query.from = fromStr; // 可能对中文不可靠，但先试

        let uids = await client.search(query);

        // 2) 若 fromStr 存在且没搜到，走“兜底扫描”
        //    - 兜底扫描会先用“时间/未读”条件找一批 uid，再本地解析 from 做包含匹配
        if (fromStr && (!Array.isArray(uids) || uids.length === 0)) {
          const baseQuery = {};
          if (sinceDate) baseQuery.since = sinceDate;
          if (beforeDate) baseQuery.before = beforeDate;
          if (unreadOnly) baseQuery.seen = false;

          const baseUids = await client.search(baseQuery);

          // 扫描最近 scanN 封（越新越靠后）
          const scanUids = baseUids.slice(-scanN);

          const matched = [];
          for await (const msg of client.fetch(scanUids, {
            envelope: true,
            uid: true,
            source: true,
            flags: true,
          })) {
            const parsed = await simpleParser(msg.source);

            // 拿到可能的发件人线索（from/reply-to/sender）
            const candidates = extractFromCandidates(parsed);

            // 只要任意候选包含 fromStr（支持邮箱/中文名/部分字符串）
            const ok = candidates.some((c) => includesNorm(c, fromStr));
            if (!ok) continue;

            const bestDate = pickBestDate(parsed, msg.envelope);
            matched.push({
              uid: msg.uid,
              from: parsed.from?.text || "(未知发件人)",
              subject: parsed.subject || "(无主题)",
              date: bestDate ? bestDate.toISOString() : null,
              unread: Array.isArray(msg.flags) ? !msg.flags.includes("\\Seen") : null,
              snippet: (parsed.text || "").replace(/\s+/g, " ").slice(0, 160),
            });
          }

          // 本地匹配结果按时间从新到旧
          matched.sort((a, b) => {
            const ta = a.date ? Date.parse(a.date) : 0;
            const tb = b.date ? Date.parse(b.date) : 0;
            return tb - ta;
          });

          // 只返回 limit 条
          return matched.slice(0, limit);
        }

        // 3) 正常路径：uids 有结果（from 过滤 or 无 from）
        //    搜索结果可能很多，只取最后 limit 封
        const latest = (uids || []).slice(-limit);

        const mails = [];
        for await (const msg of client.fetch(latest, {
          envelope: true,
          uid: true,
          source: true,
          flags: true,
        })) {
          const parsed = await simpleParser(msg.source);
          const bestDate = pickBestDate(parsed, msg.envelope);

          mails.push({
            uid: msg.uid,
            from: parsed.from?.text || "(未知发件人)",
            subject: parsed.subject || "(无主题)",
            date: bestDate ? bestDate.toISOString() : null,
            unread: Array.isArray(msg.flags) ? !msg.flags.includes("\\Seen") : null,
            snippet: (parsed.text || "").replace(/\s+/g, " ").slice(0, 160),
          });
        }

        // 按时间从新到旧
        mails.sort((a, b) => {
          const ta = a.date ? Date.parse(a.date) : 0;
          const tb = b.date ? Date.parse(b.date) : 0;
          return tb - ta;
        });

        return mails;
      } finally {
        await client.logout();
      }
    },
  },

  "mail.listTodayInbox": {
    description: "（兼容旧版本）列出今日的收件箱邮件摘要",
    parameters: { limit: { type: "number", default: 10 } },
    async execute({ limit = 10 }) {
      const nowCN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
      const y = nowCN.getFullYear();
      const m = String(nowCN.getMonth() + 1).padStart(2, "0");
      const d = String(nowCN.getDate()).padStart(2, "0");
      const since = `${y}-${m}-${d}`;

      return await tools["mail.listInbox"].execute({
        since,
        limit,
        unreadOnly: false,
      });
    },
  },

  "mail.send": {
    description: "发送邮件（需提供收件人、主题、正文）",
    parameters: {
      to: { type: "string" },
      subject: { type: "string" },
      text: { type: "string" },
    },

    async execute({ to, subject, text }) {
      const EMAIL_USER = process.env.EMAIL_USER;
      const EMAIL_PASS = process.env.EMAIL_PASS;

      if (!EMAIL_USER || !EMAIL_PASS) {
        throw new Error("邮箱环境变量缺失：请检查 EMAIL_USER / EMAIL_PASS 是否在 backend/.env 中");
      }

      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      });

      const info = await transporter.sendMail({
        from: EMAIL_USER,
        to,
        subject,
        text,
      });

      return { ok: true, messageId: info.messageId };
    },
  },
};
