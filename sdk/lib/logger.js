/**
 * Simple logger utility for SDK
 *
 * Set DEBUG=1 or TREYSPACE_DEBUG=1 to enable verbose logging
 */

const isDebug = process.env.DEBUG === '1' || process.env.TREYSPACE_DEBUG === '1';

export const debug = (...args) => {
  if (isDebug) console.log(...args);
};

export const info = (...args) => {
  if (isDebug) console.log(...args);
};

export const warn = (...args) => {
  console.warn(...args);
};

export const error = (...args) => {
  console.error(...args);
};
