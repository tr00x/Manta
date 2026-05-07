import { log } from './logging';

export interface User { id: string; email: string }

export async function signIn(email: string): Promise<User> {
  log('auth', `signIn: ${email}`);
  return { id: `user-${email}`, email };
}
