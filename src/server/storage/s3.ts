import { createReadStream } from "node:fs";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import type { S3Config } from "../config.js";
import type { Storage, StoredObject } from "./types.js";

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async putFile(key: string, filePath: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(filePath) },
    });
    await upload.done();
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from((await response.Body?.transformToByteArray()) ?? []);
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
  }

  async readStream(key: string): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body as Readable;
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const found: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key !== undefined) found.push({ key: item.Key, size: item.Size ?? 0 });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return found.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
