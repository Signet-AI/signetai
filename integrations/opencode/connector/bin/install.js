#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { OpenCodeConnector } from "../dist/index.js";

runConnectorInstaller("opencode", OpenCodeConnector);
