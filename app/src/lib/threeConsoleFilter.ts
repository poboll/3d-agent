import { setConsoleFunction } from 'three';

const THREE_CLOCK_DEPRECATION = 'Clock: This module has been deprecated.';
const THREE_TIMER_REPLACEMENT = 'Please use THREE.Timer instead.';

export function installThreeConsoleFilter() {
  setConsoleFunction((level, message, ...params) => {
    const text = String(message || '');
    if (
      level === 'warn' &&
      text.includes(THREE_CLOCK_DEPRECATION) &&
      text.includes(THREE_TIMER_REPLACEMENT)
    ) {
      return;
    }

    const logger = level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;
    logger(message, ...params);
  });
}
