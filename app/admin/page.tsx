"use client";

import { useCallback, useEffect, useState } from "react";

// Password-gated analytics dashboard. The password is checked server-side by
// /api/admin/stats; here we just hold it (localStorage) and send it as a header.

interface Stats {
  rangeDays: number;
  totalEvents: number;
  totals: {
    visits: number;
    uniqueVisitors: number;
    searches: number;
    uploads: number;
    ingests: number;
    plays: number;
    downloads: number;
    errors: number;
  };
  cost: {
    apiTotalCents: number;
    byType: Record<string, number>;
    byDay: Record<string, number>;
    storageMonthlyCents: number;
    uploadBytes: number;
  };
  byCountry: { key: string; count: number }[];
  byReferer: { key: string; count: number }[];
  series: { day: string; visits: number; searches: number; ingests: number; costCents: number }[];
  recent: {
    ts: number;
    type: string;
    sid?: string;
    place?: string;
    costCents?: number;
    meta?: Record<string, string | number>;
  }[];
}

const usd = (cents: number) => {
  const d = (cents || 0) / 100;
  return d > 0 && d < 1 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
};
const fmtBytes = (b: number) => {
  if (!b) return "0 MB";
  const gb = b / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
};
const fmtTime = (ts: number) => new Date(ts).toLocaleString();

const TYPE_LABEL: Record<string, string> = {
  visit: "👁 visit",
  search: "🔎 search",
  upload: "⬆ upload",
  ingest_done: "✓ indexed",
  play: "▶ play",
  download: "↓ download",
  delete: "🗑 delete",
  error: "⚠ error",
};

export default function AdminPage() {
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("adminKey") : "";
    if (saved) setKey(saved);
  }, []);

  const load = useCallback(
    async (k: string, d: number) => {
      if (!k) return;
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/admin/stats?days=${d}`, {
          cache: "no-store",
          headers: { "x-admin-key": k },
        });
        if (res.status === 401) {
          setError("Wrong password.");
          setStats(null);
          localStorage.removeItem("adminKey");
          setKey("");
          return;
        }
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        const data = (await res.json()) as Stats;
        setStats(data);
        localStorage.setItem("adminKey", k);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (key) load(key, days);
  }, [key, days, load]);

  // Password gate.
  if (!key) {
    return (
      <main className="wrap" style={{ maxWidth: 420 }}>
        <h1 className="title" style={{ fontSize: 28 }}>
          Admin
        </h1>
        <p className="subtitle">Enter the admin password to view analytics.</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) setKey(input.trim());
          }}
        >
          <input
            type="password"
            placeholder="Admin password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="primary" type="submit">
            View
          </button>
        </form>
        {error && <div className="err">{error}</div>}
      </main>
    );
  }

  const t = stats?.totals;
  const maxVisits = Math.max(1, ...(stats?.series.map((s) => s.visits) ?? [1]));

  return (
    <main className="wrap">
      <div className="topbar">
        <h1 className="title" style={{ fontSize: 30 }}>
          Analytics
        </h1>
        <div className="row" style={{ gap: 8 }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            className="vault-btn"
            onClick={() => {
              localStorage.removeItem("adminKey");
              setKey("");
              setStats(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {loading && (
        <div className="muted" style={{ marginTop: 14 }}>
          <span className="spin" />
          Loading…
        </div>
      )}
      {error && <div className="err">{error}</div>}

      {stats && (
        <>
          {/* Headline numbers */}
          <div className="admin-grid">
            <Stat n={t!.uniqueVisitors} l="Unique visitors" />
            <Stat n={t!.visits} l="Visits" />
            <Stat n={t!.searches} l="Searches" />
            <Stat n={t!.ingests} l="Files indexed" />
            <Stat n={t!.plays} l="Plays" />
            <Stat n={t!.downloads} l="Downloads" />
            <Stat n={t!.errors} l="Errors" />
          </div>

          {/* Cost */}
          <div className="card">
            <strong>Estimated cost</strong>
            <div className="admin-grid" style={{ marginTop: 12, marginBottom: 0 }}>
              <Stat n={usd(stats.cost.apiTotalCents)} l={`API spend · ${stats.rangeDays}d`} />
              <Stat n={usd(stats.cost.storageMonthlyCents)} l="Storage / month" />
              <Stat n={usd(stats.cost.byType.ingest_done || 0)} l="Transcription" />
              <Stat n={usd(stats.cost.byType.search || 0)} l="Answers (LLM)" />
              <Stat n={fmtBytes(stats.cost.uploadBytes)} l="Audio stored" />
            </div>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
              Estimates from list prices (Groq transcription, Gemini tokens, Blob storage). Directional,
              not a bill.
            </p>
          </div>

          {/* Daily activity */}
          <div className="card">
            <strong>Daily visits</strong>
            <table className="admin-table" style={{ marginTop: 10 }}>
              <tbody>
                {stats.series.length === 0 && (
                  <tr>
                    <td className="muted">No activity yet.</td>
                  </tr>
                )}
                {stats.series
                  .slice()
                  .reverse()
                  .map((s) => (
                    <tr key={s.day}>
                      <td style={{ width: 96, whiteSpace: "nowrap" }}>{s.day.slice(5)}</td>
                      <td style={{ width: "55%" }}>
                        <div
                          className="admin-bar"
                          style={{ width: `${(s.visits / maxVisits) * 100}%` }}
                        />
                      </td>
                      <td style={{ width: 40, textAlign: "right" }}>{s.visits}</td>
                      <td className="muted" style={{ textAlign: "right" }}>
                        {s.searches} q · {usd(s.costCents)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* Geography + referrers */}
          <div className="admin-cols">
            <div className="card">
              <strong>Top countries</strong>
              <table className="admin-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Country</th>
                    <th style={{ textAlign: "right" }}>Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byCountry.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={2}>
                        No data yet.
                      </td>
                    </tr>
                  )}
                  {stats.byCountry.map((c) => (
                    <tr key={c.key}>
                      <td>{c.key}</td>
                      <td style={{ textAlign: "right" }}>{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <strong>Top referrers</strong>
              <table className="admin-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th style={{ textAlign: "right" }}>Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byReferer.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={2}>
                        No data yet.
                      </td>
                    </tr>
                  )}
                  {stats.byReferer.map((r) => (
                    <tr key={r.key}>
                      <td>{r.key}</td>
                      <td style={{ textAlign: "right" }}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent activity feed */}
          <div className="card">
            <strong>Recent activity</strong>
            <table className="admin-table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Where</th>
                  <th>Visitor</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((e, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.ts)}</td>
                    <td>
                      <span className="admin-chip">{TYPE_LABEL[e.type] || e.type}</span>
                    </td>
                    <td>{e.place || "·"}</td>
                    <td className="muted">{e.sid || "anon"}</td>
                    <td style={{ textAlign: "right" }}>{e.costCents ? usd(e.costCents) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {stats.totalEvents} events in the last {stats.rangeDays} days. IPs are never stored, only
            coarse country/city from the request.
          </p>
        </>
      )}
    </main>
  );
}

function Stat({ n, l }: { n: number | string; l: string }) {
  return (
    <div className="admin-stat">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}
