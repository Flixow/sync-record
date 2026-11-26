import { writeFileSync } from "node:fs";
import process from "node:process";

const request = JSON.parse(process.argv[2]);
const files = (request.files ?? []).map(() => ({
  lang: request.lang ?? "en",
  words: [
    { w: "Hello,", s: 0.2, e: 0.5 },
    { w: "world.", s: 0.6, e: 1.0 },
  ],
}));
writeFileSync(request.out, JSON.stringify({ files }));
