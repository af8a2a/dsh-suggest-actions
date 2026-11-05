/**
 * Host entry of `dsh-suggest-actions`: registers the same-origin suggestion
 * route used by the turn-tail card. The client half renders the card; this half
 * owns transcript trimming and the one small model call behind it.
 * @module @dsh-plugin/dsh-suggest-actions
 */
import { registerSuggestRoute } from './route.mjs'

/** Cordis plugin name. */
export const name = 'dsh-suggest-actions'

/** Host services the route needs: session transcripts, the model seam, the default route, request auth, and the web server. */
export const inject = ['sessions', 'llm', 'agentDefaultModel', 'connection', 'webServer']

/**
 * Register the suggestion route for this plugin's lifetime.
 * @param ctx - the cordis plugin context.
 * @param config - deployment defaults contributed by `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const dispose = registerSuggestRoute(ctx, config)
  if (typeof ctx?.effect !== 'function') return
  ctx.effect(() => () => {
    try {
      dispose?.()
    } catch {
      // The route may already be gone with the web server; closing it twice is harmless.
    }
  }, 'dsh-suggest-actions: unregister suggestion route')
}
