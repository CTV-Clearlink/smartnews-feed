import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CONFIG ---
const FEED_URL = "https://www.cabletv.com/feed"; // your current RSS feed
const LOGO_URL = "https://www.cabletv.com/path/to/logo-700x100.png"; // TODO: replace with your real 700x100 PNG
const MAX_LINKS = 20; // keep first N links in content
const OUTPUT = __dirname + "/../dist/feed-smartnews.xml";

// --- FETCH ORIGIN FEED ---
let xml = await (await fetch(FEED_URL, { headers: { Accept: "application/rss+xml" } })).text();

// --- ENSURE NAMESPACES ---
if (!/xmlns:snf=/.test(xml)) {
  xml = xml.replace(
    /<rss([^>]*)>/,
    '<rss$1 xmlns:snf="http://www.smartnews.be/snf" xmlns:media="http://search.yahoo.com/mrss/">'
  );
}

// --- INJECT CHANNEL LOGO (IF MISSING) ---
if (!/<snf:logo>/.test(xml)) {
  xml = xml.replace("<channel>", `<channel>
    <snf:logo><url>${LOGO_URL}</url></snf:logo>`);
}

// --- PER-ITEM TRANSFORMS ---
xml = await rewriteItems(xml);

// --- WRITE OUTPUT ---
mkdirSync(__dirname + "/../dist", { recursive: true });
writeFileSync(OUTPUT, xml, "utf8");
console.log("Wrote", OUTPUT);

async function rewriteItems(xmlStr) {
  const items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    let out = item;

    // 1) Clean up content:encoded
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = body
          .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "")
          .replace(/<div[^>]+class=(["']).*?(related|share|social|subscribe|breadcrumbs|tags|tag-cloud|promo|newsletter).*?\1[^>]*>[\s\S]*?<\/div>/gi, "");
        let i = 0;
        body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, (m, inner) =>
          ++i <= MAX_LINKS ? m : inner
        );
        return open + body + close;
      }
    );

    // 2) Add thumbnail if missing
    if (!/<media:thumbnail\b/.test(out)) {
      const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
      if (link) {
        try {
          const html = await (await fetch(link, { headers: { Accept: "text/html" } })).text();
          const og = html.match(
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
          )?.[1];
          if (og) out = out.replace("</item>", `<media:thumbnail url="${og}" /></item>`);
        } catch { /* ignore errors per item */ }
      }
    }

    // 3) Remove UTM params from <link>
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
