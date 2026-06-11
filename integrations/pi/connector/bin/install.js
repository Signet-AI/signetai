#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { PiConnector } from "../dist/index.js";

runConnectorInstaller("pi", PiConnector);
