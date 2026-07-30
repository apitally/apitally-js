import { describe, expect, it } from "vitest";
import { type ApitallyOptions, setConfig } from "../src/config.js";
import { captureStderr, WRITE_TOKEN } from "./utils.js";

describe("config", () => {
  it("prefers explicit options over environment variables", () => {
    process.env.APITALLY_ENV = "dev";
    const config = setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    expect(config.env).toBe("staging");
  });

  it("falls back to environment variables for omitted options", () => {
    process.env.APITALLY_WRITE_TOKEN = WRITE_TOKEN;
    process.env.APITALLY_ENV = "dev";
    process.env.APITALLY_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const config = setConfig();
    expect(config.writeToken).toBe(WRITE_TOKEN);
    expect(config.env).toBe("dev");
    expect(config.otlpEndpoint).toBe("http://127.0.0.1:4318");
    expect(config.disabled).toBe(false);
  });

  it("applies defaults when options and environment variables are absent", () => {
    const config = setConfig({ writeToken: WRITE_TOKEN });
    expect(config).toEqual({
      writeToken: WRITE_TOKEN,
      env: "prod",
      appVersion: undefined,
      disabled: false,
      captureLogs: true,
      captureRequestHeaders: false,
      captureRequestBody: false,
      captureResponseHeaders: true,
      captureResponseBody: false,
      maskQueryParams: [],
      maskHeaders: [],
      maskBodyFields: [],
      maskRequestBody: undefined,
      maskResponseBody: undefined,
      excludePaths: [],
      sampleRate: 1,
      sampleOnRequest: undefined,
      sampleOnResponse: undefined,
      otlpEndpoint: "https://otlp.apitally.io",
    });
  });

  it.each([
    { envVar: "APITALLY_DISABLED", value: "1", disabled: true },
    { envVar: "APITALLY_DISABLED", value: "true", disabled: true },
    { envVar: "APITALLY_DISABLED", value: "yes", disabled: true },
    { envVar: "APITALLY_DISABLED", value: " TRUE ", disabled: true },
    { envVar: "APITALLY_DISABLED", value: "0", disabled: false },
    { envVar: "APITALLY_DISABLED", value: "false", disabled: false },
    { envVar: "OTEL_SDK_DISABLED", value: "1", disabled: true },
    { envVar: "OTEL_SDK_DISABLED", value: "true", disabled: true },
    { envVar: "OTEL_SDK_DISABLED", value: "yes", disabled: true },
    { envVar: "OTEL_SDK_DISABLED", value: " TRUE ", disabled: true },
    { envVar: "OTEL_SDK_DISABLED", value: "0", disabled: false },
    { envVar: "OTEL_SDK_DISABLED", value: "false", disabled: false },
  ])("resolves disabled to $disabled when $envVar is '$value'", ({ envVar, value, disabled }) => {
    process.env[envVar] = value;
    const config = setConfig({ writeToken: WRITE_TOKEN });
    expect(config.disabled).toBe(disabled);
  });

  it("disables the SDK when either disable environment variable is true", () => {
    process.env.APITALLY_DISABLED = "false";
    process.env.OTEL_SDK_DISABLED = "true";
    const config = setConfig({ writeToken: WRITE_TOKEN });
    expect(config.disabled).toBe(true);
  });

  it("prefers an explicit disabled option over the disable environment variables", () => {
    process.env.APITALLY_DISABLED = "1";
    process.env.OTEL_SDK_DISABLED = "1";
    const config = setConfig({ writeToken: WRITE_TOKEN, disabled: false });
    expect(config.disabled).toBe(false);
  });

  it("keeps a sampleRate of zero", () => {
    const config = setConfig({ writeToken: WRITE_TOKEN, sampleRate: 0 });
    expect(config.sampleRate).toBe(0);
  });

  it.each([{ value: 1.5 }, { value: -0.1 }, { value: "0.5" }])(
    "resolves an invalid sampleRate of $value to capture everything without logging",
    ({ value }) => {
      const lines = captureStderr();
      const config = setConfig({
        writeToken: WRITE_TOKEN,
        sampleRate: value as number,
      });
      expect(config.sampleRate).toBe(1);
      expect(lines).toHaveLength(0);
    },
  );

  it.each([
    { option: "maskQueryParams" },
    { option: "maskHeaders" },
    { option: "maskBodyFields" },
    { option: "excludePaths" },
  ] as const)(
    "drops an invalid $option pattern with an error log and keeps the remaining patterns",
    ({ option }) => {
      const lines = captureStderr();
      const options: ApitallyOptions = { writeToken: WRITE_TOKEN };
      options[option] = ["valid", "(unclosed"];
      const config = setConfig(options);
      expect(config[option]).toEqual(["valid"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(option);
      expect(lines[0]).toContain("(unclosed");
    },
  );

  it("logs an error and disables the SDK when the write token is missing", () => {
    const lines = captureStderr();
    const config = setConfig();
    expect(config.disabled).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("write token is missing");
  });

  it("logs an error with the token masked and disables the SDK when the write token format is invalid", () => {
    const lines = captureStderr();
    const invalidToken = "apt_3kPmN9xQv2bR7tH4wZ8yL5cEXTRA";
    const config = setConfig({ writeToken: invalidToken });
    expect(config.disabled).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("apt_3kPm");
    expect(lines[0]).not.toContain(invalidToken);
  });

  it("logs an error and disables the SDK when the OTLP endpoint is not a valid HTTP or HTTPS URL", () => {
    const lines = captureStderr();
    process.env.APITALLY_OTLP_ENDPOINT = "otlp.apitally.io";
    const config = setConfig({ writeToken: WRITE_TOKEN });
    expect(config.disabled).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("OTLP endpoint");
  });

  it("logs no write token error when the SDK is disabled", () => {
    const lines = captureStderr();
    const config = setConfig({ disabled: true });
    expect(config.disabled).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it("returns the first configuration without logging when called again with the same options", () => {
    const lines = captureStderr();
    const first = setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    const second = setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    expect(second).toBe(first);
    expect(lines).toHaveLength(0);
  });

  it("warns and keeps the first configuration when called again with different options", () => {
    const lines = captureStderr();
    const first = setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    const second = setConfig({ writeToken: WRITE_TOKEN, env: "dev" });
    expect(second).toBe(first);
    expect(second.env).toBe("staging");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("called again with different options");
  });
});
