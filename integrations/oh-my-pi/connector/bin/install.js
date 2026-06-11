#!/usr/bin/env node
import { runConnectorInstaller } from "@signet/connector-base";
import { OhMyPiConnector } from "../dist/index.js";

runConnectorInstaller("oh-my-pi", OhMyPiConnector);
