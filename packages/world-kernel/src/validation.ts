import type { ErrorIssue, JsonObject } from "@firedrill-run/contracts";
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import formatsModule from "ajv-formats";

export interface CompiledOperationSchemas {
  readonly input: ValidateFunction<unknown>;
  readonly output: ValidateFunction<unknown>;
}

function pointerPath(pointer: string): Array<string | number> {
  if (pointer.length === 0) return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
}

export function ajvIssues(errors: readonly ErrorObject[] | null | undefined): ErrorIssue[] {
  return (errors ?? []).map((error) => ({
    code: `json-schema.${error.keyword}`,
    message: error.message ?? `failed ${error.keyword} validation`,
    path: pointerPath(error.instancePath),
  }));
}

export function createSchemaCompiler(): {
  compile(input: JsonObject, output: JsonObject): CompiledOperationSchemas;
  compilePayload(schema: JsonObject): ValidateFunction<unknown>;
} {
  const ajv = new Ajv({ allErrors: true, strict: true });
  formatsModule.default(ajv);
  return {
    compile(input, output) {
      return { input: ajv.compile(input), output: ajv.compile(output) };
    },
    compilePayload(schema) {
      return ajv.compile(schema);
    },
  };
}
