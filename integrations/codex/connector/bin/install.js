#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { CodexConnector } from "../dist/index.js";

runConnectorInstaller("codex", CodexConnector);
