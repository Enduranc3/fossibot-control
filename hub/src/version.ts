declare const __FOSSIBOT_VERSION__: string | undefined;

/** Set by scripts/build-hub.mjs (the release tag); 'dev' when running from sources. */
export const VERSION: string = typeof __FOSSIBOT_VERSION__ === 'string' ? __FOSSIBOT_VERSION__ : 'dev';
