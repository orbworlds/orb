// The key of Orb's secret pages under /lab/<key> (hidden worlds, pulse, analytics, traces, backup).
// Linked from nowhere, never indexed. In production it is ORB_LAB_KEY or there are no such pages:
// the code is public, so a key written here would open them to anyone.
export const LAB_KEY: string | null = process.env.ORB_LAB_KEY || (process.env.NODE_ENV === 'production' ? null : 'dev-lab');
