#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { CodexConnector } from "../dist/index.js";

runConnectorInstaller("codex", CodexConnector);
