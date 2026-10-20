/** Aggregate in-process counters/gauges. Never holds per-request data. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number | null>();

  inc(name: string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  set(name: string, value: number | null): void {
    this.gauges.set(name, value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number | null> } {
    return { counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges) };
  }
}
