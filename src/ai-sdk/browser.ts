export type {
  NeedleProviderSettings,
  /** @deprecated Use NeedleProviderSettings instead. */
  NeedleProviderSettings as BrowserNeedleProviderOptions,
} from './browser-provider.js';
export {
  createNeedle,
  /** @deprecated Use createNeedle instead. */
  createNeedle as createNeedleProvider,
  needle,
} from './browser-provider.js';
export type { NeedleProvider } from './provider.js';
