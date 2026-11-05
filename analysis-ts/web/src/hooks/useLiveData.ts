import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../../src/live_core.ts";
import type { Meta } from "../../../server/live_server.ts";

export type LiveData = Snapshot & { meta: Meta };
export interface HistoryPoint { t: number; hr_ppg: number | null; hr_sensor: number | null; rmssd: number | null; breath: number | null }

const HISTORY_S = 300;

/** Snapshots per Server-Sent Events; dazu eine Sekunden-Historie der Kennzahlen für die Sparklines. */
export function useLiveData(paused: boolean) {
  const [data, setData] = useState<LiveData | null>(null);
  const [online, setOnline] = useState(false);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const pausedRef = useRef(paused);
  const lastSample = useRef(0);
  pausedRef.current = paused;

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = (ev) => {
      setOnline(true);
      const d = JSON.parse(ev.data) as LiveData;
      if (d.now && d.now - lastSample.current >= 1000) {
        lastSample.current = d.now;
        const n = d.numbers;
        setHistory((h) => [...h.filter((p) => p.t > d.now - HISTORY_S * 1000 && p.t < d.now), { t: d.now, hr_ppg: n.hr_ppg, hr_sensor: n.hr_sensor, rmssd: n.rmssd, breath: n.breath }]);
      }
      if (!pausedRef.current) setData(d);
    };
    return () => es.close();
  }, []);

  return { data, online, history };
}
