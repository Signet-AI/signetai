#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { OpenClawConnector } from "../dist/index.js";

runConnectorInstaller("openclaw", OpenClawConnector);
