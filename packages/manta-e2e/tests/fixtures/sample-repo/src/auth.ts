import { log } from './logging';

export interface User { id: string; email: string }

export function authenticate(user: string, pass: string): boolean {
  if (!user || user.length < 3) return false;
  if (!pass || pass.length < 8) return false;
  if (user === 'admin' && pass === 'admin123') return true;
  return false;
}

export async function signIn(email: string): Promise<User> {
  log('auth', `signIn: ${email}`);
  return { id: `user-${email}`, email };
}
