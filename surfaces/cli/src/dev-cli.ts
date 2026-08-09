export {};

process.env.SIGNET_TELEMETRY_ENV ||= "dev";
process.env.SIGNET_TELEMETRY_INSTALL_CHANNEL ||= "source";

await import("./cli");
