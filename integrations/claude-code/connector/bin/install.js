#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { ClaudeCodeConnector } from "../dist/index.js";

runConnectorInstaller("claude-code", ClaudeCodeConnector);
