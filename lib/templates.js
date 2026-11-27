/**
 * Server-rendered HTML templates for non-API fallback pages.
 *
 * Kept out of api/*.js so API route handlers stay strictly focused on HTTP
 * request handling and business logic rather than embedding raw HTML/CSS.
 */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Fallback page for a short link (`/s/:code`) that does not exist or was
 * retired. Returned instead of a bare 404 because short links are printed on
 * posters and spoken aloud.
 */
export function missingShortLinkHtml(code, message) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ไม่พบลิงก์นี้ · งานจุฬาฯแฟร์</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f3; --card: #ffffff; --ink: #1d1a18; --soft: #6b655f; --line: #e6e3df; --accent: #c8306f; --chip: #fde8f1; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #131211; --card: #1c1a19; --ink: #f2efec; --soft: #a59f98; --line: #34312e; --accent: #ff6fa3; --chip: #3d1a2d; }
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Anuphan", "IBM Plex Sans Thai", system-ui, -apple-system, "Segoe UI", sans-serif;
    display: grid; place-items: center; min-height: 100vh; margin: 0;
    background: var(--bg); color: var(--ink); text-align: center; padding: 24px;
  }
  main {
    width: 100%; max-width: 24rem; background: var(--card); border: 1px solid var(--line);
    border-radius: 16px; padding: 28px 24px; box-shadow: 0 10px 30px -18px rgba(0,0,0,.22);
  }
  h1 { margin: 0 0 10px; font-size: 1.35rem; color: var(--ink); }
  code {
    display: inline-block; background: var(--chip); color: var(--accent);
    padding: 4px 12px; border-radius: 999px; font-size: 1rem; font-weight: 600;
  }
  p { color: var(--soft); line-height: 1.6; margin: 10px 0; font-size: .95rem; }
  a {
    display: inline-block; margin-top: 12px; padding: 9px 18px; border-radius: 10px;
    background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; font-size: .92rem;
  }
</style></head>
<body><main>
  <h1>ไม่พบลิงก์นี้</h1>
  <p>${escapeHtml(message)}</p>
  <p><code>/s/${escapeHtml(code)}</code></p>
  <p>ลองตรวจตัวอักษรอีกครั้ง หรือถามผู้ที่ให้ลิงก์นี้มา</p>
  <a href="/">กลับหน้าหลักงานจุฬาฯแฟร์</a>
</main></body></html>`;
}

/**
 * Bilingual HTML email invitation for external document signers (Thai first,
 * English below). Kept in lib/templates.js so api/*.js contains zero inline
 * HTML documents.
 */
export function externalSignEmailHtml({
  isReminder, extName, extPosition, senderName, senderDept,
  title, docNumber, note, link, expTh, expEn,
}) {
  return `<!doctype html><html><body style="font-family:'IBM Plex Sans Thai',system-ui,sans-serif;background:#f6f5f3;padding:24px;color:#1d1a18">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e3df;border-radius:14px;padding:24px">
  <div style="font-size:13px;font-weight:700;color:#c8306f;margin-bottom:8px">งานจุฬาฯแฟร์ · Chula Fair</div>
  <h2 style="margin:0 0 12px;font-size:19px">${escapeHtml(isReminder ? 'เตือนความจำ: ขอความกรุณาลงนามเอกสาร' : 'ขอความกรุณาลงนามเอกสาร')}</h2>
  <p style="margin:0 0 10px">เรียน <b>${escapeHtml(extName || 'ผู้ลงนาม')}</b>${extPosition ? ` (${escapeHtml(extPosition)})` : ''}</p>
  <p style="margin:0 0 12px">${escapeHtml(senderName)}${senderDept ? ` · ${escapeHtml(senderDept)}` : ''} ส่งเอกสารให้ท่านตรวจสอบและลงนาม:</p>
  <div style="background:#faf9f8;border:1px solid #efedea;border-radius:10px;padding:12px 14px;margin-bottom:16px">
    <div style="font-weight:700;font-size:15px">${escapeHtml(title)}</div>
    ${docNumber ? `<div style="font-size:13px;color:#55504b;margin-top:4px">เลขที่เอกสาร: ${escapeHtml(docNumber)}</div>` : ''}
    ${note ? `<div style="font-size:13px;color:#55504b;margin-top:6px">${escapeHtml(note)}</div>` : ''}
  </div>
  <p style="text-align:center;margin:20px 0">
    <a href="${escapeHtml(link)}" style="display:inline-block;background:#c8306f;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px">เปิดดูและลงนามเอกสาร</a>
  </p>
  <p style="font-size:12px;color:#6b655f;line-height:1.6">ลิงก์นี้ใช้ได้ครั้งเดียว ไม่ต้องเข้าสู่ระบบ และจะหมดอายุวันที่ <b>${escapeHtml(expTh)}</b><br>กรุณาอย่าส่งต่อลิงก์นี้ให้ผู้อื่น หากมีข้อสงสัยโปรดติดต่อผู้ส่งเอกสารโดยตรง</p>
  <hr style="border:0;border-top:1px solid #efedea;margin:18px 0">
  <p style="font-size:13px;color:#55504b;margin:0 0 8px"><b>Signature Request (English)</b></p>
  <p style="font-size:12.5px;color:#55504b;margin:0 0 10px">${escapeHtml(senderName)} invited you to review and sign <b>${escapeHtml(title)}</b>${docNumber ? ` (${escapeHtml(docNumber)})` : ''}. This one-time link expires on ${escapeHtml(expEn)}.</p>
  <p style="font-size:12px;word-break:break-all;color:#6b655f">${escapeHtml(link)}</p>
</div></body></html>`;
}
