/**
 * Log levels shared by the configuration loader and the structured logger.
 *
 * Kept in its own module so `config/` and `logging/` can both depend on it
 * without importing each other (no dependency cycle).
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric rank used for threshold comparisons. */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
