import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import type { DailySpendState, DailySpendEntry } from '../schema';
import { DailySpendStateSchema } from '../schema';
import type { BusPaths } from './paths';

export class DailySpendLedger {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
  ) {}

  async read(): Promise<DailySpendState> {
    const raw = await atomicReadJson<unknown>(
      this.paths.dailySpend,
      () => this.defaultState(),
    );
    // Repivot audit #4b: validate the on-disk shape before trusting it. A
    // daily-spend.json written by a PRE-repivot binary on the same calendar day
    // as the upgrade carries `spent_usd` but no `tokens_estimated`; trusting it
    // unchecked would make getRemaining compute `cap - undefined = NaN`, and a
    // NaN comparison disarms the daily gate entirely (bug #60 class). A stale or
    // malformed object fails the .strict() parse → reset to a clean default.
    const parsed = DailySpendStateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.date !== this.localDate()) {
      return this.defaultState();
    }
    return parsed.data;
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
