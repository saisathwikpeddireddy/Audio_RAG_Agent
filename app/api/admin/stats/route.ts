// Admin analytics aggregation. Reads recent events from Blob and rolls them up
// into the numbers the dashboard renders. Gated by ADMIN_PASSWORD (sent as the
// x-admin-key header by the /admin page).

import { NextResponse } from "next/server";
import { readEvents, type AnalyticsEvent } from "@/lib/analytics";
import { storageMonthlyCostCents } from "@/lib/costs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

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

  const totals = {
    visits: 0,
    uniqueVisitors: 0,
    searches: 0,
    uploads: 0,
    ingests: 0,
    plays: 0,
    downloads: 0,
    errors: 0,
  };
  const visitorSids = new Set<string>();
  const byCountry: Record<string, number> = {};
  const byReferer: Record<string, number> = {};
  const byDayCost: Record<string, number> = {};
  const byDayCounts: Record<string, { visits: number; searches: number; ingests: number }> = {};
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
    if (e.sid && e.sid !== "anon") visitorSids.add(e.sid);
    const day = dayOf(e.ts);
    byDayCounts[day] ??= { visits: 0, searches: 0, ingests: 0 };

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

    if (typeof e.costCents === "number" && e.costCents > 0) {
      totalCostCents += e.costCents;
      costByType[e.type] = (costByType[e.type] || 0) + e.costCents;
      byDayCost[day] = (byDayCost[day] || 0) + e.costCents;
    }
  }
  totals.uniqueVisitors = visitorSids.size;

  // Time series (oldest -> newest) for the chart.
  const series = Object.keys(byDayCounts)
    .sort()
    .map((day) => ({
      day,
      visits: byDayCounts[day].visits,
      searches: byDayCounts[day].searches,
      ingests: byDayCounts[day].ingests,
      costCents: byDayCost[day] || 0,
    }));

  const recent = (events as AnalyticsEvent[]).slice(0, 60).map((e) => ({
    ts: e.ts,
    type: e.type,
    sid: e.sid?.slice(0, 8),
    place: [e.city, e.country].filter(Boolean).join(", "),
    costCents: e.costCents,
    meta: e.meta,
  }));

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
    series,
    recent,
  });
}
