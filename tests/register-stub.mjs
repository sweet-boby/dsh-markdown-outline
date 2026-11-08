/**
 * Install the module stub before any test file loads the plugin.
 *
 * Loaded through `--import` so registration happens before `index.js` resolves
 * its Host-only imports.
 */

import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)
