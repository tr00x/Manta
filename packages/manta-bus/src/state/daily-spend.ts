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
            tokens_estimated: entry.estimated_tokens,
            entries: [fullEntry],
          };
        }
        return {
          ...current,
          tokens_estimated: current.tokens_estimated + entry.estimated_tokens,
          entries: [...current.entries, fullEntry],
        };
      },
    );
  }

  async getRemaining(dailyTokenCap: number): Promise<number> {
    const state = await this.read();
    return Math.max(0, dailyTokenCap - state.tokens_estimated);
  }

  /**
   * Number of casts started today (usage signal — replaces the old dollar
   * spend total as the headline daily metric).
   */
  async castsToday(): Promise<number> {
    const state = await this.read();
    return state.entries.length;
  }

  private defaultState(): DailySpendState {
    return {
      version: 1,
      date: this.localDate(),
      tokens_estimated: 0,
      entries: [],
    };
  }

  private localDate(): string {
    return new Date(this.clock.now()).toLocaleDateString('en-CA');
  }
}
