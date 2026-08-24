/** DSH-owned paths used by the Kiro login flow. */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * Return the directory containing credentials created by this plugin.
 * @returns an absolute directory below DSH home.
 */
export function credentialDirectory(): string {
  return dshHomePath('storages', 'kiro-auth')
}
