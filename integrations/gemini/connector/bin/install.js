#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { GeminiConnector } from "../dist/index.js";

runConnectorInstaller("gemini", GeminiConnector);
