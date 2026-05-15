// api/submit.js — Vercel serverless function
//
// Accepts a multipart/form-data POST from the receipt form (or a
// JSON POST for fraud reports), packages the submission as an email
// with attachments, and sends it via Gmail SMTP to TO_ADDRESS.
//
// Env vars (set in Vercel dashboard → Project → Settings → Environment Variables):
//   GMAIL_USER   — your gmail (e.g. raheemiicorpcreditcard@gmail.com)
//   GMAIL_PASS   — a Google App Password (NOT your regular Gmail
//                  password). See SETUP-VERCEL.md for how to generate one.
//   TO_ADDRESS   — where to send submissions (e.g. cc@iicorp.org)

const Busboy = require("busboy");
const nodemailer = require("nodemailer");

module.exports.config = {
  api: { bodyParser: false },
};

const SUBJECT_PREFIX = "[CC-RECEIPT]";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25MB per file
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;  // ~24MB total (Gmail SMTP cap)

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method not allowed" });
    }

    const env = {
      user: process.env.GMAIL_USER || "",
      pass: process.env.GMAIL_PASS || "",
      to:   process.env.TO_ADDRESS || "",
    };
    if (!env.user || !env.pass || !env.to) {
      return res.status(500).json({ error: "server not configured (missing env vars)" });
    }

    const ctype = (req.headers["content-type"] || "").toLowerCase();

    let payload;
    if (ctype.startsWith("multipart/form-data")) {
      payload = await parseMultipart(req);
    } else if (ctype.startsWith("application/json")) {
      payload = { fields: await readJson(req), files: [] };
    } else {
      return res.status(415).json({ error: "unsupported content type" });
    }

    const f = payload.fields || {};
    const files = payload.files || [];

    const token = (f.token || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
      return res.status(400).json({ error: "invalid token" });
    }

    if (files.length > MAX_FILES) {
      return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
    }
    let total = 0;
    for (const file of files) {
      if (file.content.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: `"${file.filename}" too large (max 25MB)` });
      }
      total += file.content.length;
    }
    if (total > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: "total upload too large — please send fewer or smaller files" });
    }

    const fraud = !!f.fraud;
    const meta = {
      token,
      cardholder:  f.cardholder  || "",
      vendor:      f.vendor      || "",
      amount:      f.amount      || "",
      date:        f.date        || "",
      store:       f.store       || "",
      description: f.description || "",
      submitted_at: new Date().toISOString(),
      file_count:  files.length,
    };
    if (fraud) {
      meta.fraud = true;
      meta.note = f.note || "";
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.user, pass: env.pass },
    });

    await transporter.sendMail({
      from: env.user,
      to: env.to,
      subject: `${SUBJECT_PREFIX} ${token}`,
      text: JSON.stringify(meta, null, 2),
      attachments: files.map(file => ({
        filename: file.filename || "receipt.bin",
        content: file.content,
        contentType: file.contentType || "application/octet-stream",
      })),
    });

    return res.status(200).json({ ok: true, file_count: files.length });
  } catch (err) {
    console.error("submit error:", err);
    return res.status(500).json({ error: err.message || "internal error" });
  }
};

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES + 1 },
    });
    const fields = {};
    const files = [];

    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("file", (_name, stream, info) => {
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => {
        files.push({
          filename: info.filename || "",
          contentType: info.mimeType || "",
          content: Buffer.concat(chunks),
        });
      });
      stream.on("limit", () => reject(new Error("file too large during stream")));
    });
    bb.on("error", reject);
    bb.on("finish", () => resolve({ fields, files }));

    req.pipe(bb);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8") || "{}";
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
