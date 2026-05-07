import { signIn } from './auth';
import { charge } from './billing';
import { log } from './logging';

export async function main(email: string, amountCents: number): Promise<void> {
  const user = await signIn(email);
  log('main', `signed in: ${user.id}`);
  await charge(user, amountCents);
  log('main', `charged ${amountCents} cents`);
}
