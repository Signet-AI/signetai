#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { CodexConnector } from "@signet/connector-codex";

runConnectorInstaller("codex", CodexConnector, {
	commandName: "signet-codex-plugin",
	packageName: "@signet/codex-plugin",
	label: "codex-plugin",
});
