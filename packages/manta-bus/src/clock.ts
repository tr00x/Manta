export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export class FakeClock implements Clock {
  private current: number;

  constructor(epoch = 0) {
    this.current = epoch;
  }

  now(): number {
    return this.current;
  }

  advance(deltaMs: number): void {
    if (deltaMs < 0) {
      throw new Error('FakeClock.advance requires a non-negative delta');
    }
    this.current += deltaMs;
  }

  set(epoch: number): void {
    this.current = epoch;
  }
}
