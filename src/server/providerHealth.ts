import type { Account } from "./providers";

const FAILURE_THRESHOLD = Number(process.env.PROVIDER_FAILURE_THRESHOLD || 3);
const COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 60_000);

type HealthEntry = {
  failures: number;
  blockedUntil: number;
  lastError?: string;
};

export class ProviderHealthCache {
  private entries = new Map<string, HealthEntry>();

  providerKey(account: Account) {
    return [account.provider, account.base_url, account.model].filter(Boolean).join("|");
  }

  canUse(account: Account) {
    const entry = this.entries.get(this.providerKey(account));
    if (!entry) return true;
    if (entry.blockedUntil <= Date.now()) return true;
    return false;
  }

  recordSuccess(account: Account) {
    this.entries.delete(this.providerKey(account));
  }

  recordFailure(account: Account, error: string) {
    const key = this.providerKey(account);
    const current = this.entries.get(key) ?? { failures: 0, blockedUntil: 0 };
    const failures = current.failures + 1;
    this.entries.set(key, {
      failures,
      blockedUntil: failures >= FAILURE_THRESHOLD ? Date.now() + COOLDOWN_MS : current.blockedUntil,
      lastError: error
    });
  }

  status(account: Account) {
    const entry = this.entries.get(this.providerKey(account));
    if (!entry) return "healthy";
    if (entry.blockedUntil > Date.now()) {
      const seconds = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
      return `cooling down for ${seconds}s after ${entry.failures} failure(s)`;
    }
    return entry.failures ? `${entry.failures} recent failure(s)` : "healthy";
  }
}

export const providerHealth = new ProviderHealthCache();
