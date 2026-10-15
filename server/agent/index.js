// Recommendation facade (CONTRACT.md v3). Rules immediately, Claude upgrade asynchronously.
//
//   const rec = createRecommender({ tools, ...claudeOpts });
//   target.recommendations = rec.recommendNow(target, ctx);            // {[role]: rules rec}, sync
//   rec.recommendSmart(target, ctx, role, (r) => broadcast(...));      // Claude upgrade when eligible
//   await rec.recommend(target, { ...ctx, role });                     // best available (claude || rules)

import { recommendRules, recommendAllRoles, ROLES, TRADER_DISCLAIMER } from './rules.js';
import { createClaudeRecommender } from './claude.js';

export { recommendRules, recommendAllRoles, ROLES, TRADER_DISCLAIMER };

const SEV = { info: 0, notable: 1, major: 2 };

/** Worth a Claude call? notable+ spikes/insights, big volatility spikes, top-3 or very dramatic shots. */
export function isEligible(target = {}) {
  if (!target || typeof target !== 'object') return false;
  if ((SEV[target.severity] ?? -1) >= 1) return true;
  if (target.kind === 'volatility' && Number(target.volRatio) >= 4) return true;
  if (Number.isFinite(target.rank) && target.rank >= 1 && target.rank <= 3) return true;
  if (Number(target.dramaScore) >= 75) return true;
  return false;
}

let contextModule;
function lazyGetLiveContext(market) {
  if (contextModule === undefined)
    contextModule = import('../context/index.js').then(
      (m) => (typeof m.getLiveContext === 'function' ? m.getLiveContext : null),
      () => null,
    );
  return contextModule.then((fn) => (fn ? fn(market) : null)).catch(() => null);
}

/**
 * createRecommender({ claude?, tools?, ...createClaudeRecommender opts })
 *   tools: { getMarketHistory(id, {minutes}), getLiveContext(market), getRelatedMarkets(market), getForecast(market) }
 *   claude: an existing createClaudeRecommender() result, or false to force rules only.
 */
export function createRecommender({ claude, tools = {}, eligible = isEligible, log = (...a) => console.log('[agent]', ...a), ...opts } = {}) {
  const t = { ...tools, getLiveContext: tools.getLiveContext || lazyGetLiveContext };
  const agent = claude === false ? null : claude || createClaudeRecommender({ tools: t, log, ...opts });
  const available = Boolean(agent?.available);

  function recommendNow(target, ctx = {}) {
    return recommendAllRoles(target, ctx);
  }

  /** Upgrade one role with Claude. Resolves the Claude rec (also passed to onUpgrade) or null. Never throws. */
  async function recommendSmart(target, ctx = {}, role = 'general', onUpgrade) {
    if (!available || !eligible(target)) return null;
    try {
      const draft = recommendRules(target, { ...ctx, role });
      const rec = await agent.recommend(target, { ...ctx, role, draft });
      if (rec && typeof onUpgrade === 'function') {
        try {
          onUpgrade(rec);
        } catch (e) {
          log(`onUpgrade failed: ${e?.message || e}`);
        }
      }
      return rec;
    } catch (e) {
      log(`recommendSmart failed: ${e?.message || e}`);
      return null;
    }
  }

  /** Best available single recommendation (contract `recommend`): Claude when eligible+available, else rules. */
  async function recommend(target, ctx = {}, { force = false } = {}) {
    const role = ROLES.includes(ctx.role) ? ctx.role : 'general';
    if (available && (force || eligible(target))) {
      const rec = await recommendSmartForced(target, { ...ctx, role });
      if (rec) return rec;
    }
    return recommendRules(target, { ...ctx, role });
  }

  async function recommendSmartForced(target, ctx) {
    try {
      return await agent.recommend(target, { ...ctx, draft: recommendRules(target, ctx) });
    } catch {
      return null;
    }
  }

  return {
    available,
    model: agent?.model || null,
    recommendNow,
    recommendSmart,
    recommend,
    isEligible: eligible,
    stats: () => (agent?.stats ? agent.stats() : null),
  };
}
