#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { MuseCodeConnector } from "../dist/index.js";

runConnectorInstaller("muse-code", MuseCodeConnector);
