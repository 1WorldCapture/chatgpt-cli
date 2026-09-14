// Tiny shared helpers used across all modules.

// Embed a JS value into a page-evaluated expression as a JSON literal.
export const json = (v: unknown) => JSON.stringify(v);

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
