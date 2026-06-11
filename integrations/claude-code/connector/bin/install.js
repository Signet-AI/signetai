#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { ClaudeCodeConnector } from "../dist/index.js";

runConnectorInstaller("claude-code", ClaudeCodeConnector);
