import { Droplets } from "lucide-react";
import { useEffect, useState } from "react";
import { CartesianGrid, ComposedChart, Line, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { ChartBox, ChartTip, Legend, axis, grid } from "@/components/chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SpO2Point } from "../../../src/live_core.ts";
import { clock, fmt } from "@/lib/utils";

const SPAN = 10 * 60_000;

/** Wall clock with tenths, large enough to be readable in a phone video next to the oximeter. */
function BigClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(id); }, []);
  return (
    <div className="rounded-lg border bg-muted/40 px-4 py-3 text-center font-mono text-5xl font-semibold tabular-nums tracking-tight">
      {clock(now)}<span className="text-3xl text-muted-foreground">.{Math.floor((now % 1000) / 100)}</span>
    </div>
  );
}

function OximeterInput() {
  const [v, setV] = useState("");
  const [msg, setMsg] = useState("");
  const save = async () => {
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n < 50 || n > 100) { setMsg("50–100"); return; }
    const t = Date.now();
    try {
      const r = await fetch("/api/oximeter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: n }) });
      setMsg(r.ok ? `${n} % at ${clock(t)} saved` : `error ${r.status}`);
      if (r.ok) setV("");
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-muted-foreground" htmlFor="oxi">Oximeter value (Enter saves with the current time)</label>
      <div className="flex gap-2">
        <input id="oxi" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="e.g. 97" className="h-9 w-24 rounded-md border bg-background px-3 font-mono text-base tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button size="sm" onClick={save}>Save</Button>
      </div>
      <div className="h-4 text-xs text-muted-foreground">{msg}</div>
    </div>
  );
}

/** Live SpO2 experiment: channel ratios, the uncalibrated estimate and the oximeter readings. */
export function Spo2Card({ points, oximeter, now }: { points: SpO2Point[]; oximeter: [number, number][]; now: number }) {
  const end = points.length ? points[points.length - 1].t : now;
  const recent = points.filter((p) => p.t >= end - SPAN);
  const last = recent[recent.length - 1];
  const still = recent.filter((p) => !p.moving);
  const oxi = oximeter.filter(([t]) => t >= end - SPAN).map(([t, v]) => ({ t, oxi: v }));
  const est = recent.map((p) => ({ t: p.t, est: p.moving ? null : p.est }));
  const ratios = recent.map((p) => ({ t: p.t, r41: p.moving ? null : p.r41, r31: p.moving ? null : p.r31, r43: p.moving ? null : p.r43 }));
  const xAxis = <XAxis {...axis} dataKey="t" type="number" domain={[end - SPAN, end]} allowDataOverflow tickFormatter={(v: number) => clock(v).slice(0, 5)} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Droplets className="size-4 text-muted-foreground" />SpO2 test (uncalibrated)</CardTitle>
        <CardDescription>Perfusion index of the LED channels over 8 s, every 2 s. Film the oximeter together with this clock.</CardDescription>
        <CardAction className="flex flex-wrap gap-1.5">
          {last?.moving && <Badge variant="warning">moving – ignored</Badge>}
          <Badge variant="outline">{still.length} still points</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="grid content-start gap-4">
          <BigClock />
          <OximeterInput />
          <div className="grid grid-cols-3 gap-2 text-center">
            {([["v4/v1", last?.r41], ["v3/v1", last?.r31], ["v4/v3", last?.r43]] as const).map(([k, v]) => (
              <div key={k} className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="font-mono text-lg tabular-nums">{fmt(v, 3)}</div>
              </div>
            ))}
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">Hypothesis 110 − 25·(v4/v1)</div>
            <div className="text-3xl font-semibold tabular-nums text-muted-foreground">{fmt(last?.est, 1)}<span className="ml-1 text-base font-normal">%</span></div>
            <div className="text-xs text-muted-foreground">not a measurement until calibrated</div>
          </div>
        </div>
        <div className="grid gap-4">
          <div>
            <div className="mb-1 flex items-center justify-between"><span className="text-sm font-medium">Estimate vs. oximeter (10 min)</span>
              <Legend items={[{ label: "hypothesis", color: "var(--chart-6)", line: true }, { label: "oximeter", color: "var(--chart-3)" }]} /></div>
            <ChartBox className="h-48">
              <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...grid} />
                {xAxis}
                <YAxis {...axis} type="number" domain={[85, 100]} allowDataOverflow width={36} />
                <Tooltip content={({ payload }) => payload?.length ? (
                  <ChartTip title={clock(payload[0].payload.t)} rows={payload.map((p) => ({ label: String(p.name), value: fmt(Number(p.value), 1), color: String(p.color) }))} />) : null} />
                <Line data={est} dataKey="est" name="hypothesis" type="linear" stroke="var(--chart-6)" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
                <Scatter data={oxi} dataKey="oxi" name="oximeter" fill="var(--chart-3)" isAnimationActive={false} />
              </ComposedChart>
            </ChartBox>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between"><span className="text-sm font-medium">Channel ratios (10 min)</span>
              <Legend items={[{ label: "v4/v1", color: "var(--chart-1)", line: true }, { label: "v3/v1", color: "var(--chart-2)", line: true }, { label: "v4/v3", color: "var(--chart-4)", line: true }]} /></div>
            <ChartBox className="h-48">
              <ComposedChart data={ratios} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...grid} />
                {xAxis}
                <YAxis {...axis} type="number" domain={["auto", "auto"]} width={44} tickFormatter={(v: number) => fmt(v, 2)} />
                <Line dataKey="r41" type="linear" stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line dataKey="r31" type="linear" stroke="var(--chart-2)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line dataKey="r43" type="linear" stroke="var(--chart-4)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ChartBox>
          </div>
          <p className="text-xs text-muted-foreground">
            Which LED is red and which infrared is not known yet. The calibration test decides which ratio follows the oximeter.
            Experimental, not a medical device.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
