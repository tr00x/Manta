import type { User } from './auth';
import { log } from './logging';

export async function charge(user: User, amountCents: number): Promise<void> {
  if (amountCents <= 0) throw new Error('amount must be > 0');
  log('billing', `charge ${amountCents} for ${user.id}`);
}
