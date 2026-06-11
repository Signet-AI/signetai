#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { OpenCodeConnector } from "../dist/index.js";

runConnectorInstaller("opencode", OpenCodeConnector);
