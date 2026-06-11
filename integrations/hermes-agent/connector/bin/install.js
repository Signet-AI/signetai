#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { HermesAgentConnector } from "../dist/index.js";

runConnectorInstaller("hermes-agent", HermesAgentConnector);
