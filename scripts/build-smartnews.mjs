import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CONFIG ---
const FEED_URL = "https://www.cabletv.com/feed";
const LOGO_URL = "https://i.ibb.co/sptKgp34/CTV-Feed-Logo.png"; // 700x100 PNG (your confirmed URL)
const MAX_LINKS = 20;                 // reduce if SmartNews still flags "too many links"
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed-smartnews.xml";
const UA = "Mozilla/5.0 (compatible; SmartNews-Feed-Builder/1.0; +https://CTV-Clearlink.github.io)";

async function main() {
  console.log("==> Create output dir");
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("==> Fetching origin feed:", FEED_URL);
  const res = await fetch(FEED_URL, {
    headers: { "Accept": "application/rss+xml", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!xml.includes("<rss")) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  console.log("==> Ensuring namespaces");
  if (!/xmlns:snf=/.test(xml)) {
    xml = xml.replace(
      /<rss([^>]*)>/,
      '<rss$1 xmlns:snf="http://www.smartnews.be/snf" xmlns:media="http://search.yahoo.com/mrss/">'
    );
  }

  console.log("==> Injecting logo if missing");
  if (!/<snf:logo>/.test(xml)) {
    xml = xml.replace("<channel>", `<channel>
    <snf:logo><url>${LOGO_URL}</url></snf:logo>`);
  }

  console.log("==> Rewriting items");
  xml = await rewriteItems(xml);

  console.log("==> Writing output:", OUTPUT);
  writeFileSync(OUTPUT, xml, "utf8");
  console.log("==> DONE");
}

async function rewriteItems(xmlStr) {
  const items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`Found ${items.length} <item> elements`);

  for (const item of items) {
    let out = item;

    // 1) Trim non-editorial blocks & cap links inside content:encoded
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = body
          .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "")
          .replace(/<div[^>]+class=(["']).*?(related|share|social|subscribe|breadcrumbs|tags|tag-cloud|promo|newsletter).*?\1[^>]*>[\s\S]*?<\/div>/gi, "");
        let i = 0;
        body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, (m, inner) => (++i <= MAX_LINKS) ? m : inner);
        return open + body + close;
      }
    );

    // 2) Ensure <media:thumbnail> (fallback to og:image from article page)
    if (!/<media:thumbnail\b/.test(out)) {
      const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
      if (link) {
        try {
          const pageRes = await fetch(link, { headers: { "Accept": "text/html", "User-Agent": UA } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
            if (og) out = out.replace("</item>", `<media:thumbnail url="${og}" /></item>`);
          } else {
            console.warn("WARN: article fetch failed", link, pageRes.status, pageRes.statusText);
          }
        } catch (e) {
          console.warn("WARN: og:image lookup failed for", link, e.message);
        }
      }
    }

    // 3) Strip common UTM params from <link>
    out = out.replace(/<link>([^<]+)<\/link>/, (_, u) => {
      try {
        const url = new URL(u);
        ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p =>
          url.searchParams.delete(p)
        );
        return `<link>${url.toString()}</link>`;
      } catch { return `<link>${u}</link>`; }
    });

    xmlStr = xmlStr.replace(item, out);
  }

  return xmlStr;
}

main().catch(err => {
  console.error("BUILD FAILED:", err.stack || err.message);
  // Write a diagnostic XML so the artifact exists (helps debugging in Pages)
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
