// JSON-file persistence for subscriptions and the recent-alerts ring buffer.
// Writes are atomic (tmp file + rename) and serialized per file.

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export async function atomicWriteJSON(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[store] could not read ${file}: ${err.message}; starting fresh`);
    return fallback;
  }
}

export class Store {
  constructor({ dir = DEFAULT_DATA_DIR, maxAlerts = 500, maxInsights = 300, alertFlushMs = 1000 } = {}) {
    this.dir = dir;
    this.maxAlerts = maxAlerts;
    this.alertFlushMs = alertFlushMs;
    this.subsFile = join(dir, 'subscriptions.json');
    this.alertsFile = join(dir, 'alerts.json');
    this.insightsFile = join(dir, 'insights.json');
    this.maxInsights = maxInsights;
    this.insights = []; // newest first
    this._insightTimer = null;
    this.subs = [];
    this.alerts = []; // newest first
    this._chains = new Map();
    this._alertTimer = null;
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    const subs = await readJSON(this.subsFile, []);
    const alerts = await readJSON(this.alertsFile, []);
    this.subs = Array.isArray(subs) ? subs : [];
    this.alerts = Array.isArray(alerts) ? alerts.slice(0, this.maxAlerts) : [];
    const insights = await readJSON(this.insightsFile, []);
    this.insights = Array.isArray(insights) ? insights.slice(0, this.maxInsights) : [];
    return this;
  }

  // Serialize writes per file so renames land in order.
  _write(file, getValue) {
    const prev = this._chains.get(file) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => atomicWriteJSON(file, getValue()));
    this._chains.set(file, next);
    return next;
  }

  // ---- subscriptions ----
  listSubscriptions() {
    return this.subs.slice();
  }

  getSubscription(id) {
    return this.subs.find((s) => s.id === id) || null;
  }

  async createSubscription(data) {
    const sub = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    this.subs.push(sub);
    await this._write(this.subsFile, () => this.subs);
    return sub;
  }

  async updateSubscription(id, data) {
    const i = this.subs.findIndex((s) => s.id === id);
    if (i === -1) return null;
    const cur = this.subs[i];
    const sub = { ...cur, ...data, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
    this.subs[i] = sub;
    await this._write(this.subsFile, () => this.subs);
    return sub;
  }

  async deleteSubscription(id) {
    const i = this.subs.findIndex((s) => s.id === id);
    if (i === -1) return false;
    this.subs.splice(i, 1);
    await this._write(this.subsFile, () => this.subs);
    return true;
  }

  // ---- alerts ring buffer ----
  addAlert(spike) {
    this.alerts.unshift(spike);
    if (this.alerts.length > this.maxAlerts) this.alerts.length = this.maxAlerts;
    this._scheduleAlertFlush();
    return spike;
  }

  listAlerts(limit = 100) {
    return this.alerts.slice(0, Math.max(0, limit));
  }

  _scheduleAlertFlush() {
    if (this._alertTimer) return;
    this._alertTimer = setTimeout(() => {
      this._alertTimer = null;
      this.flushAlerts().catch((e) => console.warn('[store] alert flush failed:', e.message));
    }, this.alertFlushMs);
    this._alertTimer.unref?.();
  }

  flushAlerts() {
    return this._write(this.alertsFile, () => this.alerts);
  }

  // ---- insights ring buffer ----
  addInsight(insight) {
    this.insights.unshift(insight);
    if (this.insights.length > this.maxInsights) this.insights.length = this.maxInsights;
    if (!this._insightTimer) {
      this._insightTimer = setTimeout(() => {
        this._insightTimer = null;
        this.flushInsights().catch((e) => console.warn('[store] insight flush failed:', e.message));
      }, this.alertFlushMs);
      this._insightTimer.unref?.();
    }
    return insight;
  }

  listInsights(limit = 50) {
    return this.insights.slice(0, Math.max(0, limit));
  }

  flushInsights() {
    return this._write(this.insightsFile, () => this.insights);
  }

  /** Flush pending writes; call on shutdown. */
  async close() {
    if (this._insightTimer) {
      clearTimeout(this._insightTimer);
      this._insightTimer = null;
      await this.flushInsights().catch(() => {});
    }
    if (this._alertTimer) {
      clearTimeout(this._alertTimer);
      this._alertTimer = null;
      await this.flushAlerts().catch(() => {});
    }
    await Promise.allSettled([...this._chains.values()]);
  }
}

export async function openStore(opts) {
  return new Store(opts).load();
}
