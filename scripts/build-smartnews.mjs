import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CONFIG ---
const FEED_URL = "https://www.cabletv.com/feed";
const LOGO_URL = "https://i.ibb.co/sptKgp34/CTV-Feed-Logo.png"; // 700x100 PNG
const MAX_LINKS = 12;                  // tighten link cap to pass validator
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed-smartnews.xml";
const UA = "Mozilla/5.0 (compatible; SmartNews-Feed-Builder/1.1; +https://CTV-Clearlink.github.io)";

// Domains/extensions we consider safe for thumbnails
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(FEED_URL, {
    headers: { "Accept": "application/rss+xml", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!xml.includes("<rss")) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  // Namespaces
  if (!/xmlns:snf=/.test(xml)) {
    xml = xml.replace(
      /<rss([^>]*)>/,
      '<rss$1 xmlns:snf="http://www.smartnews.be/snf" xmlns:media="http://search.yahoo.com/mrss/">'
    );
  }

  // Channel logo
  if (!/<snf:logo>/.test(xml)) {
    xml = xml.replace("<channel>", `<channel>
    <snf:logo><url>${LOGO_URL}</url></snf:logo>`);
  }

  // Items
  xml = await rewriteItems(xml);

  writeFileSync(OUTPUT, xml, "utf8");
  console.log("Wrote", OUTPUT);
}

async function rewriteItems(xmlStr) {
  const items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`Found ${items.length} <item> elements`);

  for (let item of items) {
    let out = item;

    // 1) Clean up content:encoded and cap link count
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = stripJunk(body);
        body = capAnchors(body, MAX_LINKS);
        return open + body + close;
      }
    );

    // 2) Ensure <media:thumbnail> with sanitized URL
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
            } else {
              console.warn("Skip thumbnail (invalid or disallowed):", rawOg);
            }
          } else {
            console.warn("Article fetch failed", pageRes.status, pageRes.statusText, link);
          }
        } catch (e) {
          console.warn("og:image lookup failed for", link, e.message);
        }
      }
    } else {
      // Sanitize existing media:thumbnail URL
      out = out.replace(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*\/>/i, (m, u) => {
        const s = sanitizeUrl(u);
        return (s && ALLOWED_IMG_EXT.test(s)) ? `<media:thumbnail url="${s}" />` : "";
      });
    }

    // 3) Strip UTM params from <link>
    out = out.replace(/<link>([^<]+)<\/link>/, (_, u) => `<link>${stripUtm(u)}</link>`);

    // 4) Add snf:analytics (recommended)
    if (!/<snf:analytics>/.test(out)) {
      out = out.replace("</item>", `<snf:analytics><![CDATA[
  <!-- Place GA4/analytics script here if desired (no iframes). -->
]]></snf:analytics></item>`);
    }

    xmlStr = xmlStr.replace(item, out);
  }

  return xmlStr;
}

// --- helpers ---

function stripJunk(html) {
  // Remove nav/footer/aside and common link-heavy blocks
  let out = html
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<div[^>]+class=(["']).*?\b(related|share|social|subscribe|breadcrumbs|tags|tag-?cloud|promo|newsletter|author|bio|widget|sidebar|footer)\b.*?\1[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<ul[^>]+class=(["']).*?\b(related|share|social|tags|sources)\b.*?\1[^>]*>[\s\S]*?<\/ul>/gi, "")
    .replace(/<section[^>]+class=(["']).*?\b(related|share|social|subscribe|tags|newsletter)\b.*?\1[^>]*>[\s\S]*?<\/section>/gi, "");
  return out;
}

function capAnchors(html, max) {
  let i = 0;
  return html.replace(/<a\b[^>]*>(.*?)<\/a>/gis, (m, inner) => (++i <= max) ? m : inner);
}

function stripUtm(u) {
  try {
    const url = new URL(u);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p => url.searchParams.delete(p));
    return url.toString();
  } catch { return u; }
}

function sanitizeUrl(u) {
  if (!u) return null;
  // trim, convert spaces to %20, ensure https, drop data/mailto/tel/javascript
  let s = u.trim().replace(/\s/g, "%20");
  if (/^(data:|mailto:|tel:|javascript:)/i.test(s)) return null;
  // Make relative -> absolute? (we only accept absolute)
  if (!/^https?:\/\//i.test(s)) return null;
  // Force https
  s = s.replace(/^http:\/\//i, "https://");
  // Encode any stray characters
  try {
    const url = new URL(s);
    // recompose to ensure proper encoding
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
