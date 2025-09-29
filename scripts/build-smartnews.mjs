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
      /<rss(
