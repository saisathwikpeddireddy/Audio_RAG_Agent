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
    unverifiedVisits: number;
    botVisits: number;
    allVisits: number;
    botEvents: number;
    testEvents: number;
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
  byUserAgent: { key: string; count: number; bot: boolean }[];
  series: {
    day: string;
    visits: number;
    unverified: number;
    bots: number;
    searches: number;
    ingests: number;
    costCents: number;
  }[];
  recent: {
    ts: number;
    type: string;
    sid?: string;
    place?: string;
    costCents?: number;
    meta?: Record<string, string | number>;
    kind: Kind;
    ua: string;
    uaRaw?: string;
  }[];
}

type Kind = "human" | "unverified" | "bot" | "test" | "system";

const KIND_LABEL: Record<Kind, string> = {
  human: "human",
  unverified: "no interaction",
  bot: "bot",
  test: "self-test",
  system: "demo seeding",
};

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
  engaged: "👆 engaged",
  selftest: "🧪 self-test",
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
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(["human", "unverified"]));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SelfTest | null>(null);

  // Run a real search + play through the live handlers and confirm both events
  // were recorded, then refresh the numbers.
  const runSelfTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/admin/selftest", {
        cache: "no-store",
        headers: { "x-admin-key": key },
      });
      const data = (await res.json().catch(() => ({}))) as SelfTest;
      setTestResult(res.ok ? data : { ok: false, error: data.error || `Failed (${res.status})` });
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }, [key]);

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
            <Stat n={t!.uniqueVisitors} l="Human visitors" />
            <Stat n={t!.visits} l="Human visits" />
            <Stat n={t!.unverifiedVisits} l="No-interaction visits" />
            <Stat n={t!.botVisits} l="Bot visits" />
            <Stat n={t!.searches} l="Searches" />
            <Stat n={t!.ingests} l="Files indexed" />
            <Stat n={t!.plays} l="Plays" />
            <Stat n={t!.downloads} l="Downloads" />
            <Stat n={t!.errors} l="Errors" />
          </div>

          <p className="muted" style={{ marginTop: -6, fontSize: 12 }}>
            A visit counts as human once that visitor clicks, taps, types, or scrolls (or searches,
            plays, uploads). Known crawlers, link previews, monitors and headless browsers are tagged
            as bots and excluded. {t!.allVisits} page loads in total; self-test and demo-seeding
            events are never counted.
          </p>

          {/* Self-test */}
          <div className="card selftest">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <strong>Tracking self-test</strong>
              <button className="vault-btn" onClick={runSelfTest} disabled={testing}>
                {testing ? "Running…" : "Run a test search + play"}
              </button>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Sends one real search and one play beacon through the live endpoints, then checks both
              were recorded. Filed as self-test traffic, so it doesn&rsquo;t inflate your numbers.
            </p>
            {testResult && (
              <div style={{ marginTop: 10 }}>
                <strong style={{ color: testResult.ok ? "var(--good)" : "var(--bad)" }}>
                  {testResult.ok ? "✓ Search and play were both recorded." : "✗ Something is off."}
                </strong>
                {testResult.error && <div className="err">{testResult.error}</div>}
                {testResult.search && (
                  <pre>
                    {`Query: ${testResult.query}
Search: HTTP ${testResult.search.status} in ${testResult.search.ms} ms, ${testResult.search.hits?.length ?? 0} hits${
                      testResult.search.error ? ` (${testResult.search.error})` : ""
                    }
Answer: ${testResult.search.answer ?? "(none)"}
Play beacon: HTTP ${testResult.playBeacon?.status}
Recorded: search ${testResult.recorded?.search ? "yes" : "NO"}, play ${testResult.recorded?.play ? "yes" : "NO"}${
                      testResult.storeError ? `\nStore error: ${testResult.storeError}` : ""
                    }
Demo corpus: ${(testResult.demo ?? []).map((d) => `${d.id} ${d.status}`).join(", ") || "(empty)"}`}
                  </pre>
                )}
              </div>
            )}
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
            <strong>Daily human visits</strong>
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
                        +{s.unverified} idle · {s.bots} bot · {s.searches} q · {usd(s.costCents)}
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

          {/* User agents behind page loads */}
          <div className="card">
            <strong>Browsers &amp; bots (all page loads)</strong>
            <table className="admin-table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>User agent</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Loads</th>
                </tr>
              </thead>
              <tbody>
                {stats.byUserAgent.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={3}>
                      No data yet.
                    </td>
                  </tr>
                )}
                {stats.byUserAgent.map((u) => (
                  <tr key={u.key}>
                    <td>{u.key}</td>
                    <td>
                      <span className={`kind kind-${u.bot ? "bot" : "human"}`}>
                        {u.bot ? "bot" : "browser"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>{u.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recent activity feed */}
          <div className="card">
            <strong>Recent activity</strong>
            <div className="admin-filters">
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <button
                  key={k}
                  className={kinds.has(k) ? "on" : ""}
                  onClick={() =>
                    setKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      return next;
                    })
                  }
                >
                  {KIND_LABEL[k]} ({stats.recent.filter((e) => e.kind === k).length})
                </button>
              ))}
            </div>
            <table className="admin-table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Who</th>
                  <th>Where</th>
                  <th>Browser</th>
                  <th>Visitor</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent
                  .filter((e) => kinds.has(e.kind))
                  .slice(0, 80)
                  .map((e, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.ts)}</td>
                      <td>
                        <span className="admin-chip">{TYPE_LABEL[e.type] || e.type}</span>
                      </td>
                      <td>
                        <span className={`kind kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                      </td>
                      <td>{e.place || "·"}</td>
                      <td className="muted" title={e.uaRaw}>
                        {e.ua}
                      </td>
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

interface SelfTest {
  ok: boolean;
  error?: string;
  query?: string;
  search?: {
    status: number;
    ms: number;
    answer?: string;
    error?: string;
    hits?: { title?: string; at: string; score: number; text: string }[];
  };
  playBeacon?: { status: number };
  recorded?: Record<string, boolean>;
  storeError?: string;
  demo?: { id: string; status: string }[];
}

function Stat({ n, l }: { n: number | string; l: string }) {
  return (
    <div className="admin-stat">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}
