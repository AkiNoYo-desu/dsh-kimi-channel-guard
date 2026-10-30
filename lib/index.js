import { applyPatch } from './patcher.js';

/** Explicit compatibility patch: changes three files in Subscriptions, never DSH core. */
export function apply(ctx) {
  let log = console;
  try { log = typeof ctx?.logger === 'function' ? ctx.logger('kimi-channel-guard') : (ctx?.logger || console); } catch {}
  try {
    const result = applyPatch();
    if (result.changed) log.warn?.(`[kimi-channel-guard] Applied channel isolation patch. Fully restart DSH before using Kimi. Backup receipt: ${result.receipt}`);
    else log.info?.('[kimi-channel-guard] All three channel-isolation fixes already present; no files changed.');
  } catch (error) {
    log.warn?.(`[kimi-channel-guard] Compatibility patch not applied: ${error.message}`);
  }
}
export default { apply };
