import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import type { DailySpendState, DailySpendEntry } from '../schema';
import type { BusPaths } from './paths';

export class DailySpendLedger {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
  ) {}

  async read(): Promise<DailySpendState> {
    const raw = await atomicReadJson<DailySpendState>(
      this.paths.dailySpend,
      () => this.defaultState(),
    );
    if (raw.date !== this.localDate()) {
      return this.defaultState();
    }
    return raw;
  }

  async recordCastStart(
    entry: Omit<DailySpendEntry, 'started_at'>,
  ): Promise<DailySpendState> {
    const ts = this.clock.now();

    return atomicMutateJson<DailySpendState>(
      this.paths.dailySpend,
      () => this.defaultState(),
      (current) => {
        const today = this.localDate();
        const fullEntry: DailySpendEntry = { ...entry, started_at: ts };

        if (current.date !== today) {
          return {
            version: 1,
            date: today,
            spent_usd: entry.estimated_cost_usd,
            entries: [fullEntry],
          };
        }
        return {
          ...current,
          spent_usd: current.spent_usd + entry.estimated_cost_usd,
          entries: [...current.entries, fullEntry],
        };
      },
    );
  }

  async getRemaining(dailyCapUsd: number): Promise<number> {
    const state = await this.read();
    return Math.max(0, dailyCapUsd - state.spent_usd);
  }

  private defaultState(): DailySpendState {
    return {
      version: 1,
      date: this.localDate(),
      spent_usd: 0,
      entries: [],
    };
  }

  private localDate(): string {
    return new Date(this.clock.now()).toLocaleDateString('en-CA');
  }
}
