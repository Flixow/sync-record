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

  it("rejects out-of-range numbers", () => {
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, TOKEN_TTL_HOURS: "0" })).toThrow(/TOKEN_TTL_HOURS/);
  });
});
