import { Activity, AlertTriangle, CheckCircle2, FolderOpen, HeartPulse, Info, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CartesianGrid, ComposedChart, Line, LineChart, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { ChartBox, ChartTip, Legend, axis, grid } from "@/components/chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { EcgReport, HrvRow } from "../../../src/ecg_probe.ts";
import type { Hrv } from "../../../src/lib/hrv.ts";
import type { LiveEcg } from "../../../src/live_core.ts";
import { clock, cn, fmt } from "@/lib/utils";

/** RMSSD / SDNN / extrasystoles with progress towards the standard 2 min. */
function HrvBlock({ h }: { h: Hrv | null }) {
  const pctDone = h ? Math.min(100, (h.durationS / 120) * 100) : 0;
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">HRV from ECG (whole test)</div>
      <div className="flex items-baseline gap-1">
        <span className={cn("text-4xl font-semibold tabular-nums", !h?.valid && "text-muted-foreground")}>{h?.rmssd != null ? fmt(h.rmssd, 1) : "–"}</span>
        <span className="text-sm text-muted-foreground">ms RMSSD</span>
      </div>
      <div className="font-mono text-xs tabular-nums text-muted-foreground">
        SDNN {h?.sdnn != null ? fmt(h.sdnn, 1) : "–"} ms · ES {h?.ectopic ?? 0} · {h ? `${h.nn}/${h.n}` : "0"} NN
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full", h?.valid ? "bg-[var(--chart-4)]" : "bg-[var(--chart-2)]")} style={{ width: `${pctDone}%` }} /></div>
      <div className="mt-1 text-xs text-muted-foreground">{h ? (h.valid ? `${Math.round(h.durationS)} s · valid` : h.note) : "waiting for 10 beats"}</div>
    </div>
  );
}

const Disclaimer = () => (
  <p className="text-xs text-muted-foreground">Experimental. Not a medical device, no diagnosis.</p>
);

/** Signal with R peaks; x = epoch ms, axis labels relative to `end`. */
function EcgTrace({ t, y, peaks, end, span, className }: { t: number[]; y: number[]; peaks: number[]; end: number; span: number; className?: string }) {
  const pts = t.map((tt, i) => ({ t: tt, y: y[i] })).filter((p) => p.t >= end - span && Number.isFinite(p.y));
  const pk = peaks.filter((p) => p >= end - span).map((p) => {
    const i = t.findIndex((tt) => tt >= p);
    return { t: p, y: i >= 0 ? y[i] : 0 };
  });
  const ticks = Array.from({ length: 6 }, (_, i) => end - span + (i * span) / 5);
  return (
    <ChartBox className={cn("h-56", className)}>
      <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...grid} />
        <XAxis {...axis} dataKey="t" type="number" domain={[end - span, end]} allowDataOverflow ticks={ticks}
          tickFormatter={(v: number) => `${Math.round((v - end) / 1000)} s`} />
        <YAxis {...axis} type="number" dataKey="y" domain={["auto", "auto"]} width={52} tickFormatter={(v: number) => fmt(v)} />
        <Line data={pts} dataKey="y" type="linear" stroke="var(--chart-1)" strokeWidth={1.3} dot={false} isAnimationActive={false} />
        <Scatter data={pk} dataKey="y" isAnimationActive={false}
          shape={(p: { cx?: number; cy?: number }) => <circle cx={p.cx} cy={p.cy} r={4} fill="var(--chart-3)" stroke="var(--card)" strokeWidth={1.5} />} />
      </ComposedChart>
    </ChartBox>
  );
}

/** RR intervals over time (dots), x = epoch ms. */
function RrDots({ t, rr, className }: { t: number[]; rr: number[]; className?: string }) {
  const pts = t.map((tt, i) => ({ t: tt, rr: rr[i] }));
  return (
    <ChartBox className={cn("h-40", className)}>
      <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...grid} />
        <XAxis {...axis} dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => clock(v)} />
        <YAxis {...axis} type="number" dataKey="rr" domain={["auto", "auto"]} width={56} tickFormatter={(v: number) => `${fmt(v)} ms`} />
        <Tooltip content={({ payload }) => payload?.[0] ? (
          <ChartTip title={clock(payload[0].payload.t)} rows={[{ label: "RR", value: `${payload[0].payload.rr} ms (${fmt(60000 / payload[0].payload.rr)} bpm)`, color: "var(--chart-1)" }]} />) : null} />
        <Scatter data={pts} dataKey="rr" isAnimationActive={false} fill="var(--chart-1)" />
      </ComposedChart>
    </ChartBox>
  );
}

/** Live ECG card on the Live tab, shown while the watch runs the ECG test (finger on the crown). */
export function LiveEcgCard({ e, now }: { e: LiveEcg; now: number }) {
  const end = e.t.length ? e.t[e.t.length - 1] : now;
  const stale = now - end > 3000;
  const leadOn = e.lead != null && Number(e.lead.value.split(/\s+/)[0]) === 1;
  const lastRr = e.rr.rr.length ? e.rr.rr[e.rr.rr.length - 1] : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Activity className="size-4 text-muted-foreground" />ECG (live)</CardTitle>
        <CardDescription>Last 10 s, band-pass 0.5–40 Hz · v{e.ch} · {fmt(e.fs, 0)} Hz · {e.events.toLocaleString("en-GB")} events</CardDescription>
        <CardAction className="flex flex-wrap gap-1.5">
          <Badge variant={e.looksEcg ? "success" : "warning"}>{e.looksEcg ? "R peaks found" : e.why}</Badge>
          <Badge variant={leadOn ? "success" : "outline"}>{e.lead ? (leadOn ? "finger on crown" : `lead ${e.lead.value}`) : "lead –"}</Badge>
          {stale && <Badge variant="warning">no new samples</Badge>}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[1fr_14rem]">
        <div className="grid gap-2">
          {e.t.length ? <EcgTrace t={e.t} y={e.y} peaks={e.peaks} end={end} span={10_000} className="h-72" /> :
            <p className="py-10 text-center text-sm text-muted-foreground">Lead detector reports, but no ECG samples yet.</p>}
          <p className="text-xs text-muted-foreground">The first seconds after touching the crown the signal sits at the rail and settles; those seconds are skipped automatically.</p>
        </div>
        <div className="grid content-start gap-3">
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><HeartPulse className="size-3.5" />HR from ECG</div>
            <div className={cn("text-5xl font-semibold tabular-nums", e.hr != null && e.looksEcg && "text-foreground", !e.looksEcg && "text-muted-foreground")}>{e.hr != null ? fmt(e.hr) : "–"}<span className="ml-1 text-base font-normal text-muted-foreground">bpm</span></div>
            <div className="text-xs text-muted-foreground">median of the last 10 s{lastRr != null ? ` · last RR ${lastRr} ms` : ""}</div>
          </div>
          <HrvBlock h={e.hrv} />
          <div className="text-xs text-muted-foreground">{e.rr.rr.length} RR intervals so far. Breathe normally; slow deep breathing inflates RMSSD.</div>
        </div>
        {e.rr.rr.length > 1 && <div className="lg:col-span-2"><div className="mb-1 text-sm font-medium">RR intervals of this test</div><RrDots t={e.rr.t} rr={e.rr.rr} /></div>}
        <div className="lg:col-span-2"><Disclaimer /></div>
      </CardContent>
    </Card>
  );
}

const VERDICT: Record<EcgReport["verdict"], { title: string; variant: "default" | "destructive" | "warning"; icon: typeof Info }> = {
  ecg: { title: "Looks like an ECG", variant: "default", icon: CheckCircle2 },
  not_ecg: { title: "Data, but no ECG pattern", variant: "warning", icon: AlertTriangle },
  constant: { title: "Constant values", variant: "warning", icon: AlertTriangle },
  blocked: { title: "ECG blocked?", variant: "destructive", icon: XCircle },
  no_file: { title: "No ECG data", variant: "destructive", icon: XCircle },
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/** HRV of all ECG tests (morning measurements) as a trend. */
function HrvHistoryCard({ onPick }: { onPick: (s: string) => void }) {
  const [rows, setRows] = useState<HrvRow[] | null>(null);
  useEffect(() => { fetch("/api/ecg/hrv").then((r) => r.json()).then((j) => setRows(j.rows ?? [])).catch(() => setRows([])); }, []);
  if (!rows?.length) return null;
  const pts = rows.map((r) => ({ t: r.start, rmssd: r.valid ? r.rmssd : null, rough: r.valid ? null : r.rmssd, hr: r.hr }));
  const day = (t: number) => new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><HeartPulse className="size-4 text-muted-foreground" />HRV history (ECG tests)</CardTitle>
        <CardDescription>RMSSD per test. Comparable only when measured the same way: right after waking, lying, 2 min, normal breathing.</CardDescription>
        <CardAction><Legend items={[{ label: "RMSSD ≥ 2 min", color: "var(--chart-1)" }, { label: "shorter (rough)", color: "var(--chart-6)" }]} /></CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {rows.length > 1 && (
          <ChartBox className="h-44">
            <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid {...grid} />
              <XAxis {...axis} dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={day} />
              <YAxis {...axis} type="number" domain={["auto", "auto"]} width={40} />
              <Tooltip content={({ payload }) => payload?.length ? (
                <ChartTip title={`${day(Number(payload[0].payload?.t))} ${clock(Number(payload[0].payload?.t)).slice(0, 5)}`} rows={payload.map((p) => ({ label: String(p.name), value: `${fmt(Number(p.value), 1)} ms`, color: String(p.color) }))} />) : null} />
              <Scatter data={pts} dataKey="rmssd" name="RMSSD" fill="var(--chart-1)" isAnimationActive={false} />
              <Scatter data={pts} dataKey="rough" name="RMSSD (short)" fill="var(--chart-6)" isAnimationActive={false} />
            </ComposedChart>
          </ChartBox>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-muted-foreground"><tr className="text-left">
              <th className="py-1 pr-3 font-normal">Test</th><th className="pr-3 font-normal">Duration</th><th className="pr-3 font-normal">HR</th>
              <th className="pr-3 font-normal">RMSSD</th><th className="pr-3 font-normal">SDNN</th><th className="pr-3 font-normal">ES</th><th className="font-normal">Note</th></tr></thead>
            <tbody>
              {rows.slice().reverse().map((r) => (
                <tr key={r.session} className="cursor-pointer border-t hover:bg-muted/50" onClick={() => onPick(r.session)}>
                  <td className="py-1 pr-3 font-mono">{day(r.start)} {clock(r.start).slice(0, 5)}</td>
                  <td className="pr-3">{Math.round(r.durationS)} s</td>
                  <td className="pr-3">{r.hr != null ? fmt(r.hr) : "–"}</td>
                  <td className={cn("pr-3 font-medium", !r.valid && "text-muted-foreground")}>{r.rmssd != null ? fmt(r.rmssd, 1) : "–"}</td>
                  <td className="pr-3">{r.sdnn != null ? fmt(r.sdnn, 1) : "–"}</td>
                  <td className="pr-3">{r.ectopic}</td>
                  <td className="text-xs text-muted-foreground">{r.valid ? "" : r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/** "ECG test" tab: pick a saved session and show the ecg_probe report. */
export function EcgTestView() {
  const [list, setList] = useState<{ dir: string; sessions: string[] } | null>(null);
  const [name, setName] = useState<string>("");
  const [rep, setRep] = useState<EcgReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(() => {
    fetch("/api/ecg/sessions").then((r) => r.json()).then((l) => {
      setList(l);
      setName((cur) => (cur && l.sessions.includes(cur) ? cur : l.sessions[0] ?? ""));
    }).catch(() => setErr("server unreachable"));
  }, []);
  useEffect(loadList, [loadList]);

  useEffect(() => {
    if (!name) { setRep(null); return; }
    setLoading(true); setErr("");
    fetch(`/api/ecg/sessions/${encodeURIComponent(name)}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); })
      .then(setRep).catch((e) => { setRep(null); setErr(String(e.message ?? e)); }).finally(() => setLoading(false));
  }, [name]);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FolderOpen className="size-4 text-muted-foreground" />ECG test</CardTitle>
          <CardDescription>
            Sessions from the watch's "ECG test" button (150 s, finger of the other hand on the crown).
            {list && <> Folder: <code className="font-mono">{list.dir}</code></>}
          </CardDescription>
          <CardAction className="flex items-center gap-2">
            <select value={name} onChange={(e) => setName(e.target.value)} disabled={!list?.sessions.length}
              className="h-8 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30">
              {!list?.sessions.length && <option value="">no ECG sessions</option>}
              {list?.sessions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <Button variant="outline" size="icon" onClick={loadList} aria-label="Reload list"><RefreshCw className={cn(loading && "animate-spin")} /></Button>
          </CardAction>
        </CardHeader>
        {list && !list.sessions.length && (
          <CardContent className="text-sm text-muted-foreground">
            No session with <code className="font-mono">raw_ecg.csv</code> found. Run the ECG test on the watch, export the session
            (README, section "ECG test") into this folder, or start the server with <code className="font-mono">--sessions &lt;dir&gt;</code>.
          </CardContent>
        )}
      </Card>

      <HrvHistoryCard onPick={setName} />

      {err && <Alert variant="destructive"><AlertTriangle /><AlertTitle>Could not load the report</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
      {rep && <EcgReportView r={rep} />}
    </div>
  );
}

function EcgReportView({ r }: { r: EcgReport }) {
  const v = VERDICT[r.verdict];
  const Icon = v.icon;
  const rrOk = r.rr.rr.filter((x) => x >= 300 && x <= 2000);
  const hrSensor = r.hrSensor.bpm.length ? r.hrSensor.bpm.reduce((a, b) => a + b, 0) / r.hrSensor.bpm.length : null;
  const t0 = r.ecg?.firstMs ?? r.lead?.firstMs ?? 0, t1 = r.ecg?.lastMs ?? r.lead?.lastMs ?? 1;
  const rel = (t: number) => `${Math.round((t - t0) / 1000)} s`;
  return (
    <>
      <Alert variant={v.variant}>
        <Icon />
        <AlertTitle>{v.title}</AlertTitle>
        <AlertDescription>{r.verdictText}</AlertDescription>
      </Alert>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="ECG events" value={(r.ecg?.events ?? 0).toLocaleString("en-GB")} hint={r.ecg ? `${fmt(r.ecg.durationS, 1)} s` : "no file"} />
        <Stat label="Rate" value={r.ecg ? `${fmt(r.ecg.eventRateHz, 0)} Hz` : "–"} hint={r.ecg ? `values/event ${Object.keys(r.ecg.valuesPerEvent).join(", ") || "–"}` : undefined} />
        <Stat label="HR from ECG" value={r.best?.hr != null ? `${fmt(r.best.hr)} bpm` : "–"} hint={r.best ? `${r.best.label}, ${rrOk.length} RR` : undefined} />
        <Stat label="HR sensor" value={hrSensor != null ? `${fmt(hrSensor)} bpm` : "–"} hint="watch, same period" />
        <Stat label="HR from PPG" value={r.ppg?.hr != null ? `${fmt(r.ppg.hr)} bpm` : "–"} hint={r.ppg ? `${r.ppg.t.length} clean beats` : "no raw_ppg.csv"} />
        <Stat label="RMSSD (ECG)" value={r.hrv?.rmssd != null ? `${fmt(r.hrv.rmssd, 1)} ms` : "–"} hint={r.hrv ? (r.hrv.valid ? `SDNN ${fmt(r.hrv.sdnn ?? NaN, 1)} ms · ES ${r.hrv.ectopic}` : r.hrv.note) : undefined} />
        <Stat label="R → pulse wave" value={r.ppg?.ptt != null ? `${fmt(r.ppg.ptt)} ms` : "–"} hint={r.ppg?.ptt != null ? `median, ${r.ppg.matched} pairs` : undefined} />
      </div>

      {r.snippet && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Raw signal</CardTitle>
              <CardDescription>{r.best?.label}, 10 s from {clock(r.snippet.t[0])}</CardDescription>
            </CardHeader>
            <CardContent>
              <EcgTrace t={r.snippet.t} y={r.snippet.raw} peaks={[]} end={r.snippet.t[r.snippet.t.length - 1]} span={r.snippet.t[r.snippet.t.length - 1] - r.snippet.t[0]} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Filtered with R peaks</CardTitle>
              <CardDescription>Band-pass 0.5–40 Hz, polarity so R points up</CardDescription>
              <CardAction><Legend items={[{ label: "ECG", color: "var(--chart-1)", line: true }, { label: "R peak", color: "var(--chart-3)" }]} /></CardAction>
            </CardHeader>
            <CardContent>
              <EcgTrace t={r.snippet.t} y={r.snippet.filt} peaks={r.snippet.peaks} end={r.snippet.t[r.snippet.t.length - 1]} span={r.snippet.t[r.snippet.t.length - 1] - r.snippet.t[0]} />
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HeartPulse className="size-4 text-muted-foreground" />RR intervals over the test</CardTitle>
            <CardDescription>ECG against PPG beats and the watch's heart-rate sensor (as interval)</CardDescription>
            <CardAction><Legend items={[{ label: "ECG", color: "var(--chart-1)" }, { label: "PPG", color: "var(--chart-2)" }, { label: "HR sensor", color: "var(--chart-5)", line: true }]} /></CardAction>
          </CardHeader>
          <CardContent>
            <ChartBox className="h-64">
              <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid {...grid} />
                <XAxis {...axis} dataKey="t" type="number" domain={[t0, t1]} tickFormatter={rel} />
                <YAxis {...axis} dataKey="rr" type="number" domain={["auto", "auto"]} width={52} />
                <Tooltip content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as { t: number; rr: number } | undefined;
                  return active && p ? <ChartTip title={clock(p.t)} rows={[{ label: "interval", value: `${fmt(p.rr)} ms`, color: "var(--chart-1)" }, { label: "equals", value: `${fmt(60000 / p.rr)} bpm`, color: "transparent" }]} /> : null;
                }} />
                <Line data={r.hrSensor.t.map((t, i) => ({ t, rr: 60000 / r.hrSensor.bpm[i] }))} dataKey="rr" type="stepAfter" stroke="var(--chart-5)" dot={false} isAnimationActive={false} />
                {r.ppg && <Scatter data={r.ppg.t.map((t, i) => ({ t, rr: r.ppg!.ibi[i] }))} dataKey="rr" isAnimationActive={false}
                  shape={(p: { cx?: number; cy?: number }) => <circle cx={p.cx} cy={p.cy} r={2.5} fill="var(--chart-2)" />} />}
                <Scatter data={r.rr.t.map((t, i) => ({ t, rr: r.rr.rr[i] }))} dataKey="rr" isAnimationActive={false}
                  shape={(p: { cx?: number; cy?: number }) => <circle cx={p.cx} cy={p.cy} r={3} fill="var(--chart-1)" />} />
              </ComposedChart>
            </ChartBox>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lead detector</CardTitle>
            <CardDescription>{r.lead ? `${r.lead.events} events, ${r.leadChanges.length} states` : "no raw_ecg_lead.csv"}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {r.leadSeries.t.length > 0 && (
              <ChartBox className="h-28">
                <LineChart data={r.leadSeries.t.map((t, i) => ({ t, v: r.leadSeries.v[i] }))} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid {...grid} />
                  <XAxis {...axis} dataKey="t" type="number" domain={[t0, t1]} tickFormatter={rel} />
                  <YAxis {...axis} domain={["auto", "auto"]} width={52} allowDecimals={false} />
                  <Line dataKey="v" type="stepAfter" stroke="var(--chart-4)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ChartBox>
            )}
            <div className="max-h-40 overflow-y-auto text-xs">
              {r.leadChanges.map((c) => (
                <div key={c.t} className="flex justify-between border-b py-1 last:border-0">
                  <span className="font-mono tabular-nums">{clock(c.t)}</span><span className="font-mono">{c.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Channels</CardTitle>
            <CardDescription>Statistics per value position of raw_ecg.csv</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {r.channels.length ? (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">{["", "mean", "std", "min", "max", "unique"].map((h) => <th key={h} className="px-5 py-2 text-right font-medium first:text-left">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {r.channels.map((c) => (
                    <tr key={c.name} className={cn("border-b font-mono text-xs tabular-nums last:border-0", c.name === r.best?.label && "bg-muted/50")}>
                      <td className="px-5 py-2">{c.name}</td>
                      <td className="px-5 py-2 text-right">{fmt(c.mean, 2)}</td><td className="px-5 py-2 text-right">{fmt(c.std, 2)}</td>
                      <td className="px-5 py-2 text-right">{fmt(c.min, 2)}</td><td className="px-5 py-2 text-right">{fmt(c.max, 2)}</td>
                      <td className="px-5 py-2 text-right">{c.unique}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="px-5 text-sm text-muted-foreground">No ECG values.</p>}
          </CardContent>
        </Card>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Report</CardTitle>
            <CardDescription>ecg_summary.txt and what the app logged in events.csv</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{r.lines.join("\n")}</pre>
            {r.registration.length > 0 && (
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{r.registration.join("\n")}</pre>
            )}
            <Disclaimer />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
