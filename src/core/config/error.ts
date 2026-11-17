/** Config errors are operator errors and fail loud. The message
 * carries the file, so callers never re-read the field. */
export class ConfigError extends Error {
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = "ConfigError";
  }
}
