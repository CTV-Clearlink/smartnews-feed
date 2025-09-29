import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CONFIG ---
const FEED_URL = "https://www.cabletv.com/feed";
const LOGO_URL = "https://i.ibb.co/sptKgp34/CTV-Feed-Logo.png"; // 700x100 PNG
const MAX_LINKS = 2;                    // ultra-tight cap
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed-smartnews.xml";
const UA = "Mozilla/5.0 (compatible; SmartNews-Feed-Builder/1.4; +https://CTV-Clearlink.github.io)";
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(FEED_URL, { headers: { "Accept": "application/rss+xml", "User-Agent": UA } });
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

    // 0) Fix titles: remove WP shortcodes and decode simple pipe entity
    out = out.replace(/<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/title>/i, (_m, cdata, plain) => {
      let raw = (cdata ?? plain ?? "").trim();
      raw = raw.replace(/\[[^\]]+\]/g, "").replace(/&#124;/g, "|").replace(/\s{2,}/g, " ").trim();
      // If a title ends with " in" due to shortcode removal, append the current year
      if (/\bin\s*$/i.test(raw)) raw = raw + new Date().getFullYear();
      return `<title><![CDATA[${raw}]]></title>`;
    });

    // Remove any existing analytics blocks (optional in SmartNews)
    out = out.replace(/<snf:analytics>[\s\S]*?<\/snf:analytics>/gi, "");

    // 1) Clean + cap links inside content:encoded (very aggressive)
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = stripJunk(body);
        body = removeUnsafeAnchors(body);
        body = unwrapLowValueAnchors(body);

        // remove anchors inside headings
        body = body.replace(/<(h1|h2|h3|h4|h5|h6)[^>]*>[\s\S]*?<\/\1>/gi, m =>
          m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
        );

        // soft cap
        body = capAnchors(body, MAX_LINKS);

        // hard cap (belt & suspenders): if still too many, unwrap ALL
        if (anchorCount(body) > MAX_LINKS) {
          body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");
        }

        // also unwrap anchors in the last 25% of content (often sources/footers)
        const cut = Math.floor(body.length * 0.75);
        body = body.slice(0, cut) +
               body.slice(cut).replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");

        return open + body + close;
      }
    );

    // 2) Ensure/sanitize media:thumbnail
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
            // 2a) Ensure author if missing
            out = ensureAuthor(out, html);
          }
        } catch { /* ignore per-item errors */ }
      }
    } else {
      // sanitize provided thumbnail URL
      out = out.replace(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*\/>/i, (m, u) => {
        const s = sanitizeUrl(u);
        return (s && ALLOWED_IMG_EXT.test(s)) ? `<media:thumbnail url="${s}" />` : "";
      });
      // 2a) ensure author if missing (fetch page for author)
      const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
      if (link) {
        try {
          const pageRes = await fetch(link, { headers: { "Accept": "text/html", "User-Agent": UA } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            out = ensureAuthor(out, html);
          }
        } catch {}
      }
    }

    // 3) Strip UTM in <link>
    out = out.replace(/<link>([^<]+)<\/link>/, (_, u) => `<link>${stripUtm(u)}</link>`);

    xmlStr = xmlStr.replace(item, out);
  }
  return xmlStr;
}

// --- helpers ---

function ensureAuthor(itemXml, articleHtml) {
  const hasDc = /<dc:creator>[\s\S]*?<\/dc:creator>/i.test(itemXml);
  const hasAuthor = /<author>[\s\S]*?<\/author>/i.test(itemXml); // RSS 2.0 email format, we’ll use name only
  if (hasDc || hasAuthor) return itemXml;

  // Try to find author from meta tags or JSON-LD
  let name = articleHtml?.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1];

  if (!name) {
    // JSON-LD: "author": {"@type":"Person","name":"..."} or array
    const ldMatches = articleHtml?.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of ldMatches) {
      try {
        const json = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, "").trim());
        const found = findAuthorName(json);
        if (found) { name = found; break; }
      } catch {}
    }
  }

  if (name) {
    // Add both dc:creator and author (name only). Wrap in CDATA to be safe.
    const inject =
      `\n      <dc:creator><![CDATA[${name}]]></dc:creator>\n` +
      `      <author><![CDATA[${name}]]></author>\n`;
    return itemXml.replace(/<\/item>/i, inject + "</item>");
  }
  return itemXml;
}
function findAuthorName(obj) {
  if (!obj || typeof obj !== "object") return null;
  // If array, search elements
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const v = findAuthorName(el);
      if (v) return v;
    }
  }
  // Direct author field
  if (obj.author) {
    if (typeof obj.author === "string") return obj.author;
    if (Array.isArray(obj.author)) {
      for (const a of obj.author) {
        const v = findAuthorName(a);
        if (v) return v;
      }
    } else if (obj.author.name) return obj.author.name;
  }
  // Article schema
  if (obj["@type"] && /Article/i.test(obj["@type"]) && obj.author) {
    const a = obj.author;
    if (typeof a === "string") return a;
    if (Array.isArray(a)) {
      for (const e of a) if (e && e.name) return e.name;
    } else if (a.name) return a.name;
  }
  // Recurse other props
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const found = typeof v === "object" ? findAuthorName(v) : null;
    if (found) return found;
  }
  return null;
}

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
    // unwrap image-only anchors
    .replace(/<a\b[^>]*>\s*(<img[\s\S]*?>)\s*<\/a>/gi, "$1")
    // drop footnote marks like [1]
    .replace(/<sup[^>]*>\s*\[?\d+\]?\s*<\/sup>/gi, "");
}

function removeUnsafeAnchors(html) {
  // unwrap non-editorial schemes and hash anchors
  return html.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis,
    (m, href, inner) => (/^(mailto:|tel:|javascript:|#)/i.test(href) ? inner : m)
  );
}

function unwrapLowValueAnchors(html) {
  // unwrap anchors inside low-value containers: figcaption, caption, small, lists, tables
  html = html.replace(/<(figcaption|caption|small)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  html = html.replace(/<(ul|ol|table)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  // remove “read more / continue / back to top / view sources”
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

function anchorCount(html) {
  let count = 0;
  html.replace(/<a\b[^>]*>(.*?)<\/a>/gis, () => { count++; return ""; });
  return count;
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
