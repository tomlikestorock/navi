import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import {
  naviConfigJsonSchema,
  HitSurfacingSchema,
  SurfacingConfigSchema,
} from "#core/config/schema.ts";

test("committed navi.schema.json matches the emitted schema", () => {
  const file = new URL("../../../navi.schema.json", import.meta.url);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(naviConfigJsonSchema());
});

test("surfacing rules default their caps and reject typo'd keys", () => {
  expect(SurfacingConfigSchema.parse({})).toEqual({});
  expect(SurfacingConfigSchema.parse({ repetition: {} })).toEqual({
    repetition: { perTurn: 1, perSession: 3 },
  });
  expect(() => SurfacingConfigSchema.parse({ repetition: { perTurn: 0 } })).toThrow();
  expect(() => SurfacingConfigSchema.parse({ budget: { maxHit: 1 } })).toThrow();
  expect(() =>
    SurfacingConfigSchema.parse({ byModel: { "anthropic/x": { repetition: { perSession: 1 } } } }),
  ).not.toThrow();
});

test("hit surfacing metadata is strict and optional per field", () => {
  expect(HitSurfacingSchema.parse({})).toEqual({});
  expect(HitSurfacingSchema.parse({ force: ["*"], priority: 2, repeat: "eager" })).toEqual({
    force: ["*"],
    priority: 2,
    repeat: "eager",
  });
  expect(HitSurfacingSchema.parse({ minTurn: 4, cooldown: 3 })).toEqual({
    minTurn: 4,
    cooldown: 3,
  });
  expect(() => HitSurfacingSchema.parse({ repeat: "always" })).toThrow();
  expect(() => HitSurfacingSchema.parse({ priority: "high" })).toThrow();
  expect(() => HitSurfacingSchema.parse({ minTurn: 0 })).toThrow();
  expect(() => HitSurfacingSchema.parse({ cooldown: 1.5 })).toThrow();
  expect(() => HitSurfacingSchema.parse({ unknown: true })).toThrow();
});
