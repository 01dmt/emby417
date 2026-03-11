import path from "node:path";

const appDataDir = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve("data");

const appLogDir = process.env.APP_LOG_DIR
  ? path.resolve(process.env.APP_LOG_DIR)
  : path.resolve("logs");

const caddyfilePath = process.env.CADDYFILE_PATH
  ? path.resolve(process.env.CADDYFILE_PATH)
  : path.join(appDataDir, "Caddyfile.local");

export const runtimePaths = {
  appDataDir,
  appLogDir,
  caddyfilePath,
  configPath: path.join(appDataDir, "config.json"),
  logFilePath: path.join(appLogDir, "requests.jsonl")
};
