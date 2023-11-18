import { createLogger, format, transports } from "winston";

export interface Logger {
  debug: (message: string, meta?: object) => void;
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
}

export const getLogger = () => {
  return createLogger({
    level: process.env.APITALLY_DEBUG ? "debug" : "warn",
    format: format.combine(
      format.colorize(),
      format.timestamp(),
      format.printf(
        (info) => `${info.timestamp} ${info.level}: ${info.message}`
      )
    ),
    transports: [new transports.Console()],
  });
};
