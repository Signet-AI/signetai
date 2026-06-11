#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { PiConnector } from "../dist/index.js";

runConnectorInstaller("pi", PiConnector);
