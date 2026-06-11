#!/usr/bin/env node
import { runConnectorInstaller } from "@signetai/connector-base";
import { OhMyPiConnector } from "../dist/index.js";

runConnectorInstaller("oh-my-pi", OhMyPiConnector);
