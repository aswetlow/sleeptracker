import { Activity, AlertTriangle, Cpu, HeartPulse, Moon, Pause, Play, Radio, Sun, Waves, Wind, Zap } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Legend, Sparkline } from "@/components/chart";
import { ActivityChart, BreathChart, IbiChart, PpgChart } from "@/components/charts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLiveData, type HistoryPoint, type LiveData } from "@/hooks/useLiveData";
import { clock, cn, fmt } from "@/lib/utils";

export function App() {
  const [paused, setPaused] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [span, setSpan] = useState("300000");
  const { data, online, history } = useLiveData(paused);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch { /* egal */ }
  }, [dark]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-svh">
        <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <HeartPulse className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight">SleepLogger<span className="hidden sm:inline"> Live-Analyzer</span></h1>
              <p className="truncate text-xs text-muted-foreground">{data?.meta.source ?? "verbinde …"}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ConnectionBadge online={online} connected={!!data?.connected} />
              {data && <Badge variant="outline" className="hidden sm:inline-flex">{{ live: "Live", demo: "Demo", replay: "Replay" }[data.meta.mode]}</Badge>}
              {data?.meta.recording && (
                <Badge variant="destructive" className="hidden md:inline-flex"><span className="size-1.5 rounded-full bg-current" />REC</Badge>
              )}
              <Separator orientation="vertical" className="mx-1 h-6" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={() => setPaused((p) => !p)} aria-label={paused ? "Fortsetzen" : "Anhalten"}>
                    {paused ? <Play /> : <Pause />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{paused ? "Anzeige fortsetzen" : "Anzeige einfrieren (Daten laufen weiter)"}</TooltipContent>
              </Tooltip>
              <Button variant="ghost" size="icon" onClick={() => setDark((v) => !v)} aria-label="Farbschema wechseln">
                {dark ? <Sun /> : <Moon />}
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto grid max-w-7xl gap-4 p-4">
          {!online && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Server nicht erreichbar</AlertTitle>
              <AlertDescription>Läuft <code className="font-mono">npm run ui</code> noch? Die Seite verbindet sich automatisch neu.</AlertDescription>
            </Alert>
          )}
          {data ? <Dashboard d={data} history={history} span={span} setSpan={setSpan} paused={paused} /> : <Skeleton />}
        </main>
      </div>
    </TooltipProvider>
  );
}

function ConnectionBadge({ online, connected }: { online: boolean; connected: boolean }) {
  const [label, cls, ping] = !online ? ["Server offline", "bg-destructive", false] : connected ? ["Uhr verbunden", "bg-chart-4", true] : ["warte auf Uhr", "bg-chart-2", false];
  return (
    <Badge variant="secondary" className="gap-2 py-1">
      <span className="relative flex size-2">
        {ping && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-75", cls)} />}
        <span className={cn("relative inline-flex size-2 rounded-full", cls)} />
      </span>
      <span className="hidden sm:inline">{label}</span>
    </Badge>
  );
}

function Dashboard({ d, history, span, setSpan, paused }: { d: LiveData; history: HistoryPoint[]; span: string; setSpan: (s: string) => void; paused: boolean }) {
  const n = d.numbers;
  const noPpg = d.connected && !d.counts.p;
  return (
    <>
      {paused && (
        <Alert>
          <Pause />
          <AlertTitle>Anzeige angehalten</AlertTitle>
          <AlertDescription>Empfang und Aufzeichnung laufen weiter. Mit ▶ oben rechts fortsetzen.</AlertDescription>
        </Alert>
      )}
      {noPpg && (
        <Alert variant="warning">
          <Radio />
          <AlertTitle>Keine Pulswelle</AlertTitle>
          <AlertDescription>Auf der Uhr mit „Start + PPG“ starten. Ohne Pulswelle gibt es nur den Pulssensor und Bewegung.</AlertDescription>
        </Alert>
      )}
      {!!d.counts.p_zu_kurz && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>{d.counts.p_zu_kurz} PPG-Zeilen zu kurz</AlertTitle>
          <AlertDescription>Gewählter Kanal v{d.diag.ch} fehlt in den Zeilen. Anderen Kanal mit <code className="font-mono">--channel</code> wählen.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Kpi icon={<HeartPulse />} label="Puls aus Pulswelle" unit="bpm" value={fmt(n.hr_ppg)} spark={history.map((h) => h.hr_ppg)} color="var(--chart-1)"
          hint={n.hr_ppg != null && n.hr_sensor != null ? `${n.hr_ppg - n.hr_sensor >= 0 ? "+" : ""}${fmt(n.hr_ppg - n.hr_sensor, 1)} zum Sensor` : "Median der letzten 10 sauberen Schläge"} />
        <Kpi icon={<Zap />} label="Pulssensor der Uhr" unit="bpm" value={fmt(n.hr_sensor)} spark={history.map((h) => h.hr_sensor)} color="var(--chart-5)" hint="geglättet von Wear OS" />
        <Kpi icon={<Activity />} label="RMSSD (60 s)" unit="ms" value={fmt(n.rmssd)} spark={history.map((h) => h.rmssd)} color="var(--chart-4)" hint="Kurzzeit-HRV aus sauberen Intervallen" />
        <Kpi icon={<Wind />} label="Atemzüge" unit="/min" value={fmt(n.breath, 1)} spark={history.map((h) => h.breath)} color="var(--chart-5)"
          footer={
            <div className="grid gap-1">
              <div className="flex justify-between text-xs text-muted-foreground"><span>Qualität</span><span className="font-mono tabular-nums">{fmt(n.breath_q, 2)}</span></div>
              <Progress value={n.breath_q * 100} indicatorClassName={n.breath_q >= 0.5 ? "bg-chart-4" : n.breath_q >= 0.3 ? "bg-chart-2" : "bg-chart-3"} />
            </div>
          } />
        <Kpi icon={<AlertTriangle />} label="Kandidaten / Gespürt" unit="5 min" value={`${n.candidates_5min} / ${n.felt_5min}`} className="col-span-2 md:col-span-1"
          footer={<FlagSummary d={d} />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Waves className="size-4 text-muted-foreground" />Pulswelle</CardTitle>
            <CardDescription>Letzte 10 s, Bandpass 0,6–3,5 Hz · Kanal v{d.diag.ch}{d.diag.auto ? " (auto)" : ""}</CardDescription>
            <CardAction><Legend items={[{ label: "PPG gefiltert", color: "var(--chart-1)", line: true }, { label: "Schlag", color: "var(--chart-2)" }]} /></CardAction>
          </CardHeader>
          <CardContent className="flex-1"><PpgChart d={d} /></CardContent>
        </Card>
        <Diagnostics d={d} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HeartPulse className="size-4 text-muted-foreground" />Schlagintervalle</CardTitle>
            <CardDescription>Abstand von Schlag zu Schlag in ms. Auffällige Intervalle sind Kandidaten, keine Diagnose.</CardDescription>
            <CardAction>
              <Tabs value={span} onValueChange={setSpan}>
                <TabsList>
                  <TabsTrigger value="60000">1 min</TabsTrigger>
                  <TabsTrigger value="120000">2 min</TabsTrigger>
                  <TabsTrigger value="300000">5 min</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-3">
            <IbiChart d={d} span={Number(span)} />
            <Legend items={[
              { label: "normal", color: "var(--chart-1)" }, { label: "auffällig", color: "var(--chart-3)" }, { label: "Bewegung", color: "var(--chart-6)" },
              { label: "Pulssensor", color: "var(--chart-5)", line: true }, { label: "gespürt", color: "var(--chart-4)", line: true },
            ]} />
          </CardContent>
        </Card>
        <Events d={d} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Wind className="size-4 text-muted-foreground" />Atembewegung</CardTitle>
            <CardDescription>Letzte 60 s, Hauptkomponente aus {d.counts.g ? "Gyroskop" : "Beschleunigung"} (0,1–0,5 Hz)</CardDescription>
            <CardAction><Badge variant={d.breath.rate ? "success" : "secondary"}>{d.breath.rate ? `${fmt(d.breath.rate, 1)} /min` : "kein Rhythmus"}</Badge></CardAction>
          </CardHeader>
          <CardContent><BreathChart d={d} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="size-4 text-muted-foreground" />Bewegung</CardTitle>
            <CardDescription>Letzte 60 s, Streuung von |a| pro Sekunde · gestrichelt = Bewegungsschwelle</CardDescription>
          </CardHeader>
          <CardContent><ActivityChart d={d} /></CardContent>
        </Card>
      </div>
    </>
  );
}

function Kpi({ icon, label, unit, value, spark, color, hint, footer, className }: {
  icon: ReactNode; label: string; unit: string; value: string; spark?: (number | null)[]; color?: string; hint?: string; footer?: ReactNode; className?: string;
}) {
  return (
    <Card className={cn("gap-3 py-4", className)}>
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-1.5 [&_svg]:size-3.5">{icon}{label}</CardDescription>
        <CardTitle className="flex items-baseline gap-1.5 text-3xl font-semibold tabular-nums">
          {value}<span className="text-sm font-normal text-muted-foreground">{unit}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        {spark && color && <Sparkline values={spark} color={color} />}
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
        {footer}
      </CardContent>
    </Card>
  );
}

function FlagSummary({ d }: { d: LiveData }) {
  const c: Record<string, number> = { kurz: 0, "Puls fehlt": 0, Pause: 0 };
  for (const r of d.ibis) if (r[2] in c) c[r[2]]++;
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(c).map(([k, v]) => <Badge key={k} variant={v ? "destructive" : "secondary"}>{k} {v}</Badge>)}
    </div>
  );
}

function Events({ d }: { d: LiveData }) {
  type Ev = { t: number; kind: string; ibi?: number };
  const evs: Ev[] = [
    ...d.ibis.filter((r) => r[2] && r[2] !== "bewegt").map(([t, ibi, kind]) => ({ t, kind, ibi })),
    ...d.felt.filter((t) => t > d.now - 300000).map((t) => ({ t, kind: "gespürt" })),
  ].sort((a, b) => b.t - a.t).slice(0, 40);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Ereignisse</CardTitle>
        <CardDescription>Kandidaten und „gespürt“, letzte 5 min</CardDescription>
        <CardAction><Badge variant="outline">{evs.length}</Badge></CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {evs.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Noch nichts Auffälliges.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b"><th className="px-5 py-2 text-left font-medium">Zeit</th><th className="py-2 text-left font-medium">Art</th><th className="px-5 py-2 text-right font-medium">Intervall</th></tr>
              </thead>
              <tbody>
                {evs.map((e) => (
                  <tr key={`${e.kind}-${e.t}`} className="border-b last:border-0 hover:bg-muted/50">
                    <td className="px-5 py-2 font-mono text-xs tabular-nums">{clock(e.t)}</td>
                    <td className="py-2"><Badge variant={e.kind === "gespürt" ? "success" : "destructive"}>{e.kind}</Badge></td>
                    <td className="px-5 py-2 text-right font-mono text-xs tabular-nums">{e.ibi ? `${fmt(e.ibi)} ms` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Diagnostics({ d }: { d: LiveData }) {
  const g = d.diag;
  const q = Object.entries(g.quality).map(([c, v]) => [Number(c), v] as const);
  const lag = (v: number | null) => (v == null ? "–" : `${fmt(v, 1)} s`);
  const lagWarn = (v: number | null) => v != null && v > 3;
  const counts: [string, string][] = [["p", "Pulswelle"], ["a", "Accel"], ["g", "Gyro"], ["h", "Puls"], ["e", "Ereignis"], ["kaputt", "unlesbar"]];
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cpu className="size-4 text-muted-foreground" />Diagnose</CardTitle>
        <CardDescription>{d.lines.toLocaleString("de-DE")} Zeilen empfangen · Engine {g.engine}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Kanalgüte (Autokorrelation)</span>
            <Badge variant="secondary">v{g.ch}{g.auto ? " · auto" : " · fest"}</Badge>
          </div>
          {q.length === 0 ? <p className="text-xs text-muted-foreground">noch nicht bewertet</p> : q.map(([c, v]) => (
            <div key={c} className="grid grid-cols-[2rem_1fr_2.5rem] items-center gap-2 text-xs">
              <span className={cn("font-mono", c === g.ch && "font-semibold text-foreground")}>v{c}</span>
              <Progress value={Math.max(0, v) * 100} indicatorClassName={c === g.ch ? "bg-chart-1" : "bg-muted-foreground/40"} />
              <span className="text-right font-mono tabular-nums">{fmt(v, 2)}</span>
            </div>
          ))}
        </div>
        <Separator />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Stat label="Puffer" value={`${g.ppg_n} / ${g.ppg_span_s} s`} />
          <Stat label="Ausschlag" value={fmt(g.filt_range, 1)} />
          <Stat label="Verzögerung PPG" value={lag(g.lag_ppg_s)} warn={lagWarn(g.lag_ppg_s)} />
          <Stat label="Verzögerung Accel" value={lag(g.lag_acc_s)} warn={lagWarn(g.lag_acc_s)} />
        </dl>
        <Separator />
        <div className="grid grid-cols-3 gap-2">
          {counts.map(([k, l]) => (
            <div key={k} className="rounded-md bg-muted/50 px-2 py-1.5">
              <div className={cn("font-mono text-sm tabular-nums", k === "kaputt" && d.counts[k] && "text-destructive")}>{(d.counts[k] ?? 0).toLocaleString("de-DE")}</div>
              <div className="text-[11px] text-muted-foreground">{l}</div>
            </div>
          ))}
        </div>
        {g.error && <p className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] break-all text-destructive">{g.error}</p>}
        {g.last_p && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{g.last_p}</p>
            </TooltipTrigger>
            <TooltipContent className="font-mono break-all">{g.last_p}</TooltipContent>
          </Tooltip>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-mono tabular-nums", warn && "text-chart-2")}>{value}</dd>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="h-36 animate-pulse rounded-xl bg-muted" />)}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
