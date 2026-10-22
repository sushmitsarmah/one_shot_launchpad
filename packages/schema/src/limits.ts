/** Per-request chunk: ideas per /api/generate call and per vault launch call (the vault's MAX_BATCH, gas-bound). */
export const MAX_BATCH = 5;
/** Most tokens one Studio run can generate/launch; the client splits a run into MAX_BATCH-sized chunks. */
export const MAX_RUN = 100;
