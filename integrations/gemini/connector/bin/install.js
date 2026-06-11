#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { GeminiConnector } from "../dist/index.js";

runConnectorInstaller("gemini", GeminiConnector);
