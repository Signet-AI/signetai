export {};

process.env.SIGNET_TELEMETRY_ENV ||= "dev";
process.env.SIGNET_TELEMETRY_INSTALL_CHANNEL ||= "source";
process.env.SIGNET_DAEMON_ENTRYPOINT ||= "1";

await import("./daemon");
