import { Area, AreaChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { ChartBox, ChartTip, axis, grid } from "@/components/chart";
import type { LiveData } from "@/hooks/useLiveData";
import { clock, fmt } from "@/lib/utils";

const rel = (now: number) => (t: number) => `${Math.round((t - now) / 1000)} s`;
const xAxis = (now: number, span: number, ticks: number) => ({
  ...axis,
  dataKey: "t",
  type: "number" as const,
  domain: [now - span, now] as [number, number],
  allowDataOverflow: true,
  ticks: Array.from({ length: ticks + 1 }, (_, i) => now - span + (i * span) / ticks),
  tickFormatter: rel(now),
});

export function PpgChart({ d }: { d: LiveData }) {
  const now = d.now, t0 = now - 10000;
  const pts: { t: number; y: number }[] = [];
  for (let i = 0; i < d.ppg.t.length; i++) if (d.ppg.t[i] >= t0) pts.push({ t: d.ppg.t[i], y: d.ppg.y[i] });
  const beats = d.beats.filter((b) => b >= t0).map((b) => {
    const i = d.ppg.t.findIndex((t) => t >= b);
    return { t: b, y: i >= 0 ? d.ppg.y[i] : 0 };
  });
  return (
    <ChartBox className="h-56 lg:h-full lg:min-h-56">
      <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...grid} />
        <XAxis {...xAxis(now, 10000, 5)} />
        <YAxis {...axis} type="number" dataKey="y" domain={["auto", "auto"]} width={52} tickFormatter={(v: number) => fmt(v)} />
        <Line data={pts} dataKey="y" type="monotone" stroke="var(--chart-1)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
        <Scatter data={beats} dataKey="y" fill="var(--chart-2)" isAnimationActive={false} shape={(p: { cx?: number; cy?: number }) => (
          <circle cx={p.cx} cy={p.cy} r={4.5} fill="var(--chart-2)" stroke="var(--card)" strokeWidth={1.5} />
        )} />
      </ComposedChart>
    </ChartBox>
  );
}

type IbiPoint = { t: number; ibi: number; flag: string };

export function IbiChart({ d, span }: { d: LiveData; span: number }) {
  const now = d.now, t0 = now - span;
  const all: IbiPoint[] = d.ibis.filter((r) => r[0] >= t0).map(([t, ibi, flag]) => ({ t, ibi, flag }));
  const normal = all.filter((p) => !p.flag), odd = all.filter((p) => p.flag && p.flag !== "moving"), moved = all.filter((p) => p.flag === "moving");
  const sensor = d.hr.filter(([t, b]) => t >= t0 && b > 0).map(([t, b]) => ({ t, ibi: 60000 / b }));
  const vals = all.map((p) => p.ibi);
  const lo = Math.min(400, ...vals), hi = Math.max(1600, ...vals.filter((v) => v < 2600));
  const dot = (fill: string, r: number) => (p: { cx?: number; cy?: number }) => <circle cx={p.cx} cy={p.cy} r={r} fill={fill} />;
  return (
    <ChartBox className="h-64">
      <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...grid} />
        <XAxis {...xAxis(now, span, span >= 120000 ? 5 : 6)} />
        <YAxis {...axis} type="number" dataKey="ibi" domain={[Math.floor(lo / 100) * 100, Math.ceil(hi / 100) * 100]} width={52} allowDataOverflow />
        <Tooltip
          cursor={{ stroke: "var(--border)" }}
          content={({ active, payload }) => {
            const p = payload?.[0]?.payload as (IbiPoint & { flag?: string }) | undefined;
            if (!active || !p) return null;
            return (
              <ChartTip
                title={clock(p.t)}
                rows={[
                  { label: p.flag === undefined ? "HR sensor" : p.flag || "normal", value: `${fmt(p.ibi)} ms`, color: p.flag === undefined ? "var(--chart-5)" : p.flag === "moving" ? "var(--chart-6)" : p.flag ? "var(--chart-3)" : "var(--chart-1)" },
                  { label: "equals", value: `${fmt(60000 / p.ibi)} bpm`, color: "transparent" },
                ]}
              />
            );
          }}
        />
        {d.felt.filter((t) => t >= t0).map((t) => (
          <ReferenceLine key={t} x={t} stroke="var(--chart-4)" strokeWidth={2} strokeDasharray="4 3" label={{ value: "felt", position: "insideTopLeft", fill: "var(--chart-4)", fontSize: 10 }} />
        ))}
        <Line data={sensor} dataKey="ibi" type="stepAfter" stroke="var(--chart-5)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Scatter data={moved} dataKey="ibi" isAnimationActive={false} shape={dot("var(--chart-6)", 2.5)} />
        <Scatter data={normal} dataKey="ibi" isAnimationActive={false} shape={dot("var(--chart-1)", 2.8)} />
        <Scatter data={odd} dataKey="ibi" isAnimationActive={false} shape={dot("var(--chart-3)", 4.5)} />
      </ComposedChart>
    </ChartBox>
  );
}

export function BreathChart({ d }: { d: LiveData }) {
  const now = d.now;
  const pts = d.breath.t.map((t, i) => ({ t, y: d.breath.y[i] })).filter((p) => p.t >= now - 60000);
  return (
    <ChartBox className="h-36">
      <LineChart data={pts} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...grid} />
        <XAxis {...xAxis(now, 60000, 6)} />
        <YAxis {...axis} domain={["auto", "auto"]} width={52} tick={false} />
        <Line dataKey="y" type="monotone" stroke="var(--chart-5)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartBox>
  );
}

export function ActivityChart({ d }: { d: LiveData }) {
  const now = d.now;
  const pts = d.activity.t.map((t, i) => ({ t, y: d.activity.y[i] })).filter((p) => p.t >= now - 60000);
  const hi = Math.max(0.1, ...pts.map((p) => p.y));
  return (
    <ChartBox className="h-36">
      <AreaChart data={pts} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="actFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid {...grid} />
        <XAxis {...xAxis(now, 60000, 6)} />
        <YAxis {...axis} domain={[0, hi]} width={52} tickFormatter={(v: number) => v.toFixed(2)} />
        <ReferenceLine y={0.03} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
        <Area dataKey="y" type="monotone" stroke="var(--chart-2)" strokeWidth={1.5} fill="url(#actFill)" isAnimationActive={false} />
      </AreaChart>
    </ChartBox>
  );
}
