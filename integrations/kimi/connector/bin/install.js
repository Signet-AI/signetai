#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { KimiConnector } from "../dist/index.js";

runConnectorInstaller("kimi", KimiConnector);
