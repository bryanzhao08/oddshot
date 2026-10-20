// Tipoff recommender modules (browser-safe; shared by server/index.js and public/standalone.js).
export { buildShots, analyze, classify, dramaScore, KINDS } from './shots.js';
export { InsightEngine, INSIGHT_TYPES } from './insights.js';
export { StoryEngine, storyInsight } from './stories.js';
export { buildBriefing } from './briefing.js';
export { heuristicForecast } from './forecast.js';
