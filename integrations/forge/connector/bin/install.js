#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { ForgeConnector } from "../dist/index.js";

runConnectorInstaller("forge", ForgeConnector, {
	commandName: "signet-connector-forge",
	packageName: "@signet/connector-forge",
	label: "ForgeCode",
});
