#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { CodexConnector } from "@signetai/connector-codex";

runConnectorInstaller("codex", CodexConnector, {
	commandName: "signet-codex-plugin",
	packageName: "@signetai/codex-plugin",
	label: "codex-plugin",
});
