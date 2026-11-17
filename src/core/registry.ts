/** The one type registry both driver families
 * share. A registry maps a config `type` to its class, guards duplicates,
 * names what is registered when a type is unknown, and validates `options`
 * through the class's `optionsSchema` before construction. Corpora add module
 * loading and the setup context on top; detectors use it as-is. */

import type { z } from "zod";

import { formatIssues } from "./zod-issues.ts";

/** Any object-valued options record. Driver schemas narrow this. */
export type OptionsRecord = Record<string, unknown>;

/** What a registry can load: the type key, the instance id diagnostics name,
 * and the operator-written options its class validates. */
export interface RegistryEntry {
  readonly id: string;
  readonly type: string;
  readonly options?: OptionsRecord;
}

/** One registered class: construct from the entry plus the setup context, and
 * optionally declare the zod schema for `options`. Strict
 * schemas (`z.strictObject`) reject unknown keys. */
export interface TypeClass<
  C extends RegistryEntry,
  Ctx,
  D,
  O extends OptionsRecord = OptionsRecord,
> {
  new (config: C, ctx: Ctx): D;
  optionsSchema?: z.ZodType<O>;
}

/** The shared map: register/guard, loud unknown-type errors, registration
 * order. Subclasses add their construction step. */
export class TypeRegistry<C extends RegistryEntry, Ctx, D> {
  readonly #kind: string;
  readonly #registrations = new Map<string, TypeClass<C, Ctx, D>>();

  /** `kind` labels every diagnostic, e.g. `corpus` or `detector`. */
  constructor(kind: string) {
    this.#kind = kind;
  }

  /** Register at startup; a duplicate type is a bug, not a config error. */
  register<O extends OptionsRecord>(type: string, cls: TypeClass<C, Ctx, D, O>): void {
    if (this.#registrations.has(type)) {
      throw new Error(`${this.#kind} type "${type}" is already registered`);
    }
    this.#registrations.set(type, cls);
  }

  /** The registered class, or `undefined` — for subclasses that admit extra
   * sources of classes before answering with `unknownType`. */
  find(type: string): TypeClass<C, Ctx, D> | undefined {
    return this.#registrations.get(type);
  }

  /** Registered types in registration order: the default instance order when
   * a config omits its section. */
  types(): string[] {
    return [...this.#registrations.keys()];
  }

  /** The registered class; unknown types fail loud. */
  resolve(type: string): TypeClass<C, Ctx, D> {
    const cls = this.find(type);
    if (cls === undefined) throw this.unknownType(type);
    return cls;
  }

  /** The one unknown-type diagnostic, naming what is registered. */
  unknownType(type: string): Error {
    const known = this.types().sort();
    return new Error(
      `unknown ${this.#kind} type "${type}" (registered: ${known.length > 0 ? known.join(", ") : "none"})`,
    );
  }

  /** `corpus "wiki"`: the instance label every diagnostic starts with. */
  label(config: C): string {
    return `${this.#kind} "${config.id}"`;
  }
}

/** The one options-validation-and-construction path: resolve's caller hands
 * the class, this validates `options` and constructs. A class that declares
 * no schema accepts no options at all — silently discarding operator-written
 * keys hides typos. */
export function construct<C extends RegistryEntry, Ctx, D>(
  cls: TypeClass<C, Ctx, D>,
  config: C,
  ctx: Ctx,
  label: string,
): D {
  const schema = cls.optionsSchema;
  if (schema === undefined) {
    parseOptions(undefined, config.options, label);
    return new cls(config, ctx);
  }
  // safeParse does not mutate; hand the constructed class the defaulted data
  // without touching the caller's config.
  return new cls({ ...config, options: parseOptions(schema, config.options, label) }, ctx);
}

/** Validate `options` against the class schema and render the same formatted
 * error everywhere: the registry and the constructors a test or adapter calls
 * directly. With no schema, any options are rejected. */
export function parseOptions<O extends OptionsRecord>(
  schema: z.ZodType<O>,
  options: OptionsRecord | undefined,
  label: string,
): O;
export function parseOptions(
  schema: undefined,
  options: OptionsRecord | undefined,
  label: string,
): undefined;
export function parseOptions<O extends OptionsRecord>(
  schema: z.ZodType<O> | undefined,
  options: OptionsRecord | undefined,
  label: string,
): O | undefined {
  if (schema === undefined) {
    if (options !== undefined && Object.keys(options).length > 0) {
      throw new Error(`${label}: options are not supported by this type`);
    }
    return undefined;
  }

  const result = schema.safeParse(options ?? {});
  if (!result.success) {
    throw new Error(`${label}: invalid options — ${formatIssues(result.error, "options")}`);
  }
  return result.data;
}
