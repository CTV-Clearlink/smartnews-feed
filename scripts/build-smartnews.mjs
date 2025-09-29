import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CONFIG ---
const FEED_URL = "https://www.cabletv.com/feed";
const LOGO_URL = "https://i.ibb.co/sptKgp34/CTV-Feed-Logo.png"; // 700x100 PNG
const MAX_LINKS = 6;                    // tighter cap
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed-smartnews.xml";
const UA = "Mozilla/5.0 (compatible; SmartNews-Feed-Builder/1.2; +https://CTV-Clearlink.github.io)";
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(FEED_URL, {
    headers: { "Accept": "application/rss+xml", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!xml.includes("<rss")) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  if (!/xmlns:snf=/.test(xml)) {
    xml = xml.replace(
      /<rss([^>]*)>/,
      '<rss$1 xmlns:snf="http://www.smartnews.be/snf" xmlns:media="http://search.yahoo.com/mrss/">'
    );
  }

  if (!/<snf:logo>/.test(xml)) {
    xml = xml.replace("<channel>", `<channel>
    <snf:logo><url>${LOGO_URL}</url></snf:logo>`);
  }

  xml = await rewriteItems(xml);

  writeFileSync(OUTPUT, xml, "utf8");
  console.log("Wrote", OUTPUT);
}

async function rewriteItems(xmlStr) {
  const items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`Found ${items.length} <item> elements`);

  for (let item of items) {
    let out = item;

    // Remove any existing analytics blocks (still optional per SmartNews)
    out = out.replace(/<snf:analytics>[\s\S]*?<\/snf:analytics>/gi, "");

    // Clean + cap links inside content:encoded
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = stripJunk(body);
        body = removeUnsafeAnchors(body);
        body = unwrapLowValueAnchors(body);
        body = capAnchors(body, MAX_LINKS);
        body = hardCapAnchors(body, MAX_LINKS);
        return open + body + close;
      }
    );

    // Ensure/sanitize media:thumbnail
    if (!/<media:thumbnail\b/.test(out)) {
      const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
      if (link) {
        try {
          const pageRes = await fetch(link, { headers: { "Accept": "text/html", "User-Agent": UA } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const rawOg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
            const thumb = sanitizeUrl(rawOg);
            if (thumb && ALLOWED_IMG_EXT.test(thumb)) {
              out = out.replace("</item>", `<media:thumbnail url="${thumb}" /></item>`);
            }
          }
        } catch { /* ignore per-item errors */ }
      }
    } else {
      out = out.replace(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*\/>/i, (m, u) => {
        const s = sanitizeUrl(u);
        return (s && ALLOWED_IMG_EXT.test(s)) ? `<media:thumbnail url="${s}" />` : "";
      });
    }

    // Strip UTM in <link>
    out = out.replace(/<link>([^<]+)<\/link>/, (_, u) => `<link>${stripUtm(u)}</link>`);

    xmlStr = xmlStr.replace(item, out);
  }
  return xmlStr;
}

// --- helpers ---

function stripJunk(html) {
  return html
    // structural junk
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // common widget/related/social blocks
    .replace(/<div[^>]+class=(["']).*?\b(related|share|social|subscribe|breadcrumbs|tags|tag-?cloud|promo|newsletter|author|bio|widget|sidebar|footer|cta|read-?more)\b.*?\1[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<section[^>]+class=(["']).*?\b(related|share|social|subscribe|tags|newsletter|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<ul[^>]+class=(["']).*?\b(related|share|social|tags|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/ul>/gi, "")
    // unwrap image-only anchors (linked images)
    .replace(/<a\b[^>]*>\s*(<img[\s\S]*?>)\s*<\/a>/gi, "$1")
    // drop footnotes/sup links like [1], [2]
    .replace(/<sup[^>]*>\s*\[?\d+\]?\s*<\/sup>/gi, "");
}

function removeUnsafeAnchors(html) {
  // unwrap non-editorial schemes and empty/hashtag links
  return html.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis,
    (m, href, inner) => (/^(mailto:|tel:|javascript:|#)/i.test(href) ? inner : m)
  );
}

function unwrapLowValueAnchors(html) {
  // unwrap anchors inside low-value containers: figcaption, caption, small, em dashes in credits, lists, tables
  html = html.replace(/<(figcaption|caption|small)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  // unwrap anchors inside lists and tables (often sources/TOC)
  html = html.replace(/<(ul|ol|table)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  // remove “read more”, “continue”, “back to top”, “view source(s)” links
  html = html.replace(
    /<a\b[^>]*>(\s*(read\s*more|continue|back\s*to\s*top|view\s*sources?|sources?|references?)\s*)<\/a>/gi,
    (m, inner) => inner
  );
  return html;
}

function capAnchors(html, max) {
  let i = 0;
  return html.replace(/<a\b[^>]*>(.*?)<\/a>/gis, (m, inner) => (++i <= max) ? m : inner);
}

function hardCapAnchors(html, max) {
  let count = 0;
  return html.replace(/<a\b[^>]*>(.*?)<\/a>/gis, (m, inner) => (++count > max) ? inner : m);
}

function stripUtm(u) {
  try {
    const url = new URL(u);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p =>
      url.searchParams.delete(p)
    );
    return url.toString();
  } catch { return u; }
}

function sanitizeUrl(u) {
  if (!u) return null;
  let s = u.trim().replace(/\s/g, "%20");
  if (/^(data:|mailto:|tel:|javascript:)/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  s = s.replace(/^http:\/\//i, "https://");
  try {
    const url = new URL(s);
    return url.toString();
  } catch {
    try { return encodeURI(s); } catch { return null; }
  }
}

main().catch(err => {
  console.error("BUILD FAILED:", err.stack || err.message);
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(
      OUTPUT,
      `<?xml version="1.0" encoding="UTF-8"?><error>${escapeXml(err.stack || err.message)}</error>`,
      "utf8"
    );
    console.log("Wrote diagnostic XML to", OUTPUT);
  } catch {}
  process.exit(1);
});

function escapeXml(s){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
