import path from "path";
import dotenv from "dotenv";

export function loadEnv(baseDir, nodeEnv = process.env.NODE_ENV || "development") {
  const envFile = nodeEnv === "production" ? ".env.production" : ".env.development";
  dotenv.config({ path: path.resolve(baseDir, envFile) });
}
