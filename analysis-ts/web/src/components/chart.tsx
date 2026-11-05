import type * as React from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

/** Gemeinsame Achsen-/Rasteroptik im shadcn-Stil. */
export const axis = {
  stroke: "var(--muted-foreground)",
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;
export const grid = { stroke: "var(--border)", strokeDasharray: "3 3", vertical: false } as const;

export function ChartBox({ className, children }: { className?: string; children: React.ReactElement }) {
  return (
    <div className={cn("w-full text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground", className)}>
      <ResponsiveContainer width="100%" height="100%" debounce={50}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export interface TipRow { label: string; value: string; color: string }

export function ChartTip({ title, rows }: { title?: string; rows: TipRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="grid min-w-36 gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl">
      {title && <div className="font-medium">{title}</div>}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: r.color }} />
          <span className="text-muted-foreground">{r.label}</span>
          <span className="ml-auto font-mono font-medium tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className={i.line ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-[2px]"} style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Winzige SVG-Linie für Kennzahl-Karten (ohne Recharts, damit 4 Hz billig bleiben). */
export function Sparkline({ values, color, className }: { values: (number | null)[]; color: string; className?: string }) {
  const v = values.map((x, i) => [i, x] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (v.length < 2) return <div className={cn("h-8", className)} />;
  const n = values.length - 1 || 1;
  let lo = Math.min(...v.map((p) => p[1])), hi = Math.max(...v.map((p) => p[1]));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pts = v.map(([i, y]) => `${((i / n) * 100).toFixed(2)},${(28 - ((y - lo) / (hi - lo)) * 24).toFixed(2)}`);
  const id = `sg-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={cn("h-8 w-full", className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`${pts[0].split(",")[0]},32 ${pts.join(" ")} ${pts[pts.length - 1].split(",")[0]},32`} fill={`url(#${id})`} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
