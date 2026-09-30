// User-agent classification for the admin dashboard. Crawlers, link unfurlers,
// uptime monitors, headless browsers and scripted HTTP clients all load the page
// (and fire the "visit" beacon if they run JS), so they're tagged here and kept
// out of the human numbers. Classification happens when stats are read, so
// improving this list re-tags past events too.

const BOT_RE = new RegExp(
  [
    "bot\\b",
    "bot/",
    "crawl",
    "spider",
    "slurp",
    "scrap",
    "archiver",
    "indexer",
    "headless",
    "phantomjs",
    "puppeteer",
    "playwright",
    "selenium",
    "webdriver",
    "lighthouse",
    "pagespeed",
    "gtmetrix",
    "pingdom",
    "uptime",
    "monitor",
    "checkly",
    "curl/",
    "wget/",
    "python",
    "httpx",
    "aiohttp",
    "go-http",
    "java/",
    "okhttp",
    "axios",
    "node-fetch",
    "undici",
    "postman",
    "insomnia",
    "libwww",
    "http_request",
    // Link unfurlers. Not "linkedin"/"slack" alone: their in-app browsers are people.
    "facebookexternalhit",
    "embedly",
    "whatsapp/",
    "telegrambot",
    "discordbot",
    "slackbot",
    "skypeuripreview",
    "linkedinbot",
    "vercel",
    "preview",
    "bytespider",
    "gptbot",
    "chatgpt",
    "claude",
    "anthropic",
    "perplexity",
    "ccbot",
    "ahrefs",
    "semrush",
    "mj12",
    "dotbot",
    "petalbot",
    "yandex",
    "baidu",
    "duckduck",
    "applebot",
    "bingpreview",
  ]
    .map((p) => p.replace(/[.*+?^${}()|[\]]/g, (c) => (c === "\\" ? c : `\\${c}`)))
    .join("|"),
  "i"
);

// True when a user agent is missing, implausibly short, or matches a known
// automated client.
export function isBotUA(ua?: string): boolean {
  if (!ua || ua.trim().length < 20) return true;
  if (!/mozilla\/|opera\//i.test(ua)) return true; // every mainstream browser sends one
  return BOT_RE.test(ua);
}

// Short, readable label ("Chrome · macOS") for dashboard tables.
export function uaLabel(ua?: string): string {
  if (!ua) return "(none)";
  if (isBotUA(ua)) {
    const m = ua.match(
      /([a-z0-9_.-]*(?:bot|crawler|spider|preview|monitor|lighthouse|headless\w*)[a-z0-9_.-]*)/i
    );
    return m ? m[1] : ua.slice(0, 40);
  }
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /opr\/|opera/i.test(ua)
      ? "Opera"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /chrome|crios/i.test(ua)
          ? "Chrome"
          : /safari/i.test(ua)
            ? "Safari"
            : "Other";
  const os = /iphone|ipad|ipod/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /mac os x|macintosh/i.test(ua)
        ? "macOS"
        : /windows/i.test(ua)
          ? "Windows"
          : /linux|cros/i.test(ua)
            ? "Linux"
            : "Other";
  return `${browser} · ${os}`;
}
