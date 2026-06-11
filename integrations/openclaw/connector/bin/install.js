#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { OpenClawConnector } from "../dist/index.js";

runConnectorInstaller("openclaw", OpenClawConnector);
