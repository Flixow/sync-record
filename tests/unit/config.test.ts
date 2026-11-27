import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

const base = { TOKEN_SIGNING_SECRET: "a-long-enough-secret-value" };

describe("loadConfig", () => {
  it("requires a signing secret", () => {
    expect(() => loadConfig({})).toThrow(/TOKEN_SIGNING_SECRET/);
    expect(() => loadConfig({ TOKEN_SIGNING_SECRET: "short" })).toThrow(/TOKEN_SIGNING_SECRET/);
  });

  it("defaults to local storage and loopback", () => {
    const config = loadConfig(base);
    expect(config.storageDriver).toBe("local");
    expect(config.host).toBe("127.0.0.1");
    expect(config.createKey).toBeNull();
  });

  it("selects the storage driver from the environment only", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_ENDPOINT: "http://s3.example.test",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(config.s3).toMatchObject({ bucket: "bucket", forcePathStyle: true, endpoint: "http://s3.example.test" });
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "ftp" })).toThrow(/STORAGE_DRIVER/);
  });

  it("reads the speech engine settings and rejects an unknown compute type", () => {
    expect(loadConfig(base).post.asr).toEqual({ python: "python3", model: null, computeType: "int8" });
    const config = loadConfig({ ...base, ASR_MODEL: "small", ASR_COMPUTE_TYPE: "float32", ASR_PYTHON: "/opt/asr/bin/python", MODELS_DIR: "/models" });
    expect(config.post.asr).toEqual({ python: "/opt/asr/bin/python", model: "small", computeType: "float32" });
    expect(config.post.modelsDir).toBe("/models");
    expect(() => loadConfig({ ...base, ASR_COMPUTE_TYPE: "int4" })).toThrow(/ASR_COMPUTE_TYPE/);
  });

  it("rejects out-of-range numbers", () => {
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, TOKEN_TTL_HOURS: "0" })).toThrow(/TOKEN_TTL_HOURS/);
  });
});

describe("loadConfig: the anthropic provider", () => {
  const anthropic = { ...base, LLM_PROVIDER: "anthropic" };
  const key = "sk-ant-test-key-not-real";

  it("is off without a key, and a key alone does not turn it on", () => {
    expect(loadConfig(anthropic).post.llm).toBeNull();
    expect(loadConfig({ ...anthropic, LLM_URL: "https://llm.example.com" }).post.llm).toBeNull();
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: key }).post.llm).toBeNull();
    expect(loadConfig({ ...base, LLM_PROVIDER: "openai-compatible", ANTHROPIC_API_KEY: key }).post.llm).toBeNull();
    expect(loadConfig({ ...anthropic, ANTHROPIC_API_KEY: "  " }).post.llm).toBeNull();
  });

  it("needs no LLM_URL: the Anthropic API, the Opus 5.5 model, 60 s and 120 s timeouts", () => {
    expect(loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key }).post.llm).toEqual({
      url: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      timeoutMs: 60_000,
      shortsTimeoutMs: 120_000,
      provider: "anthropic",
      apiKey: key,
    });
  });

  it("takes the model, a gateway URL and both timeouts from the environment", () => {
    const llm = loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, LLM_MODEL: "claude-test", LLM_URL: "http://127.0.0.1:9999", LLM_TIMEOUT_MS: "5000", SHORTS_TIMEOUT_MS: "240000" }).post.llm;
    expect(llm).toMatchObject({ url: "http://127.0.0.1:9999", model: "claude-test", timeoutMs: 5000, shortsTimeoutMs: 240_000 });
    expect(() => loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, SHORTS_TIMEOUT_MS: "10" })).toThrow(/SHORTS_TIMEOUT_MS/);
    expect(() => loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, SHORTS_TIMEOUT_MS: "900000" })).toThrow(/SHORTS_TIMEOUT_MS/);
    expect(() => loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, SHORTS_TIMEOUT_MS: "soon" })).toThrow(/SHORTS_TIMEOUT_MS/);
    // the shorts timeout is a setting of every provider
    expect(loadConfig({ ...base, LLM_URL: "http://127.0.0.1:8080", SHORTS_TIMEOUT_MS: "90000" }).post.llm).toMatchObject({ provider: "openai-compatible", shortsTimeoutMs: 90_000 });
  });

  it("prefers LLM_API_KEY to ANTHROPIC_API_KEY, and still refuses two keys in LLM_API_KEY and LLM_API_KEY_FILE", () => {
    expect(loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, LLM_API_KEY: "gateway-token" }).post.llm?.apiKey).toBe("gateway-token");
    expect(() => loadConfig({ ...anthropic, LLM_API_KEY: "a", LLM_API_KEY_FILE: "/nonexistent" })).toThrow(/not both/);
    expect(() => loadConfig({ ...anthropic, LLM_API_KEY_FILE: "/nonexistent/key" })).toThrow(/cannot be read/);
  });

  it("never sends the key unencrypted and rejects an unusable URL or provider name", () => {
    expect(() => loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, LLM_URL: "http://192.168.1.10:4000" })).toThrow(/unencrypted/);
    expect(() => loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, LLM_URL: "https://gateway.example.com" })).not.toThrow();
    expect(() => loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, LLM_URL: "ftp://x" })).toThrow(/http or https/);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "Anthropic", ANTHROPIC_API_KEY: key, LLM_URL: "https://a.example.com" })).toThrow(/LLM_PROVIDER/);
  });

  it("does not put the key in any error message", () => {
    for (const env of [{ LLM_URL: "http://192.168.1.10:4000" }, { SHORTS_TIMEOUT_MS: "1" }, { LLM_URL: "ftp://x" }]) {
      let message = "";
      try {
        loadConfig({ ...anthropic, ANTHROPIC_API_KEY: key, ...env });
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(key);
    }
  });
});
