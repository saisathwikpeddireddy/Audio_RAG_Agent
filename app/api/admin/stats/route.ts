// Admin analytics aggregation. Reads recent events from Blob and rolls them up
// into the numbers the dashboard renders. Gated by ADMIN_PASSWORD (sent as the
// x-admin-key header by the /admin page).

import { NextResponse } from "next/server";
import { readEvents, type AnalyticsEvent } from "@/lib/analytics";
import { storageMonthlyCostCents } from "@/lib/costs";
import { isBotUA, uaLabel } from "@/lib/bots";
import { DEMO_SESSION } from "@/lib/sessionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Events that prove a person is at the keyboard.
const ENGAGEMENT = new Set(["engaged", "search", "upload", "play", "download", "delete"]);

type EventKind = "human" | "unverified" | "bot" | "test" | "system";

function topN(counts: Record<string, number>, n: number) {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export async function GET(request: Request) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || request.headers.get("x-admin-key") !== password) return unauthorized();

  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const events = await readEvents(days);

  // Who's who. A visit only counts as human once that visitor did something real
  // (first click/tap/key/scroll, or a search/upload/play/download). Automated
  // user agents are tagged as bots; self-test and demo-seeding events are
  // housekeeping and never counted as traffic.
  const sidUA = new Map<string, string>();
  for (const e of events) if (e.ua && e.sid && !sidUA.has(e.sid)) sidUA.set(e.sid, e.ua);
  const isTest = (e: AnalyticsEvent) => e.type === "selftest" || (e.sid ?? "").startsWith("selftest");
  const isSystem = (e: AnalyticsEvent) => e.sid === DEMO_SESSION;
  // Server-side events (e.g. ingest_done) carry no user agent; inherit the sid's.
  const uaOf = (e: AnalyticsEvent) => e.ua ?? (e.sid ? sidUA.get(e.sid) : undefined);
  const isBot = (e: AnalyticsEvent) => {
    const ua = uaOf(e);
    return ua === undefined ? false : isBotUA(ua);
  };
  const engagedSids = new Set<string>();
  for (const e of events) {
    if (ENGAGEMENT.has(e.type) && e.sid && !isBot(e) && !isTest(e) && !isSystem(e)) {
      engagedSids.add(e.sid);
    }
  }
  const kindOf = (e: AnalyticsEvent): EventKind => {
    if (isTest(e)) return "test";
    if (isSystem(e)) return "system";
    if (isBot(e)) return "bot";
    return e.sid && engagedSids.has(e.sid) ? "human" : "unverified";
  };

  const totals = {
    visits: 0, // human (engaged) visits only
    uniqueVisitors: 0, // engaged human visitors
    unverifiedVisits: 0, // loaded the page, never interacted
    botVisits: 0,
    allVisits: 0,
    searches: 0,
    uploads: 0,
    ingests: 0,
    plays: 0,
    downloads: 0,
    errors: 0,
    botEvents: 0,
    testEvents: 0,
  };
  const byCountry: Record<string, number> = {};
  const byReferer: Record<string, number> = {};
  const byDayCost: Record<string, number> = {};
  const byDayCounts: Record<
    string,
    { visits: number; unverified: number; bots: number; searches: number; ingests: number }
  > = {};
  const byUA: Record<string, { count: number; bot: boolean }> = {};
  const costByType: Record<string, number> = {};
  let totalCostCents = 0;
  let uploadBytes = 0;

  const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const cleanRef = (r?: string) => {
    if (!r) return "direct";
    try {
      return new URL(r).hostname || "direct";
    } catch {
      return "direct";
    }
  };

  for (const e of events as AnalyticsEvent[]) {
    const day = dayOf(e.ts);
    byDayCounts[day] ??= { visits: 0, unverified: 0, bots: 0, searches: 0, ingests: 0 };
    const kind = kindOf(e);

    // Cost is real whoever caused it, so it's summed before any filtering.
    if (typeof e.costCents === "number" && e.costCents > 0) {
      totalCostCents += e.costCents;
      costByType[e.type] = (costByType[e.type] || 0) + e.costCents;
      byDayCost[day] = (byDayCost[day] || 0) + e.costCents;
    }

    if (kind === "test") {
      totals.testEvents++;
      continue;
    }
    if (e.type === "visit") {
      totals.allVisits++;
      const label = uaLabel(uaOf(e));
      byUA[label] ??= { count: 0, bot: kind === "bot" };
      byUA[label].count++;
    }
    if (kind === "system") continue;
    if (kind === "bot") {
      totals.botEvents++;
      if (e.type === "visit") {
        totals.botVisits++;
        byDayCounts[day].bots++;
      }
      continue;
    }
    if (e.type === "visit" && kind === "unverified") {
      totals.unverifiedVisits++;
      byDayCounts[day].unverified++;
      continue;
    }

    switch (e.type) {
      case "visit":
        totals.visits++;
        byDayCounts[day].visits++;
        byCountry[e.country || "Unknown"] = (byCountry[e.country || "Unknown"] || 0) + 1;
        byReferer[cleanRef(e.referer)] = (byReferer[cleanRef(e.referer)] || 0) + 1;
        break;
      case "search":
        totals.searches++;
        byDayCounts[day].searches++;
        break;
      case "upload":
        totals.uploads++;
        if (typeof e.meta?.bytes === "number") uploadBytes += e.meta.bytes;
        break;
      case "ingest_done":
        totals.ingests++;
        byDayCounts[day].ingests++;
        break;
      case "play":
        totals.plays++;
        break;
      case "download":
        totals.downloads++;
        break;
      case "error":
        totals.errors++;
        break;
    }
  }
  totals.uniqueVisitors = engagedSids.size;

  // Time series (oldest -> newest) for the chart.
  const series = Object.keys(byDayCounts)
    .sort()
    .map((day) => ({
      day,
      visits: byDayCounts[day].visits,
      unverified: byDayCounts[day].unverified,
      bots: byDayCounts[day].bots,
      searches: byDayCounts[day].searches,
      ingests: byDayCounts[day].ingests,
      costCents: byDayCost[day] || 0,
    }));

  const recent = (events as AnalyticsEvent[]).slice(0, 150).map((e) => ({
    ts: e.ts,
    type: e.type,
    sid: e.sid?.slice(0, 8),
    place: [e.city, e.country].filter(Boolean).join(", "),
    costCents: e.costCents,
    meta: e.meta,
    kind: kindOf(e),
    ua: uaLabel(uaOf(e)),
    uaRaw: uaOf(e)?.slice(0, 180),
  }));

  const byUserAgent = Object.entries(byUA)
    .map(([key, v]) => ({ key, count: v.count, bot: v.bot }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const storageMonthlyCents = storageMonthlyCostCents(uploadBytes);

  return NextResponse.json({
    rangeDays: days,
    totalEvents: events.length,
    totals,
    cost: {
      apiTotalCents: totalCostCents,
      byType: costByType,
      byDay: byDayCost,
      storageMonthlyCents,
      uploadBytes,
    },
    byCountry: topN(byCountry, 12),
    byReferer: topN(byReferer, 12),
    byUserAgent,
    series,
    recent,
  });
}
